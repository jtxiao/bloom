import { useState, useCallback, memo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceArea,
} from 'recharts';
import type { AnalysisResult, ScenarioTimeSeries, VoltageScenario, BatteryTimeSeriesPoint, PowerState } from '../types';

function pickTimeUnit(maxTime: number): { unit: string; scale: number } {
  if (maxTime <= 0) return { unit: 's', scale: 1 };
  if (maxTime < 0.001) return { unit: 'µs', scale: 1e6 };
  if (maxTime < 1) return { unit: 'ms', scale: 1e3 };
  return { unit: 's', scale: 1 };
}

interface ResultsPanelProps {
  results: AnalysisResult[];
  scenarioTimeSeries: ScenarioTimeSeries[];
  batteryDischargeSeries: Map<string, BatteryTimeSeriesPoint[]>;
  onClose: () => void;
  powerStates?: PowerState[];
  activeStateId?: string;
  theme?: 'dark' | 'light';
}

const PALETTE_COLORS = [
  '#C9504A', '#3578A0', '#4AA876', '#D4A24E',
  '#7B6F8A', '#8A6A5E', '#5A8A7A', '#A07850',
  '#6B7FA0', '#9A6878', '#5E8A5A', '#B0884A',
  '#7A6090', '#6A9A8A', '#A0785A', '#587A9A',
];

function paletteColor(index: number): string {
  return PALETTE_COLORS[index % PALETTE_COLORS.length];
}

/** Same shape as unified timeline points used in results charts */
type TimeSeriesChartRow = {
  time: number;
  inputPower: number;
  totalLoad: number;
  inputCurrent: number;
};

/**
 * When the series has more points than the chart can draw, uniform decimation
 * wipes narrow current spikes. Keep per-bucket min/max for input current and
 * input power (plus endpoints) so peaks and dips survive.
 */
function downsampleTimeSeriesKeepingExtrema<T extends TimeSeriesChartRow>(data: T[], maxPoints: number): T[] {
  if (data.length <= maxPoints) return data;
  const n = data.length;
  const interior = n - 2;
  const numBuckets = Math.max(1, Math.floor((maxPoints - 2) / 4));
  const picked = new Map<number, T>();
  const add = (i: number) => {
    const row = data[i];
    picked.set(row.time, row);
  };
  add(0);
  for (let b = 0; b < numBuckets; b++) {
    const start = 1 + Math.floor((b * interior) / numBuckets);
    const end = 1 + Math.floor(((b + 1) * interior) / numBuckets) - 1;
    if (start > end) continue;
    let minIc = start;
    let maxIc = start;
    let minIp = start;
    let maxIp = start;
    for (let j = start; j <= end; j++) {
      if (data[j].inputCurrent < data[minIc].inputCurrent) minIc = j;
      if (data[j].inputCurrent > data[maxIc].inputCurrent) maxIc = j;
      if (data[j].inputPower < data[minIp].inputPower) minIp = j;
      if (data[j].inputPower > data[maxIp].inputPower) maxIp = j;
    }
    const idxs = [minIc, maxIc, minIp, maxIp];
    for (const idx of idxs) add(idx);
  }
  add(n - 1);
  return [...picked.values()].sort((a, b) => a.time - b.time);
}

function formatPowerSigFigs(watts: number): string {
  const abs = Math.abs(watts);
  if (abs === 0) return '0 W';
  if (abs >= 1) return `${Number(watts.toPrecision(4))} W`;
  if (abs >= 0.001) return `${Number((watts * 1000).toPrecision(4))} mW`;
  return `${Number((watts * 1e6).toPrecision(4))} uW`;
}

function formatPowerMw(mw: number): string {
  const abs = Math.abs(mw);
  if (abs === 0) return '0 W';
  if (abs >= 1000) return `${Number((mw / 1000).toPrecision(4))} W`;
  if (abs >= 1) return `${Number(mw.toPrecision(4))} mW`;
  return `${Number((mw * 1000).toPrecision(4))} uW`;
}

