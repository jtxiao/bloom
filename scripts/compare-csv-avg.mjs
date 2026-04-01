#!/usr/bin/env node
/**
 * Compare raw CSV vs csvImportWorker (adaptive hist + protected merge boundaries).
 *
 * Usage:
 *   node scripts/compare-csv-avg.mjs [path/to.csv]
 *   node scripts/compare-csv-avg.mjs --peaks [path]   # strict local-max plateau check; exit 1 if any miss
 */
import fs from 'fs';
import readline from 'readline';

const argv = process.argv.slice(2);
const PEAK_AUDIT = argv.includes('--peaks') || argv.includes('--audit-peaks');
const pathArg = argv.find((a) => !a.startsWith('--'));
const PATH = pathArg || `${process.env.HOME}/Downloads/power_analaysis.csv`;
const NUM_BUCKETS = 499;
const MAX_SEG_PER_BUCKET = 16;
const MAX_SEGMENTS = 1999;
const HIST_BINS = 8192;
const HIST_QUAD_WEIGHT = 1;
const PROTECT_REL = 0.003;
const PROTECT_ABS_A = 1e-10;
const MAX_PROTECTED_JUMPS = 900;

function parseHeaderLine(line) {
  if (!/time/i.test(line)) return null;
  const cols = line.split(',');
  let tIdx = -1;
  let cIdx = -1;
  for (let j = 0; j < cols.length; j++) {
    const h = cols[j].trim();
    if (tIdx < 0 && /\btime\b/i.test(h)) tIdx = j;
    if (cIdx < 0 && /\bcurrent\b/i.test(h)) cIdx = j;
  }
  if (cIdx < 0) {
    for (let j2 = 0; j2 < cols.length; j2++) {
      if (/^i$/i.test(cols[j2].trim())) {
        cIdx = j2;
        break;
      }
    }
  }
  if (tIdx < 0 && cIdx < 0 && cols.length === 2) {
    tIdx = 0;
    cIdx = 1;
  }
  return tIdx >= 0 && cIdx >= 0 ? { tIdx, cIdx } : null;
}

function getCurrentAtTime(sorted, t) {
  const period = sorted[sorted.length - 1].time;
  const tt = period > 0 ? t % period : t;
  let lo = 0;
  let hi = sorted.length - 1;
  if (sorted[0].time > tt) return sorted[sorted.length - 1].current;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sorted[mid].time <= tt) lo = mid;
    else hi = mid - 1;
  }
  return sorted[lo].current;
}

function avgOverTimeline(sorted, times) {
  let sum = 0;
  const T = times[times.length - 1] - times[0];
  if (T <= 0) return 0;
  for (let i = 0; i < times.length - 1; i++) {
    const dt = times[i + 1] - times[i];
    sum += getCurrentAtTime(sorted, times[i]) * dt;
  }
  return sum / T;
}

/**
 * Strict local max plateaus (same as worker). Each entry includes `prominence`
 * (min vertical drop to left/right neighbor) for filtering noise.
 */
function extractStrictLocalMaxPlateaus(rows) {
  if (rows.length < 2) return [];
  let runStart = rows[0].t;
  let runI = rows[0].c;
  let prevI = null;
  const peaks = [];
  for (let k = 1; k < rows.length; k++) {
    const { t, c } = rows[k];
    if (c === runI) continue;
    const runEnd = t;
    if (prevI === null) {
      if (runI > c) {
        peaks.push({
          tStart: runStart,
          tEnd: runEnd,
          peakI: runI,
          kind: 'leading',
          prominenceA: runI - c,
        });
      }
    } else if (runI > prevI && runI > c) {
      peaks.push({
        tStart: runStart,
        tEnd: runEnd,
        peakI: runI,
        kind: 'interior',
        prominenceA: Math.min(runI - prevI, runI - c),
      });
    }
    prevI = runI;
    runStart = t;
    runI = c;
  }
  const lastT = rows[rows.length - 1].t;
  if (prevI !== null && runI > prevI) {
    peaks.push({
      tStart: runStart,
      tEnd: lastT,
      peakI: runI,
      kind: 'terminal',
      prominenceA: runI - prevI,
    });
  }
  return peaks;
}

