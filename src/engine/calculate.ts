import type { Node, Edge } from '@xyflow/react';
import type {
  PowerNodeData,
  PowerSourceData,
  PowerConverterData,
  LoadData,
  SeriesElementData,
  EfficiencyPoint,
  EfficiencyCurveSet,
  AuxLoad,
  AnalysisResult,
  ScenarioResult,
  StateResult,
  TimeSeriesPoint,
  LoadProfilePoint,
  VoltageScenario,
  ScenarioTimeSeries,
  DischargeCurvePoint,
  DischargeCurveAtTemp,
  CapacityAtTemp,
  BatteryTimeSeriesPoint,
  PowerState,
  Diagnostic,
} from '../types';

function interpolateEfficiency(curve: EfficiencyPoint[], loadCurrent: number): number {
  if (curve.length === 0) return 1;
  if (curve.length === 1) return curve[0].efficiency;
  const sorted = [...curve].sort((a, b) => a.loadCurrent - b.loadCurrent);
  if (loadCurrent <= sorted[0].loadCurrent) return sorted[0].efficiency;
  if (loadCurrent >= sorted[sorted.length - 1].loadCurrent) return sorted[sorted.length - 1].efficiency;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (loadCurrent >= sorted[i].loadCurrent && loadCurrent <= sorted[i + 1].loadCurrent) {
      const t = (loadCurrent - sorted[i].loadCurrent) / (sorted[i + 1].loadCurrent - sorted[i].loadCurrent);
      return sorted[i].efficiency + t * (sorted[i + 1].efficiency - sorted[i].efficiency);
    }
  }
  return sorted[sorted.length - 1].efficiency;
}

function getEfficiencyForVin(curves: EfficiencyCurveSet[], inputVoltage: number, loadCurrent: number): number {
  if (curves.length === 0) return 1;
  if (curves.length === 1) return interpolateEfficiency(curves[0].points, loadCurrent);
  const sorted = [...curves].sort((a, b) => a.inputVoltage - b.inputVoltage);
  if (inputVoltage <= sorted[0].inputVoltage) return interpolateEfficiency(sorted[0].points, loadCurrent);
  if (inputVoltage >= sorted[sorted.length - 1].inputVoltage) return interpolateEfficiency(sorted[sorted.length - 1].points, loadCurrent);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (inputVoltage >= sorted[i].inputVoltage && inputVoltage <= sorted[i + 1].inputVoltage) {
      const effLow = interpolateEfficiency(sorted[i].points, loadCurrent);
      const effHigh = interpolateEfficiency(sorted[i + 1].points, loadCurrent);
      const t = (inputVoltage - sorted[i].inputVoltage) / (sorted[i + 1].inputVoltage - sorted[i].inputVoltage);
      return effLow + t * (effHigh - effLow);
    }
  }
  return interpolateEfficiency(sorted[sorted.length - 1].points, loadCurrent);
}

function getConverterEfficiency(cd: PowerConverterData, inputVoltage: number, outputCurrent: number): number {
  if (cd.converterType === 'ldo') {
    if (inputVoltage <= 0) return 1;
    return Math.min(1, cd.outputVoltage / inputVoltage);
  }
  const mode = cd.efficiencyMode ?? (cd.efficiencyCurves?.length ? 'curve' : 'flat');
  if (mode === 'flat') {
    return cd.flatEfficiency ?? 0.85;
  }
  return getEfficiencyForVin(cd.efficiencyCurves, inputVoltage, outputCurrent);
}

function getLdoActualOutputVoltage(cd: PowerConverterData, inputVoltage: number): number {
  return Math.min(cd.outputVoltage, inputVoltage);
}

function converterInputCurrent(cd: PowerConverterData, inputVoltage: number, totalOutputPower: number): number {
  if (inputVoltage <= 0) return 0;
  const iq = cd.quiescentCurrent || 0;
  if (cd.converterType === 'ldo') {
    const actualVout = getLdoActualOutputVoltage(cd, inputVoltage);
    return actualVout > 0 ? totalOutputPower / actualVout + iq : iq;
  }
  const outputCurrent = totalOutputPower / (cd.outputVoltage || 1);
  const eff = getConverterEfficiency(cd, inputVoltage, outputCurrent);
  return totalOutputPower / (eff * inputVoltage) + iq;
}

function converterInputPower(cd: PowerConverterData, inputVoltage: number, totalOutputPower: number): number {
  return converterInputCurrent(cd, inputVoltage, totalOutputPower) * inputVoltage;
}

function getChildren(nodeId: string, edges: Edge[]): string[] {
  return edges.filter(e => e.source === nodeId).map(e => e.target);
}

function getParent(nodeId: string, edges: Edge[]): string | null {
  const edge = edges.find(e => e.target === nodeId);
  return edge ? edge.source : null;
}

function resolveInputVoltage(
  nodeId: string,
  nodes: Map<string, Node>,
  edges: Edge[],
  sourceVoltages: Map<string, number>
): number {
  const parentId = getParent(nodeId, edges);
  if (!parentId) return 0;
  const parentNode = nodes.get(parentId);
  if (!parentNode) return 0;
  const parentData = parentNode.data as unknown as PowerNodeData;

  if (parentData.type === 'source') {
    return sourceVoltages.get(parentId) ?? (parentData as PowerSourceData).nominalVoltage;
  }
  if (parentData.type === 'converter') {
    const cd = parentData as PowerConverterData;
    if (cd.enabled === false) return 0;
    const parentInputV = resolveInputVoltage(parentId, nodes, edges, sourceVoltages);
    if (parentInputV <= 0) return 0;
    if (cd.converterType === 'ldo') return Math.min(cd.outputVoltage, parentInputV);
    return cd.outputVoltage;
  }
  if (parentData.type === 'series') {
    const sd = parentData as SeriesElementData;
    if (sd.enabled === false) return 0;
    const upstreamV = resolveInputVoltage(parentId, nodes, edges, sourceVoltages);
    if (upstreamV <= 0) return 0;
    if (sd.seriesMode === 'diode') {
      return Math.max(0, upstreamV - (sd.forwardVoltage || 0));
    }
    return upstreamV;
  }
  return 0;
}

// Like resolveInputVoltage, but subtracts I*R for any resistive series
// ancestors in the chain. Uses getNodeCurrentDraw (which itself uses
// unadjusted resolveInputVoltage) to avoid circular dependency.
function resolveInputVoltageWithSeriesDrop(
  nodeId: string, nodes: Map<string, Node>, edges: Edge[],
  sourceVoltages: Map<string, number>, timeIdx: number, allTimes: number[],
  auxOverrides?: Record<string, Record<string, boolean>>
): number {
  let voltage = resolveInputVoltage(nodeId, nodes, edges, sourceVoltages);
  let curId = nodeId;
  while (true) {
    const parentId = getParent(curId, edges);
    if (!parentId) break;
    const parentNode = nodes.get(parentId);
    if (!parentNode) break;
    const pd = parentNode.data as unknown as PowerNodeData;
    if (pd.type === 'series') {
      const sd = pd as SeriesElementData;
      if (sd.seriesMode !== 'diode' && (sd.resistance || 0) > 0) {
        const current = getNodeCurrentDraw(parentId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);
        voltage = Math.max(0, voltage - current * sd.resistance);
      }
      curId = parentId;
    } else {
      break;
    }
  }
  return voltage;
}

function getChildInputVoltage(
  childId: string,
  childData: PowerNodeData,
  nodes: Map<string, Node>,
  edges: Edge[],
  sourceVoltages: Map<string, number>
): number {
  if (childData.type === 'converter' || childData.type === 'load') {
    return resolveInputVoltage(childId, nodes, edges, sourceVoltages);
  }
  return 0;
}

function getSeriesLoss(sd: SeriesElementData, current: number): number {
  if (sd.seriesMode === 'diode') return current * (sd.forwardVoltage || 0);
  return current * current * (sd.resistance || 0);
}

function getAuxLoadCurrent(
  auxLoads: AuxLoad[] | undefined,
  voltage: number,
  overrides?: Record<string, boolean>
): number {
  if (!auxLoads || auxLoads.length === 0 || voltage <= 0) return 0;
  let total = 0;
  for (const al of auxLoads) {
    if (overrides && overrides[al.id] === false) continue;
    if (al.mode === 'resistor') {
      total += al.resistance > 0 ? voltage / al.resistance : 0;
    } else {
      total += al.fixedCurrent || 0;
    }
  }
  return total;
}

function getLoadCurrent(ld: LoadData, time: number, voltage?: number): number {
  if (ld.loadMode === 'resistor') {
    const v = voltage ?? 0;
    return ld.resistance > 0 ? v / ld.resistance : 0;
  }
  if (ld.loadMode === 'fixed_current') {
    return ld.fixedCurrent || 0;
  }
  return getCurrentAtTime(ld.loadProfile, time);
}

// Voltage resolver that skips series I*R estimation to avoid mutual recursion
// with _getNodeCurrentDrawNoSeriesDrop. Identical to resolveInputVoltage except
// for resistive series nodes, where it returns upstream voltage without I*R drop.

