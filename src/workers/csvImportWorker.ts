const CHUNK = 2 * 1024 * 1024;
/**
 * CSV import: 3 passes — bounds, |ΔI| histogram (adaptive bucket edges + protected
 * jump times), then left-hold segments. Merges avoid crossing protected row times:
 * large |ΔI| steps and strict local maxima (plateaus higher than both neighbors),
 * until the segment budget forces a fallback.
 */
const NUM_BUCKETS = 499;
const MAX_SEG_PER_BUCKET = 16;
/** One keyframe per segment start + closing point at tMax (engine MAX_PROFILE_POINTS) */
const MAX_SEGMENTS = 1999;
const HIST_BINS = 8192;
/** Histogram mass: emphasize large jumps so bucket edges cluster on transients */
const HIST_QUAD_WEIGHT = 1;
const LARGE_JUMP_REL = 0.02;
const LARGE_JUMP_ABS_A = 1e-9;
/** Times where current steps by this relative or absolute amount are merge-protected */
const PROTECT_REL = 0.003;
const PROTECT_ABS_A = 1e-10;
const MAX_PROTECTED_JUMPS = 900;

type Pt = { time: number; current: number };
type Seg = { lo: number; hi: number; I: number };
type JumpEvt = { time: number; deltaA: number; fromA: number; toA: number };
type Prot = { t: number; dI: number };

let file: File;
let fileSize: number;
let offset: number;
let leftover: string;
let tIdx: number;
let cIdx: number;
let headerFound: boolean;

let phase: 1 | 2 | 3;
let rowCount: number;
let tMin: number;
let tMax: number;

let diHist: Float64Array;
let bucketEdges: Float64Array;
let histPrevT: number | null;
let histPrevI: number | null;
let largeJumpCount: number;
let topJumps: JumpEvt[];
let protectedPool: Prot[];

/** Constant-run tracker for strict local maxima (same I across consecutive rows) */
let platRunStartT: number | null;
let platRunI: number | null;
let platPrevI: number | null;

let protectedTimesSorted: Float64Array;
let boundaryTol: number;

let integral: Float64Array;
let bucketSegs: Seg[][];
let segPrevT: number | null;
let segPrevI: number | null;

self.onmessage = function (e: MessageEvent) {
  file = e.data;
  fileSize = file.size;
  phase = 1;
  offset = 0;
  leftover = '';
  tIdx = -1;
  cIdx = -1;
  headerFound = false;
  rowCount = 0;
  tMin = Infinity;
  tMax = -Infinity;
  segPrevT = null;
  segPrevI = null;
  histPrevT = null;
  histPrevI = null;
  processChunk();
};

function parseHeaderLine(line: string): boolean {
  if (!/time/i.test(line)) return false;
  const cols = line.split(',');
  tIdx = -1;
  cIdx = -1;
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
  return tIdx >= 0 && cIdx >= 0;
}

function recordJump(t: number, fromI: number, toI: number, dI: number) {
  if (topJumps.length < 24 || dI > topJumps[topJumps.length - 1].deltaA) {
    topJumps.push({ time: t, deltaA: dI, fromA: fromI, toA: toI });
    topJumps.sort((a, b) => b.deltaA - a.deltaA);
    if (topJumps.length > 24) topJumps.length = 24;
  }
}

/** Pool by priority weight (|ΔI| or peak prominence); lowest weights evicted when full. */
function addProtectedWeighted(t: number, weight: number) {
  if (!(weight > 1e-18)) return;
  if (protectedPool.length < MAX_PROTECTED_JUMPS) {
    protectedPool.push({ t, dI: weight });
    return;
  }
  let minI = 0;
  for (let i = 1; i < protectedPool.length; i++) {
    if (protectedPool[i].dI < protectedPool[minI].dI) minI = i;
  }
  if (weight > protectedPool[minI].dI) protectedPool[minI] = { t, dI: weight };
}