/** Report block: plateaus above this prominence vs neighbors (filters UI noise). */
const AUDIT_MIN_PROMINENCE_ABS_A = 1e-6;
const AUDIT_MIN_PROMINENCE_REL = 0.02;

function isReportablePeak(p) {
  const floor = Math.max(
    AUDIT_MIN_PROMINENCE_ABS_A,
    AUDIT_MIN_PROMINENCE_REL * Math.abs(p.peakI),
  );
  return p.prominenceA >= floor;
}

const AUDIT_TOP_K = 100;

function maxModelCurrentOnPlateau(dedup, tStart, tEnd, tMin0, tMax0) {
  if (dedup.length === 0) return -Infinity;
  const span = tMax0 - tMin0;
  const eps = Math.max(1e-15 * (1 + Math.abs(tStart)), span * 1e-11);
  if (!(tEnd > tStart)) {
    return getCurrentAtTime(dedup, tStart);
  }
  if (tEnd - tStart <= 2 * eps) {
    return getCurrentAtTime(dedup, (tStart + tEnd) / 2);
  }
  let m = -Infinity;
  const n = 800;
  for (let i = 1; i < n; i++) {
    const u = tStart + eps + ((tEnd - tStart - 2 * eps) * i) / n;
    const v = getCurrentAtTime(dedup, u);
    if (v > m) m = v;
  }
  return m;
}

function toleranceForPeak(peakI) {
  return Math.max(1e-12, 1e-6 * Math.abs(peakI));
}

function addProtectedWeighted(pool, t, weight) {
  if (!(weight > 1e-18)) return;
  if (pool.length < MAX_PROTECTED_JUMPS) {
    pool.push({ t, dI: weight });
    return;
  }
  let minI = 0;
  for (let i = 1; i < pool.length; i++) {
    if (pool[i].dI < pool[minI].dI) minI = i;
  }
  if (weight > pool[minI].dI) pool[minI] = { t, dI: weight };
}

function considerProtectedJump(pool, t, dI, mag) {
  if (dI < PROTECT_ABS_A && dI < PROTECT_REL * mag) return;
  addProtectedWeighted(pool, t, dI);
}

function onPlateauTransition(pool, runStartT, runI, nextI, nextT, leftI) {
  if (leftI === null) {
    if (runI > nextI) {
      const w = runI - nextI;
      addProtectedWeighted(pool, runStartT, w);
      addProtectedWeighted(pool, nextT, w);
    }
  } else if (runI > leftI && runI > nextI) {
    const prom = Math.min(runI - leftI, runI - nextI);
    addProtectedWeighted(pool, runStartT, prom);
    addProtectedWeighted(pool, nextT, Math.abs(nextI - runI));
  }
}

function flushPlateauLocalMaxAtEOF(pool, platRunStartT, platRunI, platPrevI) {
  if (platRunI === null || platRunStartT === null) return;
  if (platPrevI !== null && platRunI > platPrevI) {
    addProtectedWeighted(pool, platRunStartT, platRunI - platPrevI);
  }
}

function finalizeProtectedTimes(pool, tMin0, tMax0) {
  pool.sort((a, b) => a.t - b.t);
  const span = tMax0 - tMin0;
  const eps = Math.max(1e-15 * (1 + Math.abs(tMin0)), span * 1e-14);
  const uniq = [];
  for (const p of pool) {
    const last = uniq[uniq.length - 1];
    if (last !== undefined && Math.abs(p.t - last) < eps) continue;
    uniq.push(p.t);
  }
  const arr = new Float64Array(uniq);
  const boundaryTol = Math.max(1e-12 * (1 + Math.abs(tMin0)), span * 1e-13);
  return { arr, boundaryTol };
}