function _getNodeCurrentDrawNoSeriesDrop(
  nodeId: string, nodes: Map<string, Node>, edges: Edge[],
  timeIdx: number, allTimes: number[], sourceVoltages: Map<string, number>,
): number {
  const node = nodes.get(nodeId);
  if (!node) return 0;
  const data = node.data as unknown as PowerNodeData;
  if (data.type === 'load') {
    if ((data as LoadData).enabled === false) return 0;
    const loadV = resolveInputVoltage(nodeId, nodes, edges, sourceVoltages);
    if (loadV <= 0) return 0;
    return getLoadCurrent(data as LoadData, allTimes[timeIdx], loadV);
  }
  if (data.type === 'series') {
    if ((data as SeriesElementData).enabled === false) return 0;
    let total = 0;
    for (const childId of getChildren(nodeId, edges)) {
      total += _getNodeCurrentDrawNoSeriesDrop(childId, nodes, edges, timeIdx, allTimes, sourceVoltages);
    }
    return total;
  }
  if (data.type === 'converter' && (data as PowerConverterData).enabled === false) return 0;
  let totalOutputPower = 0;
  for (const childId of getChildren(nodeId, edges)) {
    const childNode = nodes.get(childId);
    if (!childNode) continue;
    const childData = childNode.data as unknown as PowerNodeData;
    const childCurrent = _getNodeCurrentDrawNoSeriesDrop(childId, nodes, edges, timeIdx, allTimes, sourceVoltages);
    const childV = (childData.type === 'converter' || childData.type === 'load')
      ? resolveInputVoltage(childId, nodes, edges, sourceVoltages) : 0;
    totalOutputPower += childCurrent * childV;
  }
  if (data.type === 'converter') {
    const cd = data as PowerConverterData;
    const inputVoltage = resolveInputVoltage(nodeId, nodes, edges, sourceVoltages);
    return converterInputCurrent(cd, inputVoltage, totalOutputPower);
  }
  if (data.type === 'source') {
    const sd = data as PowerSourceData;
    const sv = sourceVoltages.get(nodeId) ?? sd.nominalVoltage;
    return sv > 0 ? totalOutputPower / sv : 0;
  }
  return 0;
}

function getNodeCurrentDraw(
  nodeId: string, nodes: Map<string, Node>, edges: Edge[],
  timeIdx: number, allTimes: number[], sourceVoltages: Map<string, number>,
  auxOverrides?: Record<string, Record<string, boolean>>
): number {
  const node = nodes.get(nodeId);
  if (!node) return 0;
  const data = node.data as unknown as PowerNodeData;
  const nodeAuxOv = auxOverrides?.[nodeId];

  if (data.type === 'load') {
    if ((data as LoadData).enabled === false) return 0;
    const loadV = resolveInputVoltage(nodeId, nodes, edges, sourceVoltages);
    if (loadV <= 0) return 0;
    return getLoadCurrent(data as LoadData, allTimes[timeIdx], loadV);
  }

  if (data.type === 'series') {
    const sd = data as SeriesElementData;
    if (sd.enabled === false) return 0;
    let total = 0;
    for (const childId of getChildren(nodeId, edges)) {
      total += getNodeCurrentDraw(childId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);
    }
    const upstreamV = resolveInputVoltage(nodeId, nodes, edges, sourceVoltages);
    let outputV = upstreamV;
    if (sd.seriesMode === 'diode') {
      outputV = Math.max(0, upstreamV - (sd.forwardVoltage || 0));
    } else if ((sd.resistance || 0) > 0) {
      outputV = Math.max(0, upstreamV - total * sd.resistance);
    }
    total += getAuxLoadCurrent(sd.auxLoads, outputV, nodeAuxOv);
    return total;
  }

  if (data.type === 'converter' && (data as PowerConverterData).enabled === false) return 0;

  const children = getChildren(nodeId, edges);
  let totalOutputPower = 0;

  for (const childId of children) {
    const childNode = nodes.get(childId);
    if (!childNode) continue;
    const childData = childNode.data as unknown as PowerNodeData;
    const childCurrent = getNodeCurrentDraw(childId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);

    if (childData.type === 'series') {
      const downstreamPower = getSeriesChainPower(childId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);
      totalOutputPower += downstreamPower + getSeriesLoss(childData as SeriesElementData, childCurrent);
    } else {
      totalOutputPower += childCurrent * getChildInputVoltage(childId, childData, nodes, edges, sourceVoltages);
    }
  }

  if (data.type === 'converter') {
    const cd = data as PowerConverterData;
    const inputVoltage = resolveInputVoltage(nodeId, nodes, edges, sourceVoltages);
    const outV = cd.converterType === 'ldo' ? getLdoActualOutputVoltage(cd, inputVoltage) : cd.outputVoltage;
    const auxPower = getAuxLoadCurrent(cd.auxLoads, outV, nodeAuxOv) * outV;
    totalOutputPower += auxPower;
    return converterInputCurrent(cd, inputVoltage, totalOutputPower);
  }
  if (data.type === 'source') {
    const sd = data as PowerSourceData;
    const sv = sourceVoltages.get(nodeId) ?? sd.nominalVoltage;
    const auxPower = getAuxLoadCurrent(sd.auxLoads, sv, nodeAuxOv) * sv;
    totalOutputPower += auxPower;
    return totalOutputPower / (sv || 1);
  }
  return 0;
}

function getSeriesChainPower(
  seriesNodeId: string, nodes: Map<string, Node>, edges: Edge[],
  timeIdx: number, allTimes: number[], sourceVoltages: Map<string, number>,
  auxOverrides?: Record<string, Record<string, boolean>>
): number {
  let total = 0;
  const seriesNode = nodes.get(seriesNodeId);
  if (seriesNode) {
    const sd = seriesNode.data as unknown as SeriesElementData;
    const upstreamV = resolveInputVoltage(seriesNodeId, nodes, edges, sourceVoltages);
    // Use output voltage for aux loads
    let outputV = upstreamV;
    if (sd.seriesMode === 'diode') {
      outputV = Math.max(0, upstreamV - (sd.forwardVoltage || 0));
    } else if ((sd.resistance || 0) > 0) {
      const current = getNodeCurrentDraw(seriesNodeId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);
      outputV = Math.max(0, upstreamV - current * sd.resistance);
    }
    const auxI = getAuxLoadCurrent(sd.auxLoads, outputV, auxOverrides?.[seriesNodeId]);
    total += auxI * outputV;
  }
  for (const childId of getChildren(seriesNodeId, edges)) {
    const childNode = nodes.get(childId);
    if (!childNode) continue;
    const childData = childNode.data as unknown as PowerNodeData;
    const childCurrent = getNodeCurrentDraw(childId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);

    if (childData.type === 'series') {
      total += getSeriesChainPower(childId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides) +
        getSeriesLoss(childData as SeriesElementData, childCurrent);
    } else {
      total += childCurrent * getChildInputVoltage(childId, childData, nodes, edges, sourceVoltages);
    }
  }
  return total;
}

function getCurrentAtTime(profile: LoadProfilePoint[], time: number): number {
  if (profile.length === 0) return 0;
  if (profile.length === 1) return profile[0].current;
  const sorted = [...profile].sort((a, b) => a.time - b.time);
  const period = sorted[sorted.length - 1].time;
  const t = period > 0 ? time % period : time;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].time <= t) return sorted[i].current;
  }
  return sorted[sorted.length - 1].current;
}

function gcd(a: number, b: number): number {
  a = Math.round(a * 1e6);
  b = Math.round(b * 1e6);
  while (b) { [a, b] = [b, a % b]; }
  return a / 1e6;
}

function lcm(a: number, b: number): number {
  if (a === 0 || b === 0) return Math.max(a, b);
  return Math.abs(a * b) / gcd(a, b);
}

const MAX_TIMELINE_POINTS = 2000;
const SAMPLE_COUNT = 1000;
const SNAP_TOLERANCE = 0.05;

/**
 * Try to find a grid resolution where every period snaps to a whole
 * multiple within SNAP_TOLERANCE (5%) and the resulting pseudo-LCM
 * produces a manageable number of time points.
 */
function findPseudoLcm(
  periods: number[], maxPoints: number, pointsPerPeriod: number[]
): { superPeriod: number; snappedPeriods: number[] } | null {
  const minP = Math.min(...periods);

  // Try increasingly coarse resolutions: minP/N for N = 20, 15, 10, 8, 6, 4, 3, 2, 1
  const divisors = [20, 15, 10, 8, 6, 4, 3, 2, 1];
  for (const div of divisors) {
    const res = minP / div;
    const snapped = periods.map(p => Math.round(p / res) * res);

    // Check all periods are within tolerance
    const withinTolerance = periods.every((p, i) =>
      Math.abs(snapped[i] - p) / p <= SNAP_TOLERANCE
    );
    if (!withinTolerance) continue;

    // Compute LCM of snapped periods
    let sp = snapped[0];
    let overflow = false;
    for (let i = 1; i < snapped.length; i++) {
      sp = lcm(sp, snapped[i]);
      if (sp > 1e8) { overflow = true; break; }
    }
    if (overflow) continue;

    // Check total point count
    let total = 0;
    for (let i = 0; i < snapped.length; i++) {
      total += Math.round(sp / snapped[i]) * pointsPerPeriod[i];
    }
    if (total <= maxPoints) {
      return { superPeriod: sp, snappedPeriods: snapped };
    }
  }
  return null;
}