function considerProtectedJump(t: number, dI: number, mag: number) {
  if (dI < PROTECT_ABS_A && dI < PROTECT_REL * mag) return;
  addProtectedWeighted(t, dI);
}

/** When a constant-I run ends, if it was a strict local maximum protect rise/fall times. */
function onPlateauTransition(runStartT: number, runI: number, nextI: number, nextT: number, leftI: number | null) {
  if (leftI === null) {
    if (runI > nextI) {
      const w = runI - nextI;
      addProtectedWeighted(runStartT, w);
      addProtectedWeighted(nextT, w);
    }
  } else if (runI > leftI && runI > nextI) {
    const prom = Math.min(runI - leftI, runI - nextI);
    addProtectedWeighted(runStartT, prom);
    addProtectedWeighted(nextT, Math.abs(nextI - runI));
  }
}

function flushPlateauLocalMaxAtEOF() {
  if (platRunI === null || platRunStartT === null) return;
  if (platPrevI !== null && platRunI > platPrevI) {
    addProtectedWeighted(platRunStartT, platRunI - platPrevI);
  }
}

function finalizeProtectedTimes() {
  protectedPool.sort((a, b) => a.t - b.t);
  const uniq: number[] = [];
  const span = tMax - tMin;
  const eps = Math.max(1e-15 * (1 + Math.abs(tMin)), span * 1e-14);
  for (const p of protectedPool) {
    const last = uniq[uniq.length - 1];
    if (last !== undefined && Math.abs(p.t - last) < eps) continue;
    uniq.push(p.t);
  }
  protectedTimesSorted = new Float64Array(uniq);
  boundaryTol = Math.max(1e-12 * (1 + Math.abs(tMin)), span * 1e-13);
}

function isProtectedBoundary(t: number): boolean {
  const arr = protectedTimesSorted;
  const tol = boundaryTol;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo < arr.length && Math.abs(arr[lo] - t) <= tol) return true;
  if (lo > 0 && Math.abs(arr[lo - 1] - t) <= tol) return true;
  return false;
}