function isProtectedBoundary(t, arr, boundaryTol) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo < arr.length && Math.abs(arr[lo] - t) <= boundaryTol) return true;
  if (lo > 0 && Math.abs(arr[lo - 1] - t) <= boundaryTol) return true;
  return false;
}

function buildBucketEdges(hist, tMin0, tMax0) {
  const M = hist.length;
  const span = tMax0 - tMin0;
  const prefix = new Float64Array(M + 1);
  for (let i = 0; i < M; i++) prefix[i + 1] = prefix[i] + hist[i];
  const total = prefix[M];
  const edges = new Float64Array(NUM_BUCKETS + 1);
  edges[0] = tMin0;
  edges[NUM_BUCKETS] = tMax0;
  const cell = span / M;
  if (!(total > 1e-30)) {
    for (let b = 1; b < NUM_BUCKETS; b++) edges[b] = tMin0 + (b * span) / NUM_BUCKETS;
    return edges;
  }
  let iBin = 0;
  for (let b = 1; b < NUM_BUCKETS; b++) {
    const target = (total * b) / NUM_BUCKETS;
    while (iBin < M && prefix[iBin + 1] < target) iBin++;
    if (iBin >= M) {
      edges[b] = tMax0;
      continue;
    }
    const h = hist[iBin];
    const before = prefix[iBin];
    const frac = h > 1e-30 ? (target - before) / h : 0;
    const f = Math.max(0, Math.min(1, frac));
    edges[b] = tMin0 + (iBin + f) * cell;
  }
  for (let b = 1; b <= NUM_BUCKETS; b++) {
    if (edges[b] <= edges[b - 1]) {
      edges[b] = edges[b - 1] + 1e-12 * (1 + Math.abs(edges[b - 1]));
    }
  }
  edges[NUM_BUCKETS] = tMax0;
  return edges;
}

function baseMergeScore(a, c, tMin0, tMax0) {
  const lenA = a.hi - a.lo;
  const lenB = c.hi - c.lo;
  const dI = Math.abs(a.I - c.I);
  const span = tMax0 - tMin0;
  const minL = Math.min(lenA, lenB);
  const mag = Math.max(Math.abs(a.I), Math.abs(c.I), 1e-15);
  const rel = dI / mag;
  let score = dI + 1e-15 / (lenA + lenB + 1e-30);
  if (rel >= 0.03 && minL < span * 0.008) {
    score += (dI * minL) / (span * 1e-6 + minL * minL);
  }
  return score;
}

function mergeScorePair(a, c, tMin0, tMax0, protArr, protTol, respect) {
  if (respect && isProtectedBoundary(c.lo, protArr, protTol)) return Number.POSITIVE_INFINITY;
  return baseMergeScore(a, c, tMin0, tMax0);
}

function pushBucketSeg(bucketSegs, b, lo, hi, I, tMin0, tMax0, protArr, protTol) {
  const arr = bucketSegs[b];
  const last = arr[arr.length - 1];
  if (last && last.I === I && last.hi <= lo + 1e-15 * (1 + Math.abs(lo))) {
    if (hi > last.hi) last.hi = hi;
  } else {
    arr.push({ lo, hi, I });
  }
  simplifyBucket(arr, tMin0, tMax0, protArr, protTol);
}

function simplifyBucket(arr, tMin0, tMax0, protArr, protTol) {
  while (arr.length > MAX_SEG_PER_BUCKET) {
    let bi = 0;
    let best = Infinity;
    for (let i = 0; i < arr.length - 1; i++) {
      const sc = mergeScorePair(arr[i], arr[i + 1], tMin0, tMax0, protArr, protTol, true);
      if (sc < best) {
        best = sc;
        bi = i;
      }
    }
    if (!Number.isFinite(best)) {
      best = Infinity;
      for (let i = 0; i < arr.length - 1; i++) {
        const sc = baseMergeScore(arr[i], arr[i + 1], tMin0, tMax0);
        if (sc < best) {
          best = sc;
          bi = i;
        }
      }
    }
    const a = arr[bi];
    const c = arr[bi + 1];
    const lenA = a.hi - a.lo;
    const lenB = c.hi - c.lo;
    const I = (a.I * lenA + c.I * lenB) / (lenA + lenB);
    arr.splice(bi, 2, { lo: a.lo, hi: c.hi, I });
  }
}