const SCENARIO_COLORS: Record<VoltageScenario, string> = {
  min: '#D4A24E',
  nom: '#3578A0',
  max: '#C9504A',
};

function formatCurrentVal(amps: number): string {
  if (amps >= 1) return `${amps.toFixed(2)} A`;
  if (amps >= 0.001) return `${(amps * 1000).toFixed(1)} mA`;
  if (amps > 0) return `${(amps * 1e6).toFixed(0)} uA`;
  return '0 A';
}

function formatTime(hours: number): string {
  if (hours >= 8760) return `${(hours / 8760).toFixed(1)} yr`;
  if (hours >= 24) return `${(hours / 24).toFixed(1)} days`;
  return `${hours.toFixed(1)} hr`;
}

function ResultsPanel({ results, scenarioTimeSeries, batteryDischargeSeries, onClose, powerStates, activeStateId, theme = 'dark' }: ResultsPanelProps) {
  const tooltipStyle = theme === 'light'
    ? { background: '#FEFCF8', border: '1px solid #D5CEBC', borderRadius: 4 }
    : { background: '#1E222A', border: '1px solid #2A2E38', borderRadius: 4 };
  const tooltipLabelColor = theme === 'light' ? '#2C2A26' : '#D8DAE0';
  const gridColor = theme === 'light' ? '#D5CEBC' : '#2A2E38';
  const axisColor = theme === 'light' ? '#7A7568' : '#8B8F9A';
  const scenarios = scenarioTimeSeries.map(s => s.scenario);
  const hasMultiScenario = scenarios.length > 1;
  const [activeScenario, setActiveScenario] = useState<VoltageScenario>('nom');

  const states = powerStates ?? [];
  const hasMultiState = states.length > 1;
  const [viewStateId, setViewStateId] = useState<string | null>(null);
  const viewingState = viewStateId ?? null;

  const [zoomLeft, setZoomLeft] = useState<number | null>(null);
  const [zoomRight, setZoomRight] = useState<number | null>(null);
  const [zoomDomain, setZoomDomain] = useState<[number, number] | null>(null);
  const [dragging, setDragging] = useState(false);

  const onMouseDown = useCallback((e: { activeLabel?: string | number }) => {
    if (e?.activeLabel != null) {
      setZoomLeft(Number(e.activeLabel));
      setZoomRight(null);
      setDragging(true);
    }
  }, []);

  const onMouseMove = useCallback((e: { activeLabel?: string | number }) => {
    if (dragging && e?.activeLabel != null) {
      setZoomRight(Number(e.activeLabel));
    }
  }, [dragging]);

  const onMouseUp = useCallback(() => {
    if (zoomLeft != null && zoomRight != null && zoomLeft !== zoomRight) {
      const lo = Math.min(zoomLeft, zoomRight);
      const hi = Math.max(zoomLeft, zoomRight);
      if (hi - lo > 0) {
        setZoomDomain([lo, hi]);
      }
    }
    setZoomLeft(null);
    setZoomRight(null);
    setDragging(false);
  }, [zoomLeft, zoomRight]);

  const resetZoom = useCallback(() => {
    setZoomDomain(null);
    setZoomLeft(null);
    setZoomRight(null);
    setDragging(false);
  }, []);

  const getScenarioResults = (scenario: VoltageScenario) =>
    results.map(r => r.scenarios[scenario] || r.scenarios['nom']!);

  const activeResults = getScenarioResults(activeScenario);

  const getNodePower = (r: AnalysisResult, idx: number, field: 'inputPower' | 'outputPower' | 'powerLoss' | 'efficiency' | 'auxPower') => {
    if (viewingState) {
      // Use scenario-specific state results when available
      const scenarioStates = r.scenarioStateResults?.[activeScenario];
      const sr = scenarioStates?.[viewingState] ?? r.stateResults[viewingState];
      if (sr) {
        if (field === 'inputPower') return sr.inputPower;
        if (field === 'outputPower') return sr.outputPower;
        if (field === 'powerLoss') return sr.powerLoss;
        if (field === 'efficiency') return sr.efficiency;
        if (field === 'auxPower') return sr.auxPower ?? 0;
      }
    }
    const scenarioResult = activeResults[idx];
    if (field === 'inputPower') return scenarioResult?.inputPowerAvg ?? r.inputPowerAvg;
    if (field === 'outputPower') return scenarioResult?.outputPowerAvg ?? r.outputPowerAvg;
    if (field === 'powerLoss') return scenarioResult?.powerLossAvg ?? r.powerLossAvg;
    if (field === 'auxPower') return r.auxPowerAvg ?? 0;
    return scenarioResult?.efficiencyAvg ?? r.efficiencyAvg;
  };

  const totalInputPower = results
    .filter(r => r.type === 'source')
    .map((r, _i) => getNodePower(r, results.indexOf(r), 'inputPower'))
    .reduce((s, v) => s + v, 0);
  const totalLoadPower = results
    .filter(r => r.type === 'load')
    .map((r, _i) => getNodePower(r, results.indexOf(r), 'inputPower'))
    .reduce((s, v) => s + v, 0);
  const totalLoss = totalInputPower - totalLoadPower;
  const systemEfficiency = totalInputPower > 0 ? totalLoadPower / totalInputPower : 0;


  const pieDataAll: { name: string; value: number; category: 'loss' | 'aux' | 'load' }[] = [];
  results.forEach((r, i) => {
    const intrinsicLoss = parseFloat((getNodePower(r, i, 'powerLoss') * 1000).toFixed(2));
    if (intrinsicLoss > 0.01) {
      pieDataAll.push({ name: r.label, value: intrinsicLoss, category: 'loss' });
    }
    const auxPwr = parseFloat((getNodePower(r, i, 'auxPower') * 1000).toFixed(2));
    if (auxPwr > 0.01) {
      pieDataAll.push({ name: `${r.label} (aux)`, value: auxPwr, category: 'aux' });
    }
    if (r.type === 'load') {
      const loadPwr = parseFloat((getNodePower(r, i, 'inputPower') * 1000).toFixed(2));
      if (loadPwr > 0.01) {
        pieDataAll.push({ name: r.label, value: loadPwr, category: 'load' });
      }
    }
  });
  const pieTotal = pieDataAll.reduce((s, d) => s + d.value, 0);
  const pieDataBucketed: typeof pieDataAll = [];
  let otherValue = 0;
  for (const d of pieDataAll) {
    if (pieTotal > 0 && d.value / pieTotal < 0.05) {
      otherValue += d.value;
    } else {
      pieDataBucketed.push(d);
    }
  }
  if (otherValue > 0.01) {
    pieDataBucketed.push({ name: 'Other', value: parseFloat(otherValue.toFixed(2)), category: 'loss' });
  }
  const lossData = pieDataBucketed.map((d, i) => ({
    ...d,
    loss: d.value,
    color: paletteColor(i),
  }));

  const activeSts = scenarioTimeSeries.find(s => s.scenario === activeScenario)
    ?? scenarioTimeSeries.find(s => s.scenario === 'nom');
  const rawTimeSeries = (viewingState && activeSts?.statePoints?.[viewingState])
    ? activeSts.statePoints[viewingState]
    : activeSts?.points ?? [];

  let peakInputPower = 0;
  let peakInputCurrent = 0;
  for (const pt of rawTimeSeries) {
    if (pt.inputPower > peakInputPower) peakInputPower = pt.inputPower;
    if (pt.inputCurrent > peakInputCurrent) peakInputCurrent = pt.inputCurrent;
  }
  const showPeaks = rawTimeSeries.length > 1 && (!hasMultiState || viewingState);

  const activeTimeSeries = (() => {
    if (rawTimeSeries.length <= 2) return rawTimeSeries;
    const period = rawTimeSeries[rawTimeSeries.length - 1].time - rawTimeSeries[0].time;
    if (period <= 0) return rawTimeSeries;

    const twoCycles: typeof rawTimeSeries = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      const offset = cycle * period;
      for (const p of rawTimeSeries) {
        if (cycle === 1 && p === rawTimeSeries[rawTimeSeries.length - 1]) continue;
        twoCycles.push({ ...p, time: parseFloat((p.time + offset).toPrecision(10)) });
      }
    }
    const endTime = parseFloat((2 * period).toPrecision(10));
    const last = rawTimeSeries[rawTimeSeries.length - 1];
    twoCycles.push({ ...last, time: endTime });

    const MAX_DISPLAY = 4000;
    if (twoCycles.length <= MAX_DISPLAY) return twoCycles;

    const kept: typeof twoCycles = [twoCycles[0]];
    for (let i = 1; i < twoCycles.length; i++) {
      const prev = twoCycles[i - 1];
      const cur = twoCycles[i];
      const changed = Math.abs(cur.inputPower - prev.inputPower) > 1e-6
        || Math.abs(cur.totalLoad - prev.totalLoad) > 1e-6
        || Math.abs(cur.inputCurrent - prev.inputCurrent) > 1e-6;
      if (changed) {
        if (kept[kept.length - 1] !== prev) kept.push(prev);
        kept.push(cur);
      }
    }
    if (kept[kept.length - 1] !== twoCycles[twoCycles.length - 1]) {
      kept.push(twoCycles[twoCycles.length - 1]);
    }

    if (kept.length <= MAX_DISPLAY) return kept;
    return downsampleTimeSeriesKeepingExtrema(kept, MAX_DISPLAY);
  })();

  const timeMax = activeTimeSeries.length > 0 ? activeTimeSeries[activeTimeSeries.length - 1].time : 0;
  const { unit: timeUnit, scale: timeScale } = pickTimeUnit(timeMax);
  const scaledMax = parseFloat((timeMax * timeScale).toPrecision(10));

  const densified = (() => {
    if (activeTimeSeries.length <= 1) return activeTimeSeries;
    const TARGET_POINTS = 200;
    const totalSpan = timeMax - activeTimeSeries[0].time;
    if (totalSpan <= 0) return activeTimeSeries;
    const minStep = totalSpan / TARGET_POINTS;
    const result: typeof activeTimeSeries = [];
    for (let i = 0; i < activeTimeSeries.length; i++) {
      const cur = activeTimeSeries[i];
      result.push(cur);
      if (i < activeTimeSeries.length - 1) {
        const next = activeTimeSeries[i + 1];
        const gap = next.time - cur.time;
        if (gap > minStep * 1.5) {
          const fills = Math.min(Math.floor(gap / minStep), 20);
          for (let f = 1; f <= fills; f++) {
            result.push({ ...cur, time: parseFloat((cur.time + (gap * f) / (fills + 1)).toPrecision(10)) });
          }
        }
      }
    }
    return result;
  })();

  const chartTimeSeries = densified.map(t => ({
    ...t,
    timeScaled: parseFloat((t.time * timeScale).toPrecision(10)),
  }));

  const chartDomain: [number, number] = zoomDomain ?? [0, scaledMax];

  const timeTicks = (() => {
    const [lo, hi] = chartDomain;
    const span = hi - lo;
    if (span <= 0) return [lo];
    const niceIntervals = [
      0.001, 0.002, 0.005, 0.01, 0.02, 0.05,
      0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000,
    ];
    const targetTicks = 6;
    const rawStep = span / targetTicks;
    let step = niceIntervals.find(n => n >= rawStep) ?? rawStep;
    if (step <= 0) step = span / targetTicks;
    const start = Math.ceil(lo / step) * step;
    const ticks: number[] = [];
    for (let t = start; t <= hi + step * 0.01; t += step) {
      ticks.push(parseFloat(t.toPrecision(10)));
    }
    return ticks;
  })();

  return (
    <div className="results-panel">
      <div className="config-header">
        <h3>Analysis Results</h3>
        <button className="close-btn" onClick={onClose}>X</button>
      </div>

      {hasMultiScenario && (
        <div className="scenario-tabs">
          {scenarios.map(s => (
            <button
              key={s}
              className={`scenario-tab ${s === activeScenario ? 'active' : ''}`}
              style={s === activeScenario ? { borderColor: SCENARIO_COLORS[s] } : undefined}
              onClick={() => setActiveScenario(s)}
            >
              {s.toUpperCase()} Vin
            </button>
          ))}
        </div>
      )}

      {hasMultiState && (
        <div className="scenario-tabs">
          <button
            className={`scenario-tab ${viewingState === null ? 'active' : ''}`}
            onClick={() => setViewStateId(null)}
          >
            Weighted Avg
          </button>
          {states.map(s => (
            <button
              key={s.id}
              className={`scenario-tab ${viewingState === s.id ? 'active' : ''}`}
              onClick={() => setViewStateId(s.id)}
            >
              {s.name} ({Math.round(s.fractionOfTime * 100)}%)
            </button>
          ))}
        </div>
      )}

      <div className="results-summary">
        <div className="result-card">
          <div className="result-value">{formatPowerSigFigs(totalInputPower)}</div>
          <div className="result-label">Avg Input Power</div>
        </div>
        <div className="result-card">
          <div className="result-value">{formatPowerSigFigs(totalLoadPower)}</div>
          <div className="result-label">Avg Load Power</div>
        </div>
        <div className="result-card">
          <div className="result-value">{formatPowerSigFigs(totalLoss)}</div>
          <div className="result-label">Total Loss</div>
        </div>
        <div className="result-card">
          <div className="result-value">{(systemEfficiency * 100).toFixed(1)}%</div>
          <div className="result-label">System Efficiency</div>
        </div>
        {showPeaks && (
          <div className="result-card">
            <div className="result-value">{formatPowerSigFigs(peakInputPower)}</div>
            <div className="result-label">Peak Power</div>
          </div>
        )}
        {showPeaks && (
          <div className="result-card">
            <div className="result-value">{formatCurrentVal(peakInputCurrent)}</div>
            <div className="result-label">Peak Current</div>
          </div>
        )}
        {viewingState === null && results.filter(r => {
          return r.batteryLifetimeHours != null && r.batteryLifetimeHours > 0;
        }).map(r => (
            <div key={r.nodeId} className="result-card">
              <div className="result-value">{formatTime(r.batteryLifetimeHours!)}</div>
              <div className="result-label">{r.label} Lifetime</div>
            </div>
        ))}
      </div>

      {lossData.length > 0 && (
        <div className="chart-section">
          <h4>Power Distribution</h4>
          <div className="pie-chart-container">
            <svg viewBox="0 0 260 260" className="pie-svg">
              {(() => {
                const total = lossData.reduce((s, d) => s + d.loss, 0);
                if (total <= 0) return null;
                const cx = 130, cy = 130, outerR = 90, innerR = 45;
                let cumAngle = -Math.PI / 2;
                return lossData.map((d, i) => {
                  const angle = (d.loss / total) * 2 * Math.PI;
                  const startAngle = cumAngle;
                  const endAngle = cumAngle + angle;
                  cumAngle = endAngle;
                  const largeArc = angle > Math.PI ? 1 : 0;
                  const x1o = cx + outerR * Math.cos(startAngle);
                  const y1o = cy + outerR * Math.sin(startAngle);
                  const x2o = cx + outerR * Math.cos(endAngle);
                  const y2o = cy + outerR * Math.sin(endAngle);
                  const x1i = cx + innerR * Math.cos(endAngle);
                  const y1i = cy + innerR * Math.sin(endAngle);
                  const x2i = cx + innerR * Math.cos(startAngle);
                  const y2i = cy + innerR * Math.sin(startAngle);
                  const path = `M${x1o},${y1o} A${outerR},${outerR} 0 ${largeArc} 1 ${x2o},${y2o} L${x1i},${y1i} A${innerR},${innerR} 0 ${largeArc} 0 ${x2i},${y2i} Z`;
                  return (
                    <path key={i} d={path} fill={d.color} stroke="var(--surface)" strokeWidth={2}>
                      <title>{d.name}: {formatPowerMw(d.loss)}{d.category === 'load' ? '' : ' Loss'}</title>
                    </path>
                  );
                });
              })()}
            </svg>
            <div className="pie-legend">
              {lossData.map((d, i) => (
                <div key={i} className="pie-legend-item">
                  <span className="pie-legend-swatch" style={{ background: d.color }} />
                  <span className="pie-legend-label">{d.name}</span>
                  <span className="pie-legend-value">{formatPowerMw(d.loss)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTimeSeries.length > 1 && (!hasMultiState || viewingState) && (
        <div className="chart-section">
          <div className="chart-header">
            <h4>Power Over Time</h4>
            {zoomDomain && <button className="zoom-reset-btn" onClick={resetZoom}>Reset Zoom</button>}
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart
              data={chartTimeSeries.map(t => ({
                timeScaled: t.timeScaled,
                inputPower: parseFloat((t.inputPower * 1000).toFixed(2)),
                totalLoad: parseFloat((t.totalLoad * 1000).toFixed(2)),
              }))}
              margin={{ top: 10, right: 20, bottom: 40, left: 16 }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis dataKey="timeScaled" type="number" domain={chartDomain} ticks={timeTicks} tick={{ fill: axisColor, fontSize: 11 }} label={{ value: `Time (${timeUnit})`, position: 'bottom', offset: 0, fill: axisColor, fontSize: 11 }} allowDataOverflow />
              <YAxis tick={{ fill: axisColor, fontSize: 11 }} label={{ value: 'mW', angle: -90, position: 'insideLeft', offset: -4, fill: axisColor, fontSize: 11 }} />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: tooltipLabelColor }}
                labelFormatter={(v: number) => `${v} ${timeUnit}`}
              />
              <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11, paddingBottom: 4 }} />
              <Line type="stepAfter" dataKey="inputPower" name="Input Power (mW)" stroke="#3578A0" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="stepAfter" dataKey="totalLoad" name="Load Power (mW)" stroke="#4AA876" strokeWidth={2} dot={false} isAnimationActive={false} />
              {dragging && zoomLeft != null && zoomRight != null && (
                <ReferenceArea x1={zoomLeft} x2={zoomRight} strokeOpacity={0.3} fill={theme === 'light' ? '#3578A0' : '#3FA7D6'} fillOpacity={0.15} />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {activeTimeSeries.length > 1 && (!hasMultiState || viewingState) && (
        <div className="chart-section">
          <div className="chart-header">
            <h4>Input Current Over Time</h4>
            {zoomDomain && <button className="zoom-reset-btn" onClick={resetZoom}>Reset Zoom</button>}
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart
              data={chartTimeSeries.map(t => ({
                timeScaled: t.timeScaled,
                inputCurrent: parseFloat((t.inputCurrent * 1000).toFixed(2)),
              }))}
              margin={{ top: 10, right: 20, bottom: 24, left: 16 }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
              <XAxis dataKey="timeScaled" type="number" domain={chartDomain} ticks={timeTicks} tick={{ fill: axisColor, fontSize: 11 }} label={{ value: `Time (${timeUnit})`, position: 'insideBottom', offset: -14, fill: axisColor, fontSize: 11 }} allowDataOverflow />
              <YAxis tick={{ fill: axisColor, fontSize: 11 }} label={{ value: 'mA', angle: -90, position: 'insideLeft', offset: -4, fill: axisColor, fontSize: 11 }} />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: tooltipLabelColor }}
                labelFormatter={(v: number) => `${v} ${timeUnit}`}
              />
              <Line type="stepAfter" dataKey="inputCurrent" name="Input Current (mA)" stroke="#D4A24E" strokeWidth={2} dot={false} isAnimationActive={false} />
              {dragging && zoomLeft != null && zoomRight != null && (
                <ReferenceArea x1={zoomLeft} x2={zoomRight} strokeOpacity={0.3} fill={theme === 'light' ? '#3578A0' : '#3FA7D6'} fillOpacity={0.15} />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {Array.from(batteryDischargeSeries.entries()).map(([nodeId, series]) => {
        const nodeResult = results.find(r => r.nodeId === nodeId);
        const chartData = series.map(p => ({
          timeHours: parseFloat(p.timeHours.toFixed(2)),
          voltage: parseFloat(p.voltage.toFixed(3)),
          currentMa: parseFloat((p.current * 1000).toFixed(2)),
        }));
        return (
          <div key={nodeId}>
            <div className="chart-section">
              <h4>Battery Voltage: {nodeResult?.label ?? nodeId}</h4>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 24, left: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                  <XAxis dataKey="timeHours" tick={{ fill: axisColor, fontSize: 11 }}
                    label={{ value: 'Time (hr)', position: 'insideBottom', offset: -14, fill: axisColor, fontSize: 11 }} />
                  <YAxis tick={{ fill: axisColor, fontSize: 11 }}
                    label={{ value: 'V', angle: -90, position: 'insideLeft', offset: -4, fill: axisColor, fontSize: 11 }} domain={['auto', 'auto']} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelStyle={{ color: tooltipLabelColor }}
                    labelFormatter={(v: number) => `${v} hr`} />
                  <Line type="monotone" dataKey="voltage" name="Voltage (V)" stroke="#D4A24E" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="chart-section">
              <h4>Battery Current Draw: {nodeResult?.label ?? nodeId}</h4>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 24, left: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                  <XAxis dataKey="timeHours" tick={{ fill: axisColor, fontSize: 11 }}
                    label={{ value: 'Time (hr)', position: 'insideBottom', offset: -14, fill: axisColor, fontSize: 11 }} />
                  <YAxis tick={{ fill: axisColor, fontSize: 11 }}
                    label={{ value: 'mA', angle: -90, position: 'insideLeft', offset: -4, fill: axisColor, fontSize: 11 }} domain={['auto', 'auto']} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    labelStyle={{ color: tooltipLabelColor }}
                    labelFormatter={(v: number) => `${v} hr`} />
                  <Line type="monotone" dataKey="currentMa" name="Current (mA)" stroke="#5C7B8A" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        );
      })}

      <div className="node-details">
        <h4>Per-Node Breakdown{hasMultiScenario ? ` (${activeScenario.toUpperCase()} Vin)` : ''}{viewingState ? ` — ${states.find(s => s.id === viewingState)?.name ?? ''}` : hasMultiState ? ' — Weighted Avg' : ''}</h4>
        <table className="results-table">
          <thead>
            <tr>
              <th>Component</th>
              <th>Type</th>
              <th>Input</th>
              <th>Output</th>
              <th>Aux</th>
              <th>Loss</th>
              <th>Eff</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => {
              const isLoad = r.type === 'load';
              const isSource = r.type === 'source';
              const inp = getNodePower(r, i, 'inputPower');
              const auxVal = getNodePower(r, i, 'auxPower');
              return (
                <tr key={r.nodeId}>
                  <td>{r.label}</td>
                  <td><span className={`type-badge ${r.type}`}>{r.type}</span></td>
                  <td>{isLoad || isSource ? '—' : formatPowerSigFigs(inp)}</td>
                  <td>{isLoad ? '—' : formatPowerSigFigs(getNodePower(r, i, 'outputPower'))}</td>
                  <td>{auxVal > 0 ? formatPowerSigFigs(auxVal) : '—'}</td>
                  <td className="loss-cell">{isLoad ? formatPowerSigFigs(inp) : formatPowerSigFigs(getNodePower(r, i, 'powerLoss'))}</td>
                  <td>{isLoad ? '—' : `${(getNodePower(r, i, 'efficiency') * 100).toFixed(1)}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default memo(ResultsPanel);