function buildUnifiedTimeline(
  nodes: Map<string, Node>,
  powerStates?: PowerState[]
): number[] {
  const loadPeriods: { period: number; points: number[] }[] = [];
  const seen = new Set<string>();

  const addLoadProfile = (ld: LoadData, key: string) => {
    if (seen.has(key)) return;
    if (ld.loadMode === 'current_profile' && ld.loadProfile.length > 1) {
      const sorted = [...ld.loadProfile].sort((a, b) => a.time - b.time);
      const period = sorted[sorted.length - 1].time;
      const hasVariation = sorted.some(p => Math.abs(p.current - sorted[0].current) > 1e-12);
      if (period > 0 && hasVariation) {
        seen.add(key);
        loadPeriods.push({ period, points: sorted.map(p => p.time) });
      }
    }
  };

  nodes.forEach((node, nid) => {
    const data = node.data as unknown as PowerNodeData;
    if (data.type === 'load') {
      addLoadProfile(data as LoadData, `canvas:${nid}`);
    }
  });

  if (powerStates) {
    for (const state of powerStates) {
      if (!state.loadSnapshots) continue;
      for (const [nid, snap] of Object.entries(state.loadSnapshots)) {
        addLoadProfile(snap as LoadData, `${state.id}:${nid}`);
      }
    }
  }

  if (loadPeriods.length === 0) return [0];

  const nonZeroPeriods = loadPeriods.filter(lp => lp.period > 0);
  if (nonZeroPeriods.length === 0) return [0];

  // 1) Try exact LCM first
  let superPeriod = nonZeroPeriods[0].period;
  let exactOk = true;
  for (let i = 1; i < nonZeroPeriods.length; i++) {
    superPeriod = lcm(superPeriod, nonZeroPeriods[i].period);
    if (superPeriod > 1e8) { exactOk = false; break; }
  }

  if (exactOk) {
    let totalPoints = 0;
    for (const lp of loadPeriods) {
      if (lp.period > 0) {
        totalPoints += Math.round(superPeriod / lp.period) * lp.points.length;
      } else {
        totalPoints += lp.points.length;
      }
    }
    if (totalPoints <= MAX_TIMELINE_POINTS) {
      return materializeTimeline(loadPeriods, nonZeroPeriods.map(lp => lp.period), superPeriod);
    }
  }

  // 2) Try pseudo-LCM with snapped periods (within 5% tolerance)
  const periods = nonZeroPeriods.map(lp => lp.period);
  const ptsPerPeriod = nonZeroPeriods.map(lp => lp.points.length);
  const pseudo = findPseudoLcm(periods, MAX_TIMELINE_POINTS, ptsPerPeriod);
  if (pseudo) {
    return materializeTimeline(loadPeriods, pseudo.snappedPeriods, pseudo.superPeriod);
  }

  // 3) Final fallback: uniform sampling over the longest period
  const longestPeriod = Math.max(...nonZeroPeriods.map(lp => lp.period));
  const times: number[] = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    times.push(roundTime((i / SAMPLE_COUNT) * longestPeriod));
  }
  return times;
}

function materializeTimeline(
  loadPeriods: { period: number; points: number[] }[],
  snappedPeriods: number[],
  superPeriod: number
): number[] {
  const times = new Set<number>();
  let snapIdx = 0;
  for (const lp of loadPeriods) {
    if (lp.period <= 0) {
      lp.points.forEach(t => times.add(roundTime(t)));
      continue;
    }
    const snapped = snappedPeriods[snapIdx++];
    const reps = Math.round(superPeriod / snapped);
    for (let r = 0; r < reps; r++) {
      const offset = r * snapped;
      for (const t of lp.points) {
        times.add(roundTime(offset + t * (snapped / lp.period)));
      }
    }
  }
  if (times.size === 0) times.add(0);
  return Array.from(times).sort((a, b) => a - b);
}

function roundTime(t: number): number {
  return Math.round(t * 1e9) / 1e9;
}

function interpolateDischargeVoltage(curve: DischargeCurvePoint[], capacityUsedMah: number): number {
  if (curve.length === 0) return 0;
  if (curve.length === 1) return curve[0].voltage;
  const sorted = [...curve].sort((a, b) => a.capacityMah - b.capacityMah);
  if (capacityUsedMah <= sorted[0].capacityMah) return sorted[0].voltage;
  if (capacityUsedMah >= sorted[sorted.length - 1].capacityMah) return sorted[sorted.length - 1].voltage;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (capacityUsedMah >= sorted[i].capacityMah && capacityUsedMah <= sorted[i + 1].capacityMah) {
      const t = (capacityUsedMah - sorted[i].capacityMah) / (sorted[i + 1].capacityMah - sorted[i].capacityMah);
      return sorted[i].voltage + t * (sorted[i + 1].voltage - sorted[i].voltage);
    }
  }
  return sorted[sorted.length - 1].voltage;
}

/**
 * Interpolate voltage for a given capacity used, blending between
 * per-temperature discharge curves weighted by the temperature profile.
 */