function mergeSegPair(a, c) {
  const lenA = a.hi - a.lo;
  const lenB = c.hi - c.lo;
  const I = (a.I * lenA + c.I * lenB) / (lenA + lenB);
  return { lo: a.lo, hi: c.hi, I };
}

function stitchSegs(segs) {
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.I === s.I && s.lo <= last.hi + 1e-12 * (1 + Math.abs(s.lo))) {
      if (s.hi > last.hi) last.hi = s.hi;
    } else {
      out.push({ lo: s.lo, hi: s.hi, I: s.I });
    }
  }
  return out;
}

function simplifyGlobal(segs, tMin0, tMax0, protArr, protTol) {
  let s = stitchSegs(segs);
  while (s.length > MAX_SEGMENTS) {
    let bi = 0;
    let best = Infinity;
    for (let i = 0; i < s.length - 1; i++) {
      const sc = mergeScorePair(s[i], s[i + 1], tMin0, tMax0, protArr, protTol, true);
      if (sc < best) {
        best = sc;
        bi = i;
      }
    }
    if (!Number.isFinite(best)) {
      best = Infinity;
      for (let i = 0; i < s.length - 1; i++) {
        const sc = baseMergeScore(s[i], s[i + 1], tMin0, tMax0);
        if (sc < best) {
          best = sc;
          bi = i;
        }
      }
    }
    s.splice(bi, 2, mergeSegPair(s[bi], s[bi + 1]));
  }
  return s;
}

function addSegment(integral, bucketSegs, bucketEdges, tMin0, tMax0, protArr, protTol, segLo, segHi, I) {
  if (!(segHi > segLo)) return;
  const span = tMax0 - tMin0;
  if (!(span > 0) || !bucketEdges) return;
  for (let b = 0; b < NUM_BUCKETS; b++) {
    const L = bucketEdges[b];
    const R = bucketEdges[b + 1];
    const lo = Math.max(segLo, L);
    const hi = Math.min(segHi, R);
    if (hi > lo) {
      integral[b] += I * (hi - lo);
      pushBucketSeg(bucketSegs, b, lo, hi, I, tMin0, tMax0, protArr, protTol);
    }
  }
}

function profileFromBuckets(integral, bucketSegs, bucketEdges, tMin0, tMax0, protArr, protTol) {
  const span = tMax0 - tMin0;
  if (!(span > 0) || !bucketEdges) return [];
  const flat = [];
  for (let b = 0; b < NUM_BUCKETS; b++) {
    const L = bucketEdges[b];
    const R = bucketEdges[b + 1];
    const wBucket = R - L;
    const arr = bucketSegs[b];
    if (arr.length === 0) {
      const iMean = wBucket > 0 ? integral[b] / wBucket : 0;
      flat.push({ lo: L, hi: R, I: iMean });
    } else {
      for (const s of arr) flat.push({ lo: s.lo, hi: s.hi, I: s.I });
    }
  }
  const segs = simplifyGlobal(flat, tMin0, tMax0, protArr, protTol);
  const dedup = [];
  for (const s of segs) {
    const prev = dedup[dedup.length - 1];
    if (prev && Math.abs(prev.time - s.lo) < 1e-12 * (1 + Math.abs(s.lo)) && prev.current === s.I) continue;
    dedup.push({ time: s.lo, current: s.I });
  }
  if (dedup.length === 0) return [];
  dedup.push({ time: tMax0, current: dedup[0].current });
  return dedup;
}