function buildBucketEdges(hist: Float64Array, tMin0: number, tMax0: number): Float64Array {
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

function baseMergeScore(a: Seg, c: Seg): number {
  const lenA = a.hi - a.lo;
  const lenB = c.hi - c.lo;
  const dI = Math.abs(a.I - c.I);
  const span = tMax - tMin;
  const minL = Math.min(lenA, lenB);
  const mag = Math.max(Math.abs(a.I), Math.abs(c.I), 1e-15);
  const rel = dI / mag;
  let score = dI + 1e-15 / (lenA + lenB + 1e-30);
  if (rel >= 0.03 && minL < span * 0.008) {
    score += (dI * minL) / (span * 1e-6 + minL * minL);
  }
  return score;
}

/** Internal boundary between a and c is c.lo (start of right segment). */
function mergeScorePair(a: Seg, c: Seg, respectProtected: boolean): number {
  const bnd = c.lo;
  if (respectProtected && isProtectedBoundary(bnd)) return Number.POSITIVE_INFINITY;
  return baseMergeScore(a, c);
}

function addSegment(segLo: number, segHi: number, I: number) {
  if (!(segHi > segLo)) return;
  const span = tMax - tMin;
  if (!(span > 0) || !bucketEdges) return;
  for (let b = 0; b < NUM_BUCKETS; b++) {
    const L = bucketEdges[b];
    const R = bucketEdges[b + 1];
    const lo = Math.max(segLo, L);
    const hi = Math.min(segHi, R);
    if (hi > lo) {
      integral[b] += I * (hi - lo);
      pushBucketSeg(b, lo, hi, I);
    }
  }
}

function pushBucketSeg(b: number, lo: number, hi: number, I: number) {
  const arr = bucketSegs[b];
  const last = arr[arr.length - 1];
  if (last && last.I === I && last.hi <= lo + 1e-15 * (1 + Math.abs(lo))) {
    if (hi > last.hi) last.hi = hi;
  } else {
    arr.push({ lo, hi, I });
  }
  simplifyBucket(b);
}

function simplifyBucket(b: number) {
  const arr = bucketSegs[b];
  while (arr.length > MAX_SEG_PER_BUCKET) {
    let bi = 0;
    let best = Infinity;
    for (let i = 0; i < arr.length - 1; i++) {
      const sc = mergeScorePair(arr[i], arr[i + 1], true);
      if (sc < best) {
        best = sc;
        bi = i;
      }
    }
    if (!Number.isFinite(best)) {
      best = Infinity;
      for (let i = 0; i < arr.length - 1; i++) {
        const sc = baseMergeScore(arr[i], arr[i + 1]);
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

function mergeSegPair(a: Seg, c: Seg): Seg {
  const lenA = a.hi - a.lo;
  const lenB = c.hi - c.lo;
  const I = (a.I * lenA + c.I * lenB) / (lenA + lenB);
  return { lo: a.lo, hi: c.hi, I };
}

function stitchSegs(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
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

function simplifyGlobal(segs: Seg[]): Seg[] {
  let s = stitchSegs(segs);
  while (s.length > MAX_SEGMENTS) {
    let bi = 0;
    let best = Infinity;
    for (let i = 0; i < s.length - 1; i++) {
      const sc = mergeScorePair(s[i], s[i + 1], true);
      if (sc < best) {
        best = sc;
        bi = i;
      }
    }
    if (!Number.isFinite(best)) {
      best = Infinity;
      for (let i = 0; i < s.length - 1; i++) {
        const sc = baseMergeScore(s[i], s[i + 1]);
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

function progressPct(): number {
  const f = offset / fileSize;
  if (phase === 1) return Math.round(33 * f);
  if (phase === 2) return 33 + Math.round(17 * f);
  return 50 + Math.round(50 * f);
}

function processChunk() {
  const end = Math.min(offset + CHUNK, fileSize);
  const slice = file.slice(offset, end);
  const reader = new (globalThis as unknown as { FileReaderSync: new () => { readAsText(b: Blob): string } }).FileReaderSync();
  let text = leftover + reader.readAsText(slice);
  offset = end;

  const lastNl = text.lastIndexOf('\n');
  if (offset < fileSize && lastNl >= 0) {
    leftover = text.substring(lastNl + 1);
    text = text.substring(0, lastNl);
  } else {
    leftover = '';
  }

  const lines = text.split('\n');
  const span = tMax - tMin;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].replace(/\r$/, '');
    if (!line) continue;

    if (!headerFound) {
      if (parseHeaderLine(line)) {
        headerFound = true;
      }
      continue;
    }

    const parts = line.split(',');
    const time = Number(parts[tIdx]);
    const current = Number(parts[cIdx]);
    if (time !== time || current !== current) continue;

    if (phase === 1) {
      rowCount++;
      if (time < tMin) tMin = time;
      if (time > tMax) tMax = time;
    } else if (phase === 2 && span > 0) {
      if (platRunI === null) {
        platRunStartT = time;
        platRunI = current;
        platPrevI = null;
      } else if (current === platRunI) {
        /* extend same-I plateau */
      } else {
        onPlateauTransition(platRunStartT, platRunI, current, time, platPrevI);
        platPrevI = platRunI;
        platRunStartT = time;
        platRunI = current;
      }

      if (histPrevT !== null) {
        const dI = Math.abs(current - histPrevI);
        const mag = Math.max(Math.abs(current), Math.abs(histPrevI), 1e-15);
        const bi = Math.min(HIST_BINS - 1, Math.max(0, Math.floor(((time - tMin) / span) * HIST_BINS)));
        const mass = dI + (HIST_QUAD_WEIGHT * dI * dI) / (mag + 1e-15);
        diHist[bi] += mass;
        if (dI >= LARGE_JUMP_ABS_A) {
          recordJump(time, histPrevI, current, dI);
        }
        if (dI >= LARGE_JUMP_ABS_A && dI >= LARGE_JUMP_REL * mag) {
          largeJumpCount++;
        }
        considerProtectedJump(time, dI, mag);
      }
      histPrevT = time;
      histPrevI = current;
    } else if (phase === 3) {
      if (segPrevT === null) {
        segPrevT = time;
        segPrevI = current;
      } else {
        addSegment(segPrevT, time, segPrevI);
        segPrevT = time;
        segPrevI = current;
      }
    }
  }

  const estRows = Math.max(1, Math.round(fileSize / 28));
  self.postMessage({
    progress: true,
    rows: rowCount,
    estRows,
    pct: progressPct(),
  });

  if (offset < fileSize) {
    setTimeout(processChunk, 0);
  } else if (phase === 1) {
    if (!headerFound || tIdx < 0 || cIdx < 0 || rowCount === 0 || !(tMax >= tMin)) {
      self.postMessage({ error: 'columns' });
      return;
    }
    phase = 2;
    offset = 0;
    leftover = '';
    headerFound = false;
    diHist = new Float64Array(HIST_BINS);
    histPrevT = null;
    histPrevI = null;
    largeJumpCount = 0;
    topJumps = [];
    protectedPool = [];
    platRunStartT = null;
    platRunI = null;
    platPrevI = null;
    processChunk();
  } else if (phase === 2) {
    flushPlateauLocalMaxAtEOF();
    finalizeProtectedTimes();
    bucketEdges = buildBucketEdges(diHist, tMin, tMax);
    phase = 3;
    offset = 0;
    leftover = '';
    headerFound = false;
    integral = new Float64Array(NUM_BUCKETS);
    bucketSegs = Array.from({ length: NUM_BUCKETS }, () => []);
    segPrevT = null;
    segPrevI = null;
    processChunk();
  } else {
    finishFromBuckets();
  }
}

function finishFromBuckets() {
  const span = tMax - tMin;
  if (!(span > 0) || !bucketEdges) {
    self.postMessage({ done: true, points: [], rowCount, compressedBeforeCap: 0, capped: false });
    return;
  }

  let totalDeltaIMass = 0;
  for (let i = 0; i < HIST_BINS; i++) totalDeltaIMass += diHist[i];
  const importStats = {
    adaptiveTimeBuckets: totalDeltaIMass > 1e-30,
    histBins: HIST_BINS,
    bucketCount: NUM_BUCKETS,
    totalHistMass: totalDeltaIMass,
    maxDeltaA: topJumps.length ? topJumps[0].deltaA : 0,
    largeJumpThreshold: { rel: LARGE_JUMP_REL, absA: LARGE_JUMP_ABS_A },
    largeJumpCount,
    mergeProtect: { rel: PROTECT_REL, absA: PROTECT_ABS_A, maxKept: MAX_PROTECTED_JUMPS, applied: protectedTimesSorted.length },
    topJumpsByDeltaA: topJumps.slice(0, 8),
  };

  const flat: Seg[] = [];
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

  const stitchedBeforeCap = stitchSegs(flat);
  const capped = stitchedBeforeCap.length > MAX_SEGMENTS;
  const segs = simplifyGlobal(flat);

  const dedup: Pt[] = [];
  for (const s of segs) {
    const prev = dedup[dedup.length - 1];
    if (prev && Math.abs(prev.time - s.lo) < 1e-12 * (1 + Math.abs(s.lo)) && prev.current === s.I) continue;
    dedup.push({ time: s.lo, current: s.I });
  }

  if (dedup.length === 0) {
    self.postMessage({
      done: true,
      points: [],
      rowCount,
      compressedBeforeCap: 0,
      capped: false,
      importStats,
    });
    return;
  }

  const i0 = dedup[0].current;
  dedup.push({ time: tMax, current: i0 });

  self.postMessage({
    done: true,
    points: dedup,
    rowCount,
    compressedBeforeCap: rowCount,
    capped,
    importStats,
  });
}