function interpolateDischargeVoltageForTemp(
  curves: DischargeCurveAtTemp[],
  temperatureProfile: { tempC: number; fractionOfTime: number }[],
  capacityUsedMah: number
): number {
  if (curves.length === 0) return 0;
  if (curves.length === 1) return interpolateDischargeVoltage(curves[0].points, capacityUsedMah);

  // If no temperature profile, average across all curves equally
  if (temperatureProfile.length === 0) {
    let sum = 0;
    for (const c of curves) sum += interpolateDischargeVoltage(c.points, capacityUsedMah);
    return sum / curves.length;
  }

  // For each temp slice, interpolate between the two nearest temp curves
  const sorted = [...curves].sort((a, b) => a.tempC - b.tempC);
  let totalV = 0;
  let totalWeight = 0;

  for (const slice of temperatureProfile) {
    const tempC = slice.tempC;
    const weight = slice.fractionOfTime;
    if (weight <= 0) continue;

    let v: number;
    if (tempC <= sorted[0].tempC) {
      v = interpolateDischargeVoltage(sorted[0].points, capacityUsedMah);
    } else if (tempC >= sorted[sorted.length - 1].tempC) {
      v = interpolateDischargeVoltage(sorted[sorted.length - 1].points, capacityUsedMah);
    } else {
      let lo = 0;
      for (let i = 0; i < sorted.length - 1; i++) {
        if (tempC >= sorted[i].tempC && tempC <= sorted[i + 1].tempC) { lo = i; break; }
      }
      const t = (tempC - sorted[lo].tempC) / (sorted[lo + 1].tempC - sorted[lo].tempC);
      const vLo = interpolateDischargeVoltage(sorted[lo].points, capacityUsedMah);
      const vHi = interpolateDischargeVoltage(sorted[lo + 1].points, capacityUsedMah);
      v = vLo + t * (vHi - vLo);
    }

    totalV += v * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? totalV / totalWeight : 0;
}

/**
 * Get the effective total capacity from per-temperature discharge curves,
 * weighted by the temperature profile.
 */
function getEffectiveTotalCapacity(
  curves: DischargeCurveAtTemp[],
  temperatureProfile: { tempC: number; fractionOfTime: number }[]
): number {
  if (curves.length === 0) return 0;

  const getMaxCap = (pts: DischargeCurvePoint[]) =>
    pts.length > 0 ? Math.max(...pts.map(p => p.capacityMah)) : 0;

  if (curves.length === 1 || temperatureProfile.length === 0) {
    return getMaxCap(curves[0].points);
  }

  const sorted = [...curves].sort((a, b) => a.tempC - b.tempC);
  let total = 0;
  let totalWeight = 0;

  for (const slice of temperatureProfile) {
    const tempC = slice.tempC;
    const weight = slice.fractionOfTime;
    if (weight <= 0) continue;

    let cap: number;
    if (tempC <= sorted[0].tempC) {
      cap = getMaxCap(sorted[0].points);
    } else if (tempC >= sorted[sorted.length - 1].tempC) {
      cap = getMaxCap(sorted[sorted.length - 1].points);
    } else {
      let lo = 0;
      for (let i = 0; i < sorted.length - 1; i++) {
        if (tempC >= sorted[i].tempC && tempC <= sorted[i + 1].tempC) { lo = i; break; }
      }
      const t = (tempC - sorted[lo].tempC) / (sorted[lo + 1].tempC - sorted[lo].tempC);
      cap = getMaxCap(sorted[lo].points) + t * (getMaxCap(sorted[lo + 1].points) - getMaxCap(sorted[lo].points));
    }

    total += cap * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? total / totalWeight : getMaxCap(curves[0].points);
}

function interpolateSimpleCapacity(
  caps: CapacityAtTemp[],
  temperatureProfile: { tempC: number; fractionOfTime: number }[]
): number {
  if (caps.length === 0) return 0;
  if (caps.length === 1 || temperatureProfile.length === 0) return caps[0].capacityMah;

  const sorted = [...caps].sort((a, b) => a.tempC - b.tempC);
  let total = 0;
  let totalWeight = 0;

  for (const slice of temperatureProfile) {
    const tempC = slice.tempC;
    const weight = slice.fractionOfTime;
    if (weight <= 0) continue;

    let cap: number;
    if (tempC <= sorted[0].tempC) {
      cap = sorted[0].capacityMah;
    } else if (tempC >= sorted[sorted.length - 1].tempC) {
      cap = sorted[sorted.length - 1].capacityMah;
    } else {
      let lo = 0;
      for (let i = 0; i < sorted.length - 1; i++) {
        if (tempC >= sorted[i].tempC && tempC <= sorted[i + 1].tempC) { lo = i; break; }
      }
      const t = (tempC - sorted[lo].tempC) / (sorted[lo + 1].tempC - sorted[lo].tempC);
      cap = sorted[lo].capacityMah + t * (sorted[lo + 1].capacityMah - sorted[lo].capacityMah);
    }

    total += cap * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? total / totalWeight : caps[0].capacityMah;
}

interface DischargePowerAccum {
  inputPower: number;
  outputPower: number;
  auxPower: number;
  current: number;
  voltageOut: number;
}

interface DischargeResult {
  lifetimeHours: number;
  dischargeSeries: BatteryTimeSeriesPoint[];
  nodeAvgPower: Map<string, DischargePowerAccum>;
}

const EMPTY_DISCHARGE: DischargeResult = { lifetimeHours: 0, dischargeSeries: [], nodeAvgPower: new Map() };

function accumulateDischargeStep(
  nodeId: string, nodes: Map<string, Node>, edges: Edge[],
  timeIdx: number, allTimes: number[], sourceVoltages: Map<string, number>,
  accum: Map<string, DischargePowerAccum>, dtHours: number,
  auxOverrides?: Record<string, Record<string, boolean>>
) {
  const node = nodes.get(nodeId);
  if (!node) return;
  const data = node.data as unknown as PowerNodeData;
  let acc = accum.get(nodeId);
  if (!acc) {
    acc = { inputPower: 0, outputPower: 0, auxPower: 0, current: 0, voltageOut: 0 };
    accum.set(nodeId, acc);
  }

  const nodeAuxOv = auxOverrides?.[nodeId];
  const children = getChildren(nodeId, edges);

  if (data.type === 'load') {
    const ld = data as LoadData;
    if (ld.enabled === false) return;
    const loadV = resolveInputVoltage(nodeId, nodes, edges, sourceVoltages);
    if (loadV <= 0) return;
    const cur = getLoadCurrent(ld, allTimes[timeIdx], loadV);
    const power = cur * loadV;
    acc.inputPower += power * dtHours;
    acc.outputPower += power * dtHours;
    acc.current += cur * dtHours;
    acc.voltageOut += loadV * dtHours;
    return;
  }

  if (data.type === 'series') {
    const sd = data as SeriesElementData;
    if (sd.enabled === false) return;
    const current = getNodeCurrentDraw(nodeId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);
    const upstreamV = resolveInputVoltage(nodeId, nodes, edges, sourceVoltages);
    const downstream = getSeriesChainPower(nodeId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);
    const loss = getSeriesLoss(sd, current);
    acc.inputPower += (downstream + loss) * dtHours;
    acc.outputPower += downstream * dtHours;
    acc.current += current * dtHours;

    let vOut = upstreamV;
    if (sd.seriesMode === 'diode') {
      vOut = Math.max(0, upstreamV - (sd.forwardVoltage || 0));
    } else {
      vOut = Math.max(0, upstreamV - current * (sd.resistance || 0));
    }
    acc.voltageOut += vOut * dtHours;

    const auxI = getAuxLoadCurrent(sd.auxLoads, vOut, nodeAuxOv);
    acc.auxPower += auxI * vOut * dtHours;

    for (const childId of children) {
      accumulateDischargeStep(childId, nodes, edges, timeIdx, allTimes, sourceVoltages, accum, dtHours, auxOverrides);
    }
    return;
  }

  let totalChildInputPower = 0;
  for (const childId of children) {
    const childNode = nodes.get(childId);
    if (!childNode) continue;
    const childData = childNode.data as unknown as PowerNodeData;
    const childCurrent = getNodeCurrentDraw(childId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);

    if (childData.type === 'series') {
      totalChildInputPower += getSeriesChainPower(childId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides) +
        getSeriesLoss(childData as SeriesElementData, childCurrent);
    } else {
      totalChildInputPower += childCurrent * getChildInputVoltage(childId, childData, nodes, edges, sourceVoltages);
    }
    accumulateDischargeStep(childId, nodes, edges, timeIdx, allTimes, sourceVoltages, accum, dtHours, auxOverrides);
  }

  if (data.type === 'source') {
    const sd = data as PowerSourceData;
    const sv = sourceVoltages.get(nodeId) ?? sd.nominalVoltage;
    const rInt = sd.internalResistance || 0;
    const current = getNodeCurrentDraw(nodeId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);
    const irLoss = current * current * rInt;
    const terminalPower = current * sv;
    acc.inputPower += (terminalPower + irLoss) * dtHours;
    acc.outputPower += terminalPower * dtHours;
    acc.current += current * dtHours;
    acc.voltageOut += sv * dtHours;
    const auxI = getAuxLoadCurrent(sd.auxLoads, sv, nodeAuxOv);
    acc.auxPower += auxI * sv * dtHours;
  } else if (data.type === 'converter') {
    const cd = data as PowerConverterData;
    if (cd.enabled === false) return;
    const inputVoltage = resolveInputVoltage(nodeId, nodes, edges, sourceVoltages);
    const current = getNodeCurrentDraw(nodeId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);
    const actualOutV = cd.converterType === 'ldo' ? getLdoActualOutputVoltage(cd, inputVoltage) : cd.outputVoltage;
    const auxI = getAuxLoadCurrent(cd.auxLoads, actualOutV, nodeAuxOv);
    const auxP = auxI * actualOutV;
    const totalOut = totalChildInputPower + auxP;
    acc.inputPower += converterInputPower(cd, inputVoltage, totalOut) * dtHours;
    acc.outputPower += totalOut * dtHours;
    acc.current += current * dtHours;
    acc.voltageOut += (inputVoltage > 0 ? actualOutV : 0) * dtHours;
    acc.auxPower += auxP * dtHours;
  }
}

function simulateBatteryDischarge(
  sourceId: string,
  sd: PowerSourceData,
  _allNodes: Node[],
  edges: Edge[],
  nodeMap: Map<string, Node>,
  times: number[],
  powerStates?: { nodeMap: Map<string, Node>; fractionOfTime: number; auxLoadOverrides?: Record<string, Record<string, boolean>> }[]
): DischargeResult {
  void _allNodes;
  const batteryMode = sd.batteryMode || 'simple';
  const curves = sd.dischargeCurves || [];
  const caps = sd.capacityAtTemps || [];
  const tempProfile = sd.temperatureProfile || [];

  let totalCapacityMah: number;
  if (batteryMode === 'detailed') {
    if (curves.length === 0 || curves.every(c => c.points.length === 0)) {
      return EMPTY_DISCHARGE;
    }
    totalCapacityMah = getEffectiveTotalCapacity(curves, tempProfile);
  } else {
    if (caps.length === 0) return EMPTY_DISCHARGE;
    totalCapacityMah = interpolateSimpleCapacity(caps, tempProfile);
  }

  if (totalCapacityMah <= 0) return EMPTY_DISCHARGE;

  const cutoff = sd.cutoffVoltage || 0;

  const stateSlices = powerStates && powerStates.length > 0
    ? powerStates
    : [{ nodeMap, fractionOfTime: 1, auxLoadOverrides: undefined as Record<string, Record<string, boolean>> | undefined }];

  // Compute average current at nominal voltage (for rough lifetime estimate)
  const nomVoltages = new Map<string, number>();
  nomVoltages.set(sourceId, sd.nominalVoltage);

  let avgCurrentA = 0;
  for (const slice of stateSlices) {
    let sliceCurrent = 0;
    for (let ti = 0; ti < times.length; ti++) {
      sliceCurrent += getNodeCurrentDraw(sourceId, slice.nodeMap, edges, ti, times, nomVoltages, slice.auxLoadOverrides);
    }
    sliceCurrent = times.length > 0 ? sliceCurrent / times.length : 0;
    avgCurrentA += sliceCurrent * slice.fractionOfTime;
  }
  if (avgCurrentA <= 0) return EMPTY_DISCHARGE;

  // Simple mode without discharge curves: constant voltage, lifetime = capacity / avg current
  // But still run through states to get proper per-node averages
  const canSimulateVoltage = batteryMode === 'detailed' && curves.some(c => c.points.length >= 2);

  const cyclePeriodS = times.length > 1 ? times[times.length - 1] - times[0] : 1;
  const roughLifetimeH = totalCapacityMah / (avgCurrentA * 1000);
  const dtHours = Math.max(roughLifetimeH / 500, 1 / 3600);
  const maxSteps = 5000;

  let capacityUsedMah = 0;
  let timeHours = 0;
  const series: BatteryTimeSeriesPoint[] = [];
  const nodeAccum = new Map<string, DischargePowerAccum>();
  const rInt = sd.internalResistance || 0;
  let prevCurrent = avgCurrentA;

  for (let step = 0; step < maxSteps; step++) {
    let ocVoltage: number;
    if (canSimulateVoltage) {
      ocVoltage = interpolateDischargeVoltageForTemp(curves, tempProfile, capacityUsedMah);
    } else {
      ocVoltage = sd.nominalVoltage;
    }

    if (capacityUsedMah >= totalCapacityMah) break;

    // Iteratively solve for self-consistent (voltage, current) pair
    // (capacity check is also done at end of loop to prevent overshoot)
    // V_terminal = V_oc - I * R_int, but I depends on V_terminal
    let iterCurrent = prevCurrent;
    let voltage = Math.max(0, ocVoltage - iterCurrent * rInt);
    const numTi = Math.max(1, times.length);

    if (rInt > 0) {
      for (let iter = 0; iter < 5; iter++) {
        voltage = Math.max(0, ocVoltage - iterCurrent * rInt);
        if (voltage <= 0) { voltage = 0; break; }
        const sv = new Map<string, number>();
        sv.set(sourceId, voltage);
        let newCurrent = 0;
        for (const slice of stateSlices) {
          let sliceAvg = 0;
          for (let ti = 0; ti < numTi; ti++) {
            const dt = ti < numTi - 1 ? times[ti + 1] - times[ti] : (numTi > 1 ? 0 : 1);
            sliceAvg += getNodeCurrentDraw(sourceId, slice.nodeMap, edges, ti, times, sv, slice.auxLoadOverrides) * dt;
          }
          sliceAvg = cyclePeriodS > 0 ? sliceAvg / cyclePeriodS : sliceAvg;
          newCurrent += sliceAvg * slice.fractionOfTime;
        }
        if (Math.abs(newCurrent - iterCurrent) < 1e-6) break;
        iterCurrent = newCurrent;
      }
      voltage = Math.max(0, ocVoltage - iterCurrent * rInt);
    }

    if (voltage <= cutoff && cutoff > 0) break;

    const sourceVoltages = new Map<string, number>();
    sourceVoltages.set(sourceId, voltage);

    // Compute final current and accumulate power metrics
    let stepCurrent = 0;
    const shouldAccum = step % 10 === 0;
    for (const slice of stateSlices) {
      let sliceAvgCurrent = 0;
      for (let ti = 0; ti < numTi; ti++) {
        const dt = ti < numTi - 1 ? times[ti + 1] - times[ti] : (numTi > 1 ? 0 : 1);
        const cur = getNodeCurrentDraw(sourceId, slice.nodeMap, edges, ti, times, sourceVoltages, slice.auxLoadOverrides);
        sliceAvgCurrent += cur * dt;
        if (shouldAccum) {
          accumulateDischargeStep(sourceId, slice.nodeMap, edges, ti, times, sourceVoltages, nodeAccum, dtHours * 10 * dt / cyclePeriodS * slice.fractionOfTime, slice.auxLoadOverrides);
        }
      }
      sliceAvgCurrent = cyclePeriodS > 0 ? sliceAvgCurrent / cyclePeriodS : sliceAvgCurrent;
      stepCurrent += sliceAvgCurrent * slice.fractionOfTime;
    }
    prevCurrent = stepCurrent;

    if (stepCurrent <= 0) break;

    if (step % 10 === 0 || step === 0) {
      series.push({ timeHours, voltage, current: stepCurrent, capacityUsedMah });
    }

    const capacityStep = stepCurrent * 1000 * dtHours;
    if (capacityUsedMah + capacityStep >= totalCapacityMah) {
      const remaining = totalCapacityMah - capacityUsedMah;
      const fractionalDt = remaining / (stepCurrent * 1000);
      capacityUsedMah = totalCapacityMah;
      timeHours += fractionalDt;
      break;
    }
    capacityUsedMah += capacityStep;
    timeHours += dtHours;
  }

  if (canSimulateVoltage) {
    const finalOcv = interpolateDischargeVoltageForTemp(curves, tempProfile, capacityUsedMah);
    const finalTerminal = Math.max(0, finalOcv - prevCurrent * rInt);
    series.push({ timeHours, voltage: finalTerminal, current: 0, capacityUsedMah });
  }

  // Normalize accumulated values by total time to get averages
  if (timeHours > 0) {
    for (const [, acc] of nodeAccum) {
      acc.inputPower /= timeHours;
      acc.outputPower /= timeHours;
      acc.auxPower /= timeHours;
      acc.current /= timeHours;
      acc.voltageOut /= timeHours;
    }
  }

  return { lifetimeHours: timeHours, dischargeSeries: series, nodeAvgPower: nodeAccum };
}

function runSingleScenario(
  allNodes: Node[], edges: Edge[], nodeMap: Map<string, Node>,
  times: number[], sourceVoltagesOCV: Map<string, number>
): { nodeResults: Map<string, ScenarioResult>; timeSeries: TimeSeriesPoint[] } {
  const sources = allNodes.filter(n => (n.data as unknown as PowerNodeData).type === 'source');

  // Iteratively solve for terminal voltages accounting for I*R drop at sources
  const sourceVoltages = new Map(sourceVoltagesOCV);
  for (let iter = 0; iter < 5; iter++) {
    let maxDelta = 0;
    for (const source of sources) {
      const sd = source.data as unknown as PowerSourceData;
      if (sd.type !== 'source') continue;
      const rInt = sd.internalResistance || 0;
      if (rInt <= 0) continue;
      const ocv = sourceVoltagesOCV.get(source.id) ?? sd.nominalVoltage;
      let avgCurrent = 0;
      const totalDur = times.length > 1 ? times[times.length - 1] - times[0] : 1;
      for (let ti = 0; ti < times.length; ti++) {
        const dt = ti < times.length - 1 ? times[ti + 1] - times[ti] : (times.length > 1 ? 0 : 1);
        avgCurrent += getNodeCurrentDraw(source.id, nodeMap, edges, ti, times, sourceVoltages) * dt;
      }
      avgCurrent = totalDur > 0 ? avgCurrent / totalDur : avgCurrent;
      const terminal = Math.max(0, ocv - avgCurrent * rInt);
      const prev = sourceVoltages.get(source.id) ?? ocv;
      maxDelta = Math.max(maxDelta, Math.abs(terminal - prev));
      sourceVoltages.set(source.id, terminal);
    }
    if (maxDelta < 1e-6) break;
  }

  const timeSeries: TimeSeriesPoint[] = [];
  const nodeAccum = new Map<string, { inputPower: number; outputPower: number }>();
  allNodes.forEach(n => nodeAccum.set(n.id, { inputPower: 0, outputPower: 0 }));
  const totalDuration = times.length > 1 ? times[times.length - 1] - times[0] : 1;

  for (let ti = 0; ti < times.length; ti++) {
    const dt = ti < times.length - 1 ? times[ti + 1] - times[ti] : (times.length > 1 ? 0 : 1);
    let totalInputPower = 0;
    let totalInputCurrent = 0;
    let totalLoad = 0;

    for (const source of sources) {
      const sd = source.data as unknown as PowerNodeData;
      if (sd.type !== 'source') continue;
      const ocv = sourceVoltagesOCV.get(source.id) ?? (sd as PowerSourceData).nominalVoltage;
      const current = getNodeCurrentDraw(source.id, nodeMap, edges, ti, times, sourceVoltages);
      totalInputPower += current * ocv;
      totalInputCurrent += current;
      accumulateNodePower(source.id, nodeMap, edges, ti, times, dt, nodeAccum, sourceVoltages);
    }

    allNodes.forEach(n => {
      const d = n.data as unknown as PowerNodeData;
      if (d.type === 'load') {
        const loadV = resolveInputVoltage(n.id, nodeMap, edges, sourceVoltages);
        totalLoad += getLoadCurrent(d as LoadData, times[ti], loadV) * loadV;
      }
    });

    timeSeries.push({ time: roundTime(times[ti]), inputPower: totalInputPower, inputCurrent: totalInputCurrent, totalLoad });
  }

  const div = totalDuration > 0 ? totalDuration : 1;
  const nodeResults = new Map<string, ScenarioResult>();
  allNodes.forEach(n => {
    void (n.data as unknown as PowerNodeData);
    const acc = nodeAccum.get(n.id)!;
    const avgIn = acc.inputPower / div;
    const avgOut = acc.outputPower / div;

    const res: ScenarioResult = {
      inputPowerAvg: avgIn,
      outputPowerAvg: avgOut,
      powerLossAvg: avgIn - avgOut,
      efficiencyAvg: avgIn > 0 ? avgOut / avgIn : 1,
    };

    nodeResults.set(n.id, res);
  });

  return { nodeResults, timeSeries };
}

function computeNodeStateResult(
  nodeId: string, d: PowerNodeData,
  stateNodeMap: Map<string, Node>, edges: Edge[],
  times: number[], sourceVoltages: Map<string, number>,
  auxOverrides?: Record<string, Record<string, boolean>>
): StateResult {
  let totalCurrent = 0;
  let totalInputPower = 0;
  let totalOutputPower = 0;
  let totalAuxPower = 0;
  let totalVoltageOut = 0;
  const numSteps = Math.max(1, times.length);
  const totalDuration = times.length > 1 ? times[times.length - 1] - times[0] : 1;

  for (let ti = 0; ti < numSteps; ti++) {
    const dt = ti < numSteps - 1 ? times[ti + 1] - times[ti] : (numSteps > 1 ? 0 : 1);
    let stepCurrent = 0;
    let stepVoltageOut = 0;
    let stepAuxPower = 0;

    if (d.type === 'source') {
      stepVoltageOut = sourceVoltages.get(nodeId) ?? (d as PowerSourceData).nominalVoltage;
    } else if (d.type === 'converter') {
      const cd = d as PowerConverterData;
      const convInV = resolveInputVoltageWithSeriesDrop(nodeId, stateNodeMap, edges, sourceVoltages, ti, times, auxOverrides);
      if (convInV <= 0) {
        stepVoltageOut = 0;
      } else if (cd.converterType === 'ldo') {
        stepVoltageOut = Math.min(cd.outputVoltage, convInV);
      } else {
        stepVoltageOut = cd.outputVoltage;
      }
    } else if (d.type === 'series') {
      const upstreamV = resolveInputVoltageWithSeriesDrop(nodeId, stateNodeMap, edges, sourceVoltages, ti, times, auxOverrides);
      const sd = d as SeriesElementData;
      if (sd.seriesMode === 'diode') {
        stepVoltageOut = Math.max(0, upstreamV - (sd.forwardVoltage || 0));
      } else {
        const seriesCurrent = getNodeCurrentDraw(nodeId, stateNodeMap, edges, ti, times, sourceVoltages, auxOverrides);
        stepVoltageOut = Math.max(0, upstreamV - seriesCurrent * (sd.resistance || 0));
      }
    } else if (d.type === 'load') {
      stepVoltageOut = resolveInputVoltageWithSeriesDrop(nodeId, stateNodeMap, edges, sourceVoltages, ti, times, auxOverrides);
    }

    if (d.type === 'load') {
      const ld = stateNodeMap.get(nodeId);
      const loadData = ld ? ld.data as unknown as LoadData : d as LoadData;
      stepCurrent = stepVoltageOut > 0 ? getLoadCurrent(loadData, times[ti], stepVoltageOut) : 0;
    } else {
      stepCurrent = getNodeCurrentDraw(nodeId, stateNodeMap, edges, ti, times, sourceVoltages, auxOverrides);
    }

    totalCurrent += stepCurrent * dt;
    totalVoltageOut += stepVoltageOut * dt;

    let stepInputPower: number;
    if (d.type === 'source') {
      const srcD = d as PowerSourceData;
      const rInt = srcD.internalResistance || 0;
      stepInputPower = stepCurrent * stepVoltageOut + stepCurrent * stepCurrent * rInt;
    } else if (d.type === 'load') {
      stepInputPower = stepCurrent * stepVoltageOut;
    } else {
      const stepInputV = resolveInputVoltageWithSeriesDrop(nodeId, stateNodeMap, edges, sourceVoltages, ti, times, auxOverrides);
      stepInputPower = stepCurrent * stepInputV;
    }

    if (d.type === 'converter') {
      const convD = d as PowerConverterData;
      const auxI = getAuxLoadCurrent(convD.auxLoads, stepVoltageOut, auxOverrides?.[nodeId]);
      stepAuxPower = auxI * stepVoltageOut;
    } else if (d.type === 'source') {
      const srcD = d as PowerSourceData;
      const sv = sourceVoltages.get(nodeId) ?? srcD.nominalVoltage;
      const auxI = getAuxLoadCurrent(srcD.auxLoads, sv, auxOverrides?.[nodeId]);
      stepAuxPower = auxI * sv;
    } else if (d.type === 'series') {
      const sd = d as SeriesElementData;
      // Use the output voltage (after drop) for aux loads on series elements
      const auxI = getAuxLoadCurrent(sd.auxLoads, stepVoltageOut, auxOverrides?.[nodeId]);
      stepAuxPower = auxI * stepVoltageOut;
    }

    let stepOutputPower: number;
    if (d.type === 'load') {
      stepOutputPower = stepInputPower;
    } else if (d.type === 'source') {
      stepOutputPower = stepCurrent * stepVoltageOut;
    } else if (d.type === 'series') {
      stepOutputPower = stepInputPower - getSeriesLoss(d as SeriesElementData, stepCurrent);
    } else if (stepCurrent > 0) {
      const children = getChildren(nodeId, edges);
      let childPower = 0;
      for (const cid of children) {
        const cn = stateNodeMap.get(cid);
        if (!cn) continue;
        const cd = cn.data as unknown as PowerNodeData;
        const cc = getNodeCurrentDraw(cid, stateNodeMap, edges, ti, times, sourceVoltages, auxOverrides);
        if (cd.type === 'series') {
          childPower += getSeriesChainPower(cid, stateNodeMap, edges, ti, times, sourceVoltages, auxOverrides) +
            getSeriesLoss(cd as SeriesElementData, cc);
        } else {
          childPower += cc * getChildInputVoltage(cid, cd, stateNodeMap, edges, sourceVoltages);
        }
      }
      stepOutputPower = childPower + stepAuxPower;
    } else {
      stepOutputPower = 0;
    }

    totalInputPower += stepInputPower * dt;
    totalOutputPower += stepOutputPower * dt;
    totalAuxPower += stepAuxPower * dt;
  }

  const div = totalDuration > 0 ? totalDuration : 1;
  const currentOut = totalCurrent / div;
  const voltageOut = totalVoltageOut / div;
  const inputPower = totalInputPower / div;
  const outputPower = totalOutputPower / div;
  const auxPower = totalAuxPower / div;
  const powerLoss = inputPower - outputPower;
  const clampedLoss = Math.max(0, powerLoss);
  const efficiency = inputPower > 0 ? Math.min(1, outputPower / inputPower) : 1;

  return { inputPower, outputPower, powerLoss: clampedLoss, efficiency, voltageOut, currentOut, auxPower };
}

export function analyzeTree(
  nodes: Node[], inputEdges: Edge[], powerStates?: PowerState[]
): {
  results: AnalysisResult[];
  scenarioTimeSeries: ScenarioTimeSeries[];
  batteryDischargeSeries: Map<string, BatteryTimeSeriesPoint[]>;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];

  // Strip any cyclic edges to prevent infinite recursion
  const nodeIds = new Set(nodes.map(n => n.id));
  const safeEdges: Edge[] = [];
  const parentOf = new Map<string, string>();
  for (const e of inputEdges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    if (parentOf.has(e.target)) continue;
    let ancestor: string | undefined = e.source;
    let isCycle = false;
    const seen = new Set<string>();
    while (ancestor) {
      if (ancestor === e.target) { isCycle = true; break; }
      if (seen.has(ancestor)) break;
      seen.add(ancestor);
      ancestor = parentOf.get(ancestor);
    }
    if (isCycle) {
      diagnostics.push({ severity: 'error', message: `Circular connection detected and ignored (${e.source} → ${e.target})` });
      continue;
    }
    parentOf.set(e.target, e.source);
    safeEdges.push(e);
  }
  const edges = safeEdges;

  const nodeMap = new Map<string, Node>();
  nodes.forEach(n => nodeMap.set(n.id, n));
  const sources = nodes.filter(n => (n.data as unknown as PowerNodeData).type === 'source');

  const states = powerStates && powerStates.length > 0
    ? powerStates
    : [{ id: 'default', name: 'Default', fractionOfTime: 1, loadSnapshots: {} as Record<string, LoadData> }];

  const times = buildUnifiedTimeline(nodeMap, powerStates);

  const scenarios: VoltageScenario[] = ['nom'];
  let hasMin = false;
  let hasMax = false;
  for (const s of sources) {
    const sd = s.data as unknown as PowerSourceData;
    if (sd.minVoltage != null && sd.minVoltage > 0) hasMin = true;
    if (sd.maxVoltage != null && sd.maxVoltage > 0) hasMax = true;
  }
  if (hasMin) scenarios.unshift('min');
  if (hasMax) scenarios.push('max');

  const scenarioTimeSeries: ScenarioTimeSeries[] = [];
  const scenarioNodeResults = new Map<VoltageScenario, Map<string, ScenarioResult>>();

  for (const scenario of scenarios) {
    const sourceVoltages = new Map<string, number>();
    for (const s of sources) {
      const sd = s.data as unknown as PowerSourceData;
      let v = sd.nominalVoltage;
      if (scenario === 'min' && sd.minVoltage != null && sd.minVoltage > 0) v = sd.minVoltage;
      if (scenario === 'max' && sd.maxVoltage != null && sd.maxVoltage > 0) v = sd.maxVoltage;
      sourceVoltages.set(s.id, v);
    }
    const { nodeResults, timeSeries } = runSingleScenario(nodes, edges, nodeMap, times, sourceVoltages);
    scenarioNodeResults.set(scenario, nodeResults);
    scenarioTimeSeries.push({ scenario, points: timeSeries });
  }

  const nomResults = scenarioNodeResults.get('nom')!;

  const nomSourceVoltagesOCV = new Map<string, number>();
  for (const s of sources) {
    const sd = s.data as unknown as PowerSourceData;
    nomSourceVoltagesOCV.set(s.id, sd.nominalVoltage);
  }

  const stateNodeMaps = new Map<string, Map<string, Node>>();
  for (const state of states) {
    const snm = new Map<string, Node>();
    for (const n of nodes) {
      const d = n.data as unknown as PowerNodeData;
      if (d.type === 'load' && state.loadSnapshots && state.loadSnapshots[n.id]) {
        const loadData = { ...state.loadSnapshots[n.id] } as Record<string, unknown>;
        if (state.enabledOverrides && n.id in state.enabledOverrides) {
          loadData.enabled = state.enabledOverrides[n.id];
        }
        snm.set(n.id, { ...n, data: loadData });
      } else if ((d.type === 'converter' || d.type === 'series') && state.enabledOverrides && n.id in state.enabledOverrides) {
        snm.set(n.id, { ...n, data: { ...n.data as Record<string, unknown>, enabled: state.enabledOverrides[n.id] } });
      } else {
        snm.set(n.id, n);
      }
    }
    stateNodeMaps.set(state.id, snm);
  }

  // Build OCV maps for each scenario
  const scenarioOCVMaps = new Map<VoltageScenario, Map<string, number>>();
  for (const scenario of scenarios) {
    const ocvMap = new Map<string, number>();
    for (const s of sources) {
      const sd = s.data as unknown as PowerSourceData;
      let v = sd.nominalVoltage;
      if (scenario === 'min' && sd.minVoltage != null && sd.minVoltage > 0) v = sd.minVoltage;
      if (scenario === 'max' && sd.maxVoltage != null && sd.maxVoltage > 0) v = sd.maxVoltage;
      ocvMap.set(s.id, v);
    }
    scenarioOCVMaps.set(scenario, ocvMap);
  }

  // Compute per-scenario, per-state terminal voltages (OCV - I*R)
  // Key: "scenario:stateId" -> source voltages map
  const scenarioStateSourceVoltages = new Map<string, Map<string, number>>();
  for (const scenario of scenarios) {
    const ocvMap = scenarioOCVMaps.get(scenario)!;
    for (const state of states) {
      const snm = stateNodeMaps.get(state.id)!;
      const sv = new Map(ocvMap);
      for (let iter = 0; iter < 5; iter++) {
        let maxDelta = 0;
        for (const s of sources) {
          const sd = s.data as unknown as PowerSourceData;
          const rInt = sd.internalResistance || 0;
          if (rInt <= 0) continue;
          const ocv = ocvMap.get(s.id) ?? sd.nominalVoltage;
          let avgCurrent = 0;
          const totalDur = times.length > 1 ? times[times.length - 1] - times[0] : 1;
          for (let ti = 0; ti < times.length; ti++) {
            const dt = ti < times.length - 1 ? times[ti + 1] - times[ti] : (times.length > 1 ? 0 : 1);
            avgCurrent += getNodeCurrentDraw(s.id, snm, edges, ti, times, sv, state.auxLoadOverrides) * dt;
          }
          avgCurrent = totalDur > 0 ? avgCurrent / totalDur : avgCurrent;
          const terminal = Math.max(0, ocv - avgCurrent * rInt);
          const prev = sv.get(s.id) ?? ocv;
          maxDelta = Math.max(maxDelta, Math.abs(terminal - prev));
          sv.set(s.id, terminal);
        }
        if (maxDelta < 1e-6) break;
      }
      scenarioStateSourceVoltages.set(`${scenario}:${state.id}`, sv);
    }
  }

  // Compute per-state time series for each scenario. Each state gets its own
  // timeline built from that state's load profiles so the period is correct.
  if (states.length > 1) {
    for (const sts of scenarioTimeSeries) {
      const statePoints: Record<string, TimeSeriesPoint[]> = {};
      for (const state of states) {
        const snm = stateNodeMaps.get(state.id)!;
        const sv = scenarioStateSourceVoltages.get(`${sts.scenario}:${state.id}`)
          ?? scenarioOCVMaps.get(sts.scenario)!;
        const ocvMap = scenarioOCVMaps.get(sts.scenario)!;
        const stateTimes = buildUnifiedTimeline(snm);
        const pts: TimeSeriesPoint[] = [];
        for (let ti = 0; ti < stateTimes.length; ti++) {
          let inputPower = 0;
          let inputCurrent = 0;
          let totalLoad = 0;
          for (const s of sources) {
            const sd = s.data as unknown as PowerSourceData;
            if (sd.type !== 'source') continue;
            const ocv = ocvMap.get(s.id) ?? sd.nominalVoltage;
            const cur = getNodeCurrentDraw(s.id, snm, edges, ti, stateTimes, sv, state.auxLoadOverrides);
            inputPower += cur * ocv;
            inputCurrent += cur;
          }
          snm.forEach((node, nid) => {
            const d = node.data as unknown as PowerNodeData;
            if (d.type === 'load') {
              const loadV = resolveInputVoltage(nid, snm, edges, sv);
              totalLoad += getLoadCurrent(d as LoadData, stateTimes[ti], loadV) * loadV;
            }
          });
          pts.push({ time: roundTime(stateTimes[ti]), inputPower, inputCurrent, totalLoad });
        }
        statePoints[state.id] = pts;
      }
      sts.statePoints = statePoints;
    }
  }

  // Compute which nodes are disabled. A node is disabled if it's off in
  // ALL states with fractionOfTime > 0. We use enabledOverrides from
  // powerStates as the source of truth (not the canvas node's enabled field,
  // which reflects whichever state the user is currently viewing).
  const disabledNodes = new Set<string>();
  function markDisabled(nid: string) {
    disabledNodes.add(nid);
    for (const childId of getChildren(nid, edges)) {
      markDisabled(childId);
    }
  }
  const meaningfulStates = states.filter(s => s.fractionOfTime > 0);
  for (const n of nodes) {
    const d = n.data as unknown as PowerNodeData;
    if (d.type !== 'series' && d.type !== 'converter' && d.type !== 'load') continue;

    const baseEnabled = (d as { enabled?: boolean }).enabled !== false;
    let enabledInAny = false;
    if (meaningfulStates.length > 0) {
      enabledInAny = meaningfulStates.some(s => {
        if (s.enabledOverrides && n.id in s.enabledOverrides) {
          return s.enabledOverrides[n.id] === true;
        }
        return baseEnabled;
      });
    } else {
      enabledInAny = baseEnabled;
    }

    if (!enabledInAny) {
      disabledNodes.add(n.id);
      for (const childId of getChildren(n.id, edges)) {
        markDisabled(childId);
      }
    }
  }

  // Run dynamic battery discharge simulations with state cycling
  const batteryDischargeSeries = new Map<string, BatteryTimeSeriesPoint[]>();
  const batteryDischargeResults = new Map<string, DischargeResult>();

  for (const s of sources) {
    const sd = s.data as unknown as PowerSourceData;
    if (sd.sourceMode !== 'battery') continue;
    const hasBatteryData = (sd.batteryMode || 'simple') === 'detailed'
      ? (sd.dischargeCurves || []).some(c => c.points.length > 0)
      : (sd.capacityAtTemps || []).length > 0;
    if (!hasBatteryData) continue;

    const stateSlices = states.map(st => ({
      nodeMap: stateNodeMaps.get(st.id)!,
      fractionOfTime: st.fractionOfTime,
      auxLoadOverrides: st.auxLoadOverrides,
    }));

    try {
      const result = simulateBatteryDischarge(s.id, sd, nodes, edges, nodeMap, times, stateSlices);
      batteryDischargeResults.set(s.id, result);
      if (result.dischargeSeries.length > 0) {
        batteryDischargeSeries.set(s.id, result.dischargeSeries);
      }
    } catch (err) {
      console.error('Battery discharge simulation error for', sd.label, err);
    }
  }

  // Determine which nodes are downstream of each battery source
  const batteryDescendants = new Map<string, Set<string>>();
  for (const [sourceId] of batteryDischargeResults) {
    const descendants = new Set<string>();
    const walk = (nid: string) => {
      descendants.add(nid);
      for (const childId of getChildren(nid, edges)) {
        walk(childId);
      }
    };
    walk(sourceId);
    batteryDescendants.set(sourceId, descendants);
  }

  const results: AnalysisResult[] = nodes.map(n => {
    const d = n.data as unknown as PowerNodeData;
    const nom = nomResults.get(n.id)!;
    // Check if this node is downstream of a battery with dynamic simulation
    let dynamicAvg: DischargePowerAccum | undefined;
    let dynamicLifetime: number | undefined;
    for (const [sourceId, dr] of batteryDischargeResults) {
      if (dr.lifetimeHours > 0 && batteryDescendants.get(sourceId)?.has(n.id)) {
        dynamicAvg = dr.nodeAvgPower.get(n.id);
        if (n.id === sourceId) {
          dynamicLifetime = dr.lifetimeHours;
        }
        break;
      }
    }

    // Compute per-scenario, per-state results and derive weighted-average
    // ScenarioResults from them (instead of using runSingleScenario's
    // canvas-only results).
    const scenarioStateResults: Partial<Record<VoltageScenario, Record<string, StateResult>>> = {};
    const allScenarios: Partial<Record<VoltageScenario, ScenarioResult>> = {};
    for (const scenario of scenarios) {
      const scStateRes: Record<string, StateResult> = {};
      let wIn = 0, wOut = 0;
      for (const state of states) {
        const snm = stateNodeMaps.get(state.id)!;
        const nodeData = snm.get(n.id)?.data as unknown as PowerNodeData ?? d;
        const sv = scenarioStateSourceVoltages.get(`${scenario}:${state.id}`) ?? scenarioOCVMaps.get(scenario)!;
        const sr = computeNodeStateResult(n.id, nodeData, snm, edges, times, sv, state.auxLoadOverrides);
        scStateRes[state.id] = sr;
        wIn += sr.inputPower * state.fractionOfTime;
        wOut += sr.outputPower * state.fractionOfTime;
      }
      scenarioStateResults[scenario] = scStateRes;
      allScenarios[scenario] = {
        inputPowerAvg: wIn,
        outputPowerAvg: wOut,
        powerLossAvg: Math.max(0, wIn - wOut),
        efficiencyAvg: wIn > 0 ? wOut / wIn : 1,
      };
    }

    // Use nominal scenario for the default stateResults
    const stateResults = scenarioStateResults['nom'] ?? {};
    let weightedInputPower = allScenarios['nom']?.inputPowerAvg ?? 0;
    let weightedOutputPower = allScenarios['nom']?.outputPowerAvg ?? 0;
    let weightedAuxPower = 0;
    let weightedCurrentOut = 0;
    let voltageOut = 0;

    for (const state of states) {
      const sr = stateResults[state.id];
      if (!sr) continue;
      weightedAuxPower += sr.auxPower * state.fractionOfTime;
      weightedCurrentOut += sr.currentOut * state.fractionOfTime;
      voltageOut += sr.voltageOut * state.fractionOfTime;
    }

    // Override with dynamic battery averages if available
    if (dynamicAvg) {
      weightedInputPower = dynamicAvg.inputPower;
      weightedOutputPower = dynamicAvg.outputPower;
      weightedAuxPower = dynamicAvg.auxPower;
      weightedCurrentOut = dynamicAvg.current;
      voltageOut = dynamicAvg.voltageOut;
    }

    const powerLoss = Math.max(0, weightedInputPower - weightedOutputPower);
    const efficiency = weightedInputPower > 0 ? weightedOutputPower / weightedInputPower : 1;

    const batteryLifetimeHours = dynamicLifetime ?? nom.batteryLifetimeHours;

    return {
      nodeId: n.id, label: d.label, type: d.type,
      inputPowerAvg: weightedInputPower, outputPowerAvg: weightedOutputPower,
      auxPowerAvg: weightedAuxPower,
      powerLossAvg: powerLoss, efficiencyAvg: efficiency,
      voltageOut, currentOut: weightedCurrentOut,
      disabled: disabledNodes.has(n.id),
      batteryLifetimeHours,
      scenarios: allScenarios,
      stateResults,
      scenarioStateResults,
    };
  });

  // === Generate diagnostics ===
  try {
    const totalFrac = states.reduce((s, st) => s + st.fractionOfTime, 0);
    if (states.length > 1 && Math.abs(totalFrac - 1) > 0.01) {
      diagnostics.push({
        severity: 'warning',
        message: `Power state time fractions sum to ${(totalFrac * 100).toFixed(0)}% (should be 100%)`,
      });
    }

    for (const n of nodes) {
      const d = n.data as unknown as PowerNodeData;

      if (d.type !== 'source') {
        const parent = getParent(n.id, edges);
        if (!parent) {
          diagnostics.push({
            severity: 'warning',
            nodeId: n.id,
            nodeLabel: d.label,
            message: `"${d.label}" has no upstream connection`,
          });
        }
      }

      if (d.type === 'source') {
        const children = getChildren(n.id, edges);
        if (children.length === 0) {
          diagnostics.push({
            severity: 'info',
            nodeId: n.id,
            nodeLabel: d.label,
            message: `Source "${d.label}" has no downstream connections`,
          });
        }
      }

      if (d.type === 'source') {
        const sd = d as PowerSourceData;
        if (sd.sourceMode === 'battery') {
          const mode = sd.batteryMode || 'simple';
          if (mode === 'simple' && (!sd.capacityAtTemps || sd.capacityAtTemps.length === 0)) {
            diagnostics.push({
              severity: 'warning',
              nodeId: n.id,
              nodeLabel: sd.label,
              message: `Battery "${sd.label}" has no capacity defined`,
            });
          }
          if (mode === 'detailed' && (!sd.dischargeCurves || sd.dischargeCurves.every(c => c.points.length === 0))) {
            diagnostics.push({
              severity: 'warning',
              nodeId: n.id,
              nodeLabel: sd.label,
              message: `Battery "${sd.label}" has no discharge curves defined`,
            });
          }
        }
      }

      if (d.type === 'converter') {
        const cd = d as PowerConverterData;
        const effMode = cd.efficiencyMode ?? (cd.efficiencyCurves?.length ? 'curve' : 'flat');
        if (cd.converterType === 'switching' && effMode === 'curve' && (!cd.efficiencyCurves || cd.efficiencyCurves.length === 0)) {
          diagnostics.push({
            severity: 'warning',
            nodeId: n.id,
            nodeLabel: cd.label,
            message: `Converter "${cd.label}" is set to curve mode but has no efficiency curves`,
          });
        }
      }
    }

    const resultMap = new Map(results.map(res => [res.nodeId, res]));

    const parentMap = new Map<string, string>();
    for (const e of edges) parentMap.set(e.target, e.source);

    const isNodeOffInState = (nodeId: string, snm: Map<string, Node>): boolean => {
      const nd = snm.get(nodeId);
      if (!nd) return false;
      const dd = nd.data as unknown as PowerNodeData;
      if (dd.type === 'series' || dd.type === 'converter' || dd.type === 'load') {
        if ((dd as { enabled?: boolean }).enabled === false) return true;
      }
      const pid = parentMap.get(nodeId);
      if (pid) return isNodeOffInState(pid, snm);
      return false;
    };

    for (const scenario of scenarios) {
      const scenarioLabel = scenarios.length > 1 ? ` (${scenario.toUpperCase()} Vin)` : '';
      for (const state of states) {
        const stateLabel = states.length > 1 ? ` in "${state.name}"` : '';
        const snm = stateNodeMaps.get(state.id)!;

        for (const n of nodes) {
          const d = n.data as unknown as PowerNodeData;
          const r = resultMap.get(n.id);
          if (!r) continue;
          const sr = r.scenarioStateResults?.[scenario]?.[state.id];
          if (!sr) continue;

          if (isNodeOffInState(n.id, snm)) continue;

          const parentId = parentMap.get(n.id);
          const parentSr = parentId ? resultMap.get(parentId)?.scenarioStateResults?.[scenario]?.[state.id] : undefined;
          const inputV = parentSr?.voltageOut ?? 0;

          if (d.type === 'converter') {
            const cd = d as PowerConverterData;
            if (cd.converterType === 'ldo' && cd.enabled !== false && inputV > 0 && inputV < cd.outputVoltage) {
              const dropoutMv = (cd.outputVoltage - inputV) * 1000;
              diagnostics.push({
                severity: 'warning',
                nodeId: n.id,
                nodeLabel: cd.label,
                scenario: scenarios.length > 1 ? scenario : undefined,
                stateId: states.length > 1 ? state.id : undefined,
                message: `LDO "${cd.label}" is in dropout${scenarioLabel}${stateLabel} — Vin (${inputV.toFixed(2)}V) < Vout_set (${cd.outputVoltage}V), output tracking at ${inputV.toFixed(2)}V (${dropoutMv.toFixed(0)}mV short)`,
              });
            }

            if (cd.enabled !== false && cd.converterType === 'switching' && sr.efficiency < 0.70 && sr.inputPower > 1e-6) {
              diagnostics.push({
                severity: 'info',
                nodeId: n.id,
                nodeLabel: cd.label,
                scenario: scenarios.length > 1 ? scenario : undefined,
                stateId: states.length > 1 ? state.id : undefined,
                message: `Converter "${cd.label}" efficiency is ${(sr.efficiency * 100).toFixed(1)}%${scenarioLabel}${stateLabel}`,
              });
            }
          }

          if (d.type === 'series') {
            const sd = d as SeriesElementData;
            if (sd.enabled !== false && inputV > 0 && sr.voltageOut > 0) {
              const drop = inputV - sr.voltageOut;
              const dropPct = drop / inputV;
              if (dropPct > 0.10 && drop > 0.05) {
                diagnostics.push({
                  severity: 'warning',
                  nodeId: n.id,
                  nodeLabel: sd.label,
                  scenario: scenarios.length > 1 ? scenario : undefined,
                  stateId: states.length > 1 ? state.id : undefined,
                  message: `Series "${sd.label}" dropping ${(drop * 1000).toFixed(0)}mV (${(dropPct * 100).toFixed(0)}% of input)${scenarioLabel}${stateLabel}`,
                });
              }
            }
          }

          if ((d.type === 'load' || d.type === 'converter') && sr.voltageOut === 0) {
            diagnostics.push({
              severity: 'error',
              nodeId: n.id,
              nodeLabel: d.label,
              scenario: scenarios.length > 1 ? scenario : undefined,
              stateId: states.length > 1 ? state.id : undefined,
              message: `"${d.label}" is enabled but receiving 0V${scenarioLabel}${stateLabel}`,
            });
          }
        }
      }
    }
  } catch (e) {
    console.warn('Diagnostics generation failed:', e);
  }

  const seen = new Set<string>();
  const deduped: Diagnostic[] = [];
  for (const diag of diagnostics) {
    const key = `${diag.severity}|${diag.nodeId ?? ''}|${diag.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(diag);
    }
  }

  return { results, scenarioTimeSeries, batteryDischargeSeries, diagnostics: deduped };
}

function accumulateNodePower(
  nodeId: string, nodes: Map<string, Node>, edges: Edge[],
  timeIdx: number, allTimes: number[], dt: number,
  accum: Map<string, { inputPower: number; outputPower: number }>,
  sourceVoltages: Map<string, number>,
  auxOverrides?: Record<string, Record<string, boolean>>
) {
  const node = nodes.get(nodeId);
  if (!node) return;
  const data = node.data as unknown as PowerNodeData;
  const acc = accum.get(nodeId)!;
  const children = getChildren(nodeId, edges);

  if (data.type === 'load') {
    const loadV = resolveInputVoltage(nodeId, nodes, edges, sourceVoltages);
    const cur = getLoadCurrent(data as LoadData, allTimes[timeIdx], loadV);
    const power = cur * loadV;
    acc.inputPower += power * dt;
    acc.outputPower += power * dt;
    return;
  }

  if (data.type === 'series') {
    const sd = data as SeriesElementData;
    const current = getNodeCurrentDraw(nodeId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);
    const downstream = getSeriesChainPower(nodeId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);
    acc.inputPower += (downstream + getSeriesLoss(sd, current)) * dt;
    acc.outputPower += downstream * dt;
    for (const childId of children) {
      accumulateNodePower(childId, nodes, edges, timeIdx, allTimes, dt, accum, sourceVoltages, auxOverrides);
    }
    return;
  }

  let totalChildInputPower = 0;
  for (const childId of children) {
    const childNode = nodes.get(childId);
    if (!childNode) continue;
    const childData = childNode.data as unknown as PowerNodeData;
    const childCurrent = getNodeCurrentDraw(childId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);

    if (childData.type === 'series') {
      totalChildInputPower += getSeriesChainPower(childId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides) +
        getSeriesLoss(childData as SeriesElementData, childCurrent);
    } else {
      totalChildInputPower += childCurrent * getChildInputVoltage(childId, childData, nodes, edges, sourceVoltages);
    }
    accumulateNodePower(childId, nodes, edges, timeIdx, allTimes, dt, accum, sourceVoltages, auxOverrides);
  }

  if (data.type === 'source') {
    const sd = data as PowerSourceData;
    const sv = sourceVoltages.get(nodeId) ?? sd.nominalVoltage;
    const rInt = sd.internalResistance || 0;
    const current = getNodeCurrentDraw(nodeId, nodes, edges, timeIdx, allTimes, sourceVoltages, auxOverrides);
    const irLoss = current * current * rInt;
    const terminalPower = current * sv;
    acc.inputPower += (terminalPower + irLoss) * dt;
    acc.outputPower += terminalPower * dt;
  } else if (data.type === 'converter') {
    const cd = data as PowerConverterData;
    const inputVoltage = resolveInputVoltage(nodeId, nodes, edges, sourceVoltages);
    const actualOutV = cd.converterType === 'ldo' ? getLdoActualOutputVoltage(cd, inputVoltage) : cd.outputVoltage;
    const nodeAuxOv = auxOverrides?.[nodeId];
    const auxI = getAuxLoadCurrent(cd.auxLoads, actualOutV, nodeAuxOv);
    const auxP = auxI * actualOutV;
    const totalOut = totalChildInputPower + auxP;
    acc.inputPower += converterInputPower(cd, inputVoltage, totalOut) * dt;
    acc.outputPower += totalOut * dt;
  }
}