async function readCsvRows(path) {
  const rl = readline.createInterface({
    input: fs.createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let headerFound = false;
  let tIdx = -1;
  let cIdx = -1;
  const rows = [];
  for await (const line of rl) {
    const ln = line.replace(/\r$/, '');
    if (!ln) continue;
    if (!headerFound) {
      const h = parseHeaderLine(ln);
      if (h) {
        tIdx = h.tIdx;
        cIdx = h.cIdx;
        headerFound = true;
      }
      continue;
    }
    const parts = ln.split(',');
    const t = Number(parts[tIdx]);
    const c = Number(parts[cIdx]);
    if (t !== t || c !== c) continue;
    rows.push({ t, c });
  }
  rl.close();
  return { rows, tIdx, cIdx };
}

async function main() {
  const { rows } = await readCsvRows(PATH);
  if (rows.length === 0) {
    console.log(JSON.stringify({ error: 'no rows', path: PATH }, null, 2));
    return;
  }

  let tMin = Infinity;
  let tMax = -Infinity;
  for (const { t } of rows) {
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  const span = tMax - tMin;

  let rawIntegral = 0;
  let prevT = null;
  let prevI = null;
  for (const { t, c } of rows) {
    if (prevT !== null) {
      const dt = t - prevT;
      if (dt > 0) rawIntegral += prevI * dt;
    }
    prevT = t;
    prevI = c;
  }

  const diHist = new Float64Array(HIST_BINS);
  const protectedPool = [];
  let hpT = null;
  let hpI = null;
  let platRunStartT = null;
  let platRunI = null;
  let platPrevI = null;
  for (const { t, c } of rows) {
    if (platRunI === null) {
      platRunStartT = t;
      platRunI = c;
      platPrevI = null;
    } else if (c === platRunI) {
      /* same plateau */
    } else {
      onPlateauTransition(protectedPool, platRunStartT, platRunI, c, t, platPrevI);
      platPrevI = platRunI;
      platRunStartT = t;
      platRunI = c;
    }

    if (hpT !== null && span > 0) {
      const dI = Math.abs(c - hpI);
      const mag = Math.max(Math.abs(c), Math.abs(hpI), 1e-15);
      const bi = Math.min(HIST_BINS - 1, Math.max(0, Math.floor(((t - tMin) / span) * HIST_BINS)));
      diHist[bi] += dI + (HIST_QUAD_WEIGHT * dI * dI) / (mag + 1e-15);
      considerProtectedJump(protectedPool, t, dI, mag);
    }
    hpT = t;
    hpI = c;
  }

  flushPlateauLocalMaxAtEOF(protectedPool, platRunStartT, platRunI, platPrevI);
  const { arr: protArr, boundaryTol: protTol } = finalizeProtectedTimes(protectedPool, tMin, tMax);
  const bucketEdges = buildBucketEdges(diHist, tMin, tMax);
  let totalHistMass = 0;
  for (let i = 0; i < HIST_BINS; i++) totalHistMass += diHist[i];

  const integral = new Float64Array(NUM_BUCKETS);
  const bucketSegs = Array.from({ length: NUM_BUCKETS }, () => []);
  let segPrevT = null;
  let segPrevI = null;
  let rawSegMax = -Infinity;
  for (const { t, c } of rows) {
    if (segPrevT === null) {
      segPrevT = t;
      segPrevI = c;
    } else {
      const dt = t - segPrevT;
      if (dt > 0) rawSegMax = Math.max(rawSegMax, segPrevI);
      addSegment(integral, bucketSegs, bucketEdges, tMin, tMax, protArr, protTol, segPrevT, t, segPrevI);
      segPrevT = t;
      segPrevI = c;
    }
  }
  if (segPrevT !== null && tMax > segPrevT) {
    rawSegMax = Math.max(rawSegMax, segPrevI);
  }

  const dedup = profileFromBuckets(integral, bucketSegs, bucketEdges, tMin, tMax, protArr, protTol);

  const T = tMax - tMin;
  const rawAvg = T > 0 ? rawIntegral / T : 0;

  const NSTEP = 2000;
  const times = [];
  for (let i = 0; i <= NSTEP; i++) times.push(tMin + (i / NSTEP) * T);
  const modelAvg = dedup.length ? avgOverTimeline(dedup, times) : 0;

  let peakAudit = null;
  if (PEAK_AUDIT) {
    const plateaus = extractStrictLocalMaxPlateaus(rows);
    const reportable = plateaus.filter(isReportablePeak);

    const rawM = rawSegMax === -Infinity ? null : rawSegMax;
    const modelM = dedup.length ? Math.max(...dedup.map((p) => p.current)) : null;
    const gmTol = Math.max(1e-12, 1e-6 * Math.abs(rawM ?? 0));
    const globalPeakOk =
      rawM !== null &&
      modelM !== null &&
      modelM >= rawM - gmTol &&
      modelM <= rawM + gmTol;

    const byProm = [...plateaus].sort((a, b) => b.prominenceA - a.prominenceA);
    const topK = byProm.slice(0, Math.min(AUDIT_TOP_K, byProm.length));
    const topFailures = [];
    const topPassed = [];
    for (const p of topK) {
      const mm = maxModelCurrentOnPlateau(dedup, p.tStart, p.tEnd, tMin, tMax);
      const tol = toleranceForPeak(p.peakI);
      if (mm + tol < p.peakI) {
        topFailures.push({
          ...p,
          modelMaxOnPlateauA: mm,
          deficitA: p.peakI - mm,
          toleranceA: tol,
        });
      } else {
        topPassed.push({ ...p, modelMaxOnPlateauA: mm });
      }
    }

    let reportableFailed = 0;
    for (const p of reportable) {
      const mm = maxModelCurrentOnPlateau(dedup, p.tStart, p.tEnd, tMin, tMax);
      if (mm + toleranceForPeak(p.peakI) < p.peakI) reportableFailed++;
    }

    peakAudit = {
      description:
        'Exit code: global max current must match, and every plateau in the top 100 by prominence must reproduce peakI on-canvas. (Millions of tiny strict maxima in raw CSV are summarized only.)',
      totalStrictLocalMaxPlateaus: plateaus.length,
      reportablePlateauCount: reportable.length,
      reportableUndershootCount: reportableFailed,
      reportableRule: {
        minProminenceAbsA: AUDIT_MIN_PROMINENCE_ABS_A,
        minProminenceRelOfPeak: AUDIT_MIN_PROMINENCE_REL,
      },
      globalPeak: {
        rawMaxSegmentA: rawM,
        modelMaxKeyframeA: modelM,
        toleranceA: gmTol,
        ok: globalPeakOk,
      },
      topByProminence: {
        k: topK.length,
        passed: topPassed.length,
        failed: topFailures.length,
        failures: topFailures.slice(0, 25),
      },
    };
  }

  console.log(JSON.stringify({
    path: PATH,
    samples: rows.length,
    tMin,
    tMax,
    span: T,
    totalHistMass,
    protectedBoundaries: protArr.length,
    rawTimeWeightedAvgA: rawAvg,
    decimatedPoints: dedup.length,
    modelAvgFromDecimatedProfileA: modelAvg,
    deltaA: modelAvg - rawAvg,
    relErrorPercent: T > 0 && Math.abs(rawAvg) > 1e-15
      ? ((modelAvg - rawAvg) / rawAvg) * 100
      : null,
    rawMaxSegmentCurrentA: rawSegMax === -Infinity ? null : rawSegMax,
    modelMaxKeyframeCurrentA: dedup.length ? Math.max(...dedup.map(p => p.current)) : null,
    ...(peakAudit ? { peakAudit } : {}),
  }, null, 2));

  if (PEAK_AUDIT) {
    const g = peakAudit.globalPeak;
    const t = peakAudit.topByProminence;
    if (!g.ok || t.failed > 0) {
      console.error(
        `\npeak audit FAILED: globalPeakOk=${g.ok} top${t.k}ByProminence failed=${t.failed}/${t.k} (file has ${peakAudit.totalStrictLocalMaxPlateaus} strict local maxima; ${peakAudit.reportableUndershootCount}/${peakAudit.reportablePlateauCount} “reportable” undershoot)`,
      );
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
