import { useState, useEffect, useRef, useCallback, type ChangeEvent, type KeyboardEvent } from 'react';
import type { Node } from '@xyflow/react';
import Papa from 'papaparse';
import CsvImportWorker from '../workers/csvImportWorker?worker';
import Tooltip from './Tooltip';
import type {
  PowerNodeData,
  PowerSourceData,
  PowerConverterData,
  LoadData,
  SeriesElementData,
  EfficiencyPoint,
  LoadProfilePoint,
  DischargeCurvePoint,
  DischargeCurveAtTemp,
  CapacityAtTemp,
  XYPoint,
  AuxLoad,
} from '../types';
import GraphDigitizer from './GraphDigitizer';

interface ConfigPanelProps {
  node: Node;
  onUpdate: (id: string, data: PowerNodeData) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
  /** True when an upstream converter/series/load is off; blocks turning this node on until the rail is active. */
  upstreamAncestorsOff?: boolean;
  auxOverrides?: Record<string, boolean>;
  onAuxOverrideToggle?: (nodeId: string, auxId: string, enabled: boolean) => void;
}

function scrollConfigToBottom() {
  setTimeout(() => {
    document.querySelector('.config-body')?.scrollTo({ top: 99999, behavior: 'smooth' });
  }, 50);
}

const SI_SUFFIXES: Record<string, number> = {
  'p': 1e-12, 'n': 1e-9, 'u': 1e-6, 'µ': 1e-6,
  'm': 1e-3, 'k': 1e3, 'K': 1e3, 'M': 1e6, 'G': 1e9,
};

function parseSI(raw: string): { value: number; hasSuffix: boolean } {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-') return { value: NaN, hasSuffix: false };
  const match = trimmed.match(/^(-?\d*\.?\d+)\s*([pnuµmkKMG])?$/);
  if (!match) return { value: NaN, hasSuffix: false };
  const num = parseFloat(match[1]);
  const suffix = match[2];
  if (isNaN(num)) return { value: NaN, hasSuffix: false };
  return suffix
    ? { value: num * (SI_SUFFIXES[suffix] ?? 1), hasSuffix: true }
    : { value: num, hasSuffix: false };
}

/**
 * Compress a sorted load profile by merging consecutive samples that sit on the
 * same “plateau” vs the running group average: same sign (when both are
 * meaningful) and |values| within one order of magnitude. That collapses small
 * % wiggle on mA–A plateaus without using a fixed 20% band.
 * Strict local maxima (higher than both neighbors) are never averaged away.
 */
const COMPRESS_MAG_EPS = 1e-15;
const COMPRESS_DECADE = 10;
const COMPRESS_MAX_POINTS = 2000;

function isStrictLocalMaxRow(sorted: LoadProfilePoint[], i: number): boolean {
  const m = sorted.length;
  if (m < 2) return false;
  const c = sorted[i].current;
  const L = i > 0 ? sorted[i - 1].current : null;
  const R = i + 1 < m ? sorted[i + 1].current : null;
  if (L !== null && c <= L) return false;
  if (R !== null && c <= R) return false;
  return L !== null || R !== null;
}

function currentWithinOrderOfMagnitudeOfAverage(groupAvg: number, c: number): boolean {
  const ag = Math.abs(groupAvg);
  const ac = Math.abs(c);
  if (ag < COMPRESS_MAG_EPS && ac < COMPRESS_MAG_EPS) return true;
  if (groupAvg * c < 0 && ag >= COMPRESS_MAG_EPS && ac >= COMPRESS_MAG_EPS) return false;
  const lo = Math.min(ag, ac);
  const hi = Math.max(ag, ac);
  if (lo < COMPRESS_MAG_EPS) return hi < COMPRESS_DECADE * COMPRESS_MAG_EPS;
  return hi <= lo * COMPRESS_DECADE;
}

function compressLoadProfile(sorted: LoadProfilePoint[]): LoadProfilePoint[] {
  if (sorted.length <= COMPRESS_MAX_POINTS) return sorted;

  const out: LoadProfilePoint[] = [];
  const m = sorted.length;
  const lastT = sorted[m - 1].time;
  let i = 0;

  while (i < m) {
    if (isStrictLocalMaxRow(sorted, i)) {
      out.push({ time: sorted[i].time, current: sorted[i].current });
      i++;
      continue;
    }
    const segStart = i;
    let groupSum = sorted[i].current;
    let groupCount = 1;
    i++;
    while (i < m) {
      if (isStrictLocalMaxRow(sorted, i)) break;
      const groupAvg = groupSum / groupCount;
      if (!currentWithinOrderOfMagnitudeOfAverage(groupAvg, sorted[i].current)) break;
      groupSum += sorted[i].current;
      groupCount++;
      i++;
    }
    out.push({ time: sorted[segStart].time, current: groupSum / groupCount });
  }

  if (out[out.length - 1].time !== lastT) {
    out.push({ time: lastT, current: out[out.length - 1].current });
  }

  return out;
}

function allowSIInput(raw: string): boolean {
  return raw === '' || raw === '-' || /^-?\d*\.?\d*\s*[pnuµmkKMG]?$/.test(raw);
}

/** Enter in a field should push edits to the graph; exclude controls where Enter has another meaning. */
function shouldFlushConfigOnEnter(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('button')) return false;
  if (target.isContentEditable) return false;
  if (target.tagName === 'TEXTAREA') return false;
  if (target.tagName === 'SELECT') return true;
  if (target.tagName === 'INPUT') {
    const t = (target as HTMLInputElement).type;
    if (t === 'button' || t === 'submit' || t === 'reset' || t === 'checkbox' || t === 'radio' || t === 'file' || t === 'color') return false;
    return true;
  }
  return false;
}

interface NumInputProps {
  value: number;
  onChange: (v: number) => void;
  placeholder?: string;
  scale?: number;
}

function NumInput({ value, onChange, placeholder, scale = 1 }: NumInputProps) {
  const display = value * scale;
  const [local, setLocal] = useState(String(display));
  const committed = useRef(display);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const incoming = value * scale;
    if (incoming !== committed.current) {
      committed.current = incoming;
      setLocal(String(incoming));
    }
  }, [value, scale]);

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      placeholder={placeholder}
      value={local}
      onChange={e => {
        const raw = e.target.value;
        if (!allowSIInput(raw)) return;
        setLocal(raw);
      }}
      onKeyDown={e => { if (e.key === 'Enter') inputRef.current?.blur(); }}
      onBlur={() => {
        const { value: n, hasSuffix } = parseSI(local);
        if (isNaN(n) || local.trim() === '') {
          // Restore previous committed value instead of defaulting to 0
          setLocal(String(committed.current));
        } else {
          const baseVal = hasSuffix ? n : n / scale;
          const displayVal = baseVal * scale;
          if (committed.current !== displayVal) {
            committed.current = displayVal;
            onChange(baseVal);
          }
          setLocal(String(displayVal));
        }
      }}
    />
  );
}

function formatSI(value: number, unit: string): string {
  const abs = Math.abs(value);
  if (abs === 0) return `0 ${unit}`;
  if (abs >= 1e6) return `${parseFloat((value / 1e6).toPrecision(4))} M${unit}`;
  if (abs >= 1e3) return `${parseFloat((value / 1e3).toPrecision(4))} k${unit}`;
  if (abs >= 1) return `${parseFloat(value.toPrecision(4))} ${unit}`;
  if (abs >= 1e-3) return `${parseFloat((value * 1e3).toPrecision(4))} m${unit}`;
  if (abs >= 1e-6) return `${parseFloat((value * 1e6).toPrecision(4))} µ${unit}`;
  if (abs >= 1e-9) return `${parseFloat((value * 1e9).toPrecision(4))} n${unit}`;
  return `${parseFloat((value * 1e12).toPrecision(4))} p${unit}`;
}

function InlineNum({ value, onCommit, unit }: { value: number; onCommit: (v: number) => void; unit?: string }) {
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState(String(value));

  if (!editing) {
    const display = unit ? formatSI(value, unit) : parseFloat(value.toPrecision(6));
    return (
      <span className="inline-num" onClick={() => { setLocal(String(parseFloat(value.toPrecision(6)))); setEditing(true); }}>
        {display}
      </span>
    );
  }

  return (
    <input
      className="inline-num-input"
      type="text"
      inputMode="decimal"
      value={local}
      autoFocus
      onChange={e => {
        if (!allowSIInput(e.target.value)) return;
        setLocal(e.target.value);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const { value: n } = parseSI(local);
          if (!isNaN(n)) onCommit(n);
          setEditing(false);
        }
        if (e.key === 'Escape') setEditing(false);
      }}
      onBlur={() => {
        const { value: n } = parseSI(local);
        if (!isNaN(n)) onCommit(n);
        setEditing(false);
      }}
    />
  );
}

interface OptNumInputProps {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
}

function OptNumInput({ value, onChange, placeholder = '--' }: OptNumInputProps) {
  const [local, setLocal] = useState(value != null ? String(value) : '');
  const committed = useRef(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setLocal(value != null ? String(value) : '');
    }
  }, [value]);

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      placeholder={placeholder}
      value={local}
      onChange={e => {
        const raw = e.target.value;
        if (!allowSIInput(raw)) return;
        setLocal(raw);
        if (raw === '') {
          committed.current = undefined;
          onChange(undefined);
          return;
        }
        const { value: n } = parseSI(raw);
        if (!isNaN(n)) {
          committed.current = n;
          onChange(n);
        }
      }}
      onKeyDown={e => { if (e.key === 'Enter') inputRef.current?.blur(); }}
      onBlur={() => {
        if (local.trim() === '') {
          committed.current = undefined;
          onChange(undefined);
        } else {
          const { value: n } = parseSI(local);
          if (!isNaN(n) && n !== committed.current) {
            committed.current = n;
            onChange(n);
            setLocal(String(n));
          } else if (!isNaN(n)) {
            setLocal(String(n));
          }
        }
      }}
    />
  );
}

export default function ConfigPanel({ node, onUpdate, onClose, onDelete, upstreamAncestorsOff = false, auxOverrides, onAuxOverrideToggle }: ConfigPanelProps) {
  const incoming = node.data as unknown as PowerNodeData;
  const [localData, setLocalData] = useState<PowerNodeData>(incoming);
  const localRef = useRef(localData);
  localRef.current = localData;

  const nodeIdRef = useRef(node.id);
  const dirtyRef = useRef(false);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  const originalSetLocalData = setLocalData;
  const setLocalDataTracked = useCallback((d: PowerNodeData | ((prev: PowerNodeData) => PowerNodeData)) => {
    dirtyRef.current = true;
    originalSetLocalData(d);
  }, [originalSetLocalData]);

  // Flush local edits to the real node data on unmount / close, but only if changed
  useEffect(() => () => {
    if (dirtyRef.current) {
      onUpdateRef.current(nodeIdRef.current, localRef.current);
    }
  }, []);

  const handleClose = () => {
    if (dirtyRef.current) {
      onUpdate(node.id, localData);
    }
    onClose();
  };

  const flushLocalToGraphAfterFieldCommit = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!dirtyRef.current) return;
        onUpdate(node.id, localRef.current);
        dirtyRef.current = false;
      });
    });
  }, [node.id, onUpdate]);

  const onConfigBodyKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
      if (!shouldFlushConfigOnEnter(e.target)) return;
      e.preventDefault();
      (e.target as HTMLElement).blur();
      flushLocalToGraphAfterFieldCommit();
    },
    [flushLocalToGraphAfterFieldCommit],
  );

  const data = localData;
  const hasAux = data.type === 'source' || data.type === 'converter' || data.type === 'series';

  return (
    <div className="config-panel">
      <div className="config-header">
        <h3>Configure {data.type}</h3>
        <button className="close-btn" onClick={handleClose}>X</button>
      </div>
      <div className="config-body" onKeyDown={onConfigBodyKeyDown}>
        {data.type === 'source' && (
          <SourceConfig data={data} onChange={setLocalDataTracked} />
        )}
        {data.type === 'converter' && (
          <ConverterConfig data={data as PowerConverterData} onChange={setLocalDataTracked} upstreamAncestorsOff={upstreamAncestorsOff} />
        )}
        {data.type === 'series' && (
          <SeriesConfig data={data as SeriesElementData} onChange={setLocalDataTracked} upstreamAncestorsOff={upstreamAncestorsOff} />
        )}
        {data.type === 'load' && (
          <LoadConfig data={data as LoadData} onChange={setLocalDataTracked} upstreamAncestorsOff={upstreamAncestorsOff} />
        )}
        {hasAux && (
          <AuxLoadsSection
            auxLoads={(data as PowerSourceData | PowerConverterData | SeriesElementData).auxLoads || []}
            onChange={auxLoads => { dirtyRef.current = true; setLocalData({ ...data, auxLoads } as PowerNodeData); }}
            overrides={auxOverrides}
            onToggle={onAuxOverrideToggle ? (auxId, enabled) => onAuxOverrideToggle(node.id, auxId, enabled) : undefined}
          />
        )}
      </div>
      <div className="config-footer">
        <button className="delete-btn" onClick={() => onDelete(node.id)}>
          Delete Node
        </button>
      </div>
    </div>
  );
}

function SourceConfig({ data, onChange }: { data: PowerSourceData; onChange: (d: PowerSourceData) => void }) {
  const [newSliceTemp, setNewSliceTemp] = useState('');
  const [newSliceFrac, setNewSliceFrac] = useState('');
  const [newDcCap, setNewDcCap] = useState('');
  const [newDcV, setNewDcV] = useState('');
  const [newCurveTemp, setNewCurveTemp] = useState('');
  const [selectedCurveIdx, setSelectedCurveIdx] = useState(0);
  const [showDischargeDigitizer, setShowDischargeDigitizer] = useState(false);
  const [newSimpleTemp, setNewSimpleTemp] = useState('');
  const [newSimpleCap, setNewSimpleCap] = useState('');
  const [dupTempWarn, setDupTempWarn] = useState(false);

  // Reset local state when switching to a different source node
  const prevLabel = useRef(data.label);
  useEffect(() => {
    if (data.label !== prevLabel.current) {
      prevLabel.current = data.label;
      setSelectedCurveIdx(0);
      setNewSliceTemp('');
      setNewSliceFrac('');
      setNewDcCap('');
      setNewDcV('');
      setNewCurveTemp('');
      setNewSimpleTemp('');
      setNewSimpleCap('');
      setDupTempWarn(false);
    }
  }, [data.label]);

  const isBattery = (data.sourceMode || 'fixed') === 'battery';
  const batteryMode = data.batteryMode || 'simple';
  const curves: DischargeCurveAtTemp[] = data.dischargeCurves || [];
  const caps: CapacityAtTemp[] = data.capacityAtTemps || [];
  const temps = data.temperatureProfile || [];
  const activeCurve = curves[selectedCurveIdx] || null;

  // --- Detailed mode: per-temperature discharge curves ---
  const addTempCurve = () => {
    const tempC = parseSI(newCurveTemp).value;
    if (isNaN(tempC)) return;
    if (curves.some(c => c.tempC === tempC)) return;
    const updated = [...curves, { tempC, points: [] }].sort((a, b) => a.tempC - b.tempC);
    onChange({ ...data, dischargeCurves: updated });
    setSelectedCurveIdx(updated.findIndex(c => c.tempC === tempC));
    setNewCurveTemp('');
    scrollConfigToBottom();
  };

  const removeTempCurve = (idx: number) => {
    const updated = curves.filter((_, i) => i !== idx);
    onChange({ ...data, dischargeCurves: updated });
    setSelectedCurveIdx(Math.min(selectedCurveIdx, Math.max(0, updated.length - 1)));
  };

  const updateCurvePoints = (points: DischargeCurvePoint[]) => {
    const updated = curves.map((c, i) =>
      i === selectedCurveIdx ? { ...c, points: points.sort((a, b) => a.capacityMah - b.capacityMah) } : c
    );
    onChange({ ...data, dischargeCurves: updated });
  };

  const addDcPoint = () => {
    if (!activeCurve) return;
    const capacityMah = parseSI(newDcCap).value;
    const voltage = parseSI(newDcV).value;
    if (isNaN(capacityMah) || isNaN(voltage)) return;
    updateCurvePoints([...activeCurve.points, { capacityMah, voltage }]);
    setNewDcCap('');
    setNewDcV('');
    scrollConfigToBottom();
  };

  const removeDcPoint = (i: number) => {
    if (!activeCurve) return;
    updateCurvePoints(activeCurve.points.filter((_, idx) => idx !== i));
  };

  const handleDischargeDigitizer = (points: XYPoint[]) => {
    const dcPoints: DischargeCurvePoint[] = points.map(p => ({ capacityMah: p.x, voltage: p.y }));
    updateCurvePoints(dcPoints);
    setShowDischargeDigitizer(false);
  };

  const handleDischargeCsv = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      dynamicTyping: true,
      complete: (results) => {
        const points: DischargeCurvePoint[] = [];
        for (const row of results.data as Record<string, number>[]) {
          const cap = row['capacity'] ?? row['capacity_mah'] ?? row['mAh'] ?? row['Capacity (mAh)'];
          const v = row['voltage'] ?? row['v'] ?? row['Voltage (V)'];
          if (typeof cap === 'number' && typeof v === 'number') {
            points.push({ capacityMah: cap, voltage: v });
          }
        }
        if (points.length > 0) updateCurvePoints(points);
      },
    });
  };

  // --- Simple mode: capacity at each temperature ---
  const addSimpleCap = () => {
    const tempC = parseSI(newSimpleTemp).value;
    const capacityMah = parseSI(newSimpleCap).value;
    if (isNaN(tempC) || isNaN(capacityMah)) return;
    if (caps.some(c => c.tempC === tempC)) {
      setDupTempWarn(true);
      return;
    }
    setDupTempWarn(false);
    onChange({
      ...data,
      capacityAtTemps: [...caps, { tempC, capacityMah }].sort((a, b) => a.tempC - b.tempC),
    });
    setNewSimpleTemp('');
    setNewSimpleCap('');
    scrollConfigToBottom();
  };

  const removeSimpleCap = (i: number) => {
    onChange({ ...data, capacityAtTemps: caps.filter((_, idx) => idx !== i) });
  };

  // --- Temperature profile (shared by both modes) ---
  const addSlice = () => {
    const tempC = parseSI(newSliceTemp).value;
    const fractionOfTime = parseSI(newSliceFrac).value / 100;
    if (isNaN(tempC) || isNaN(fractionOfTime)) return;
    onChange({ ...data, temperatureProfile: [...temps, { tempC, fractionOfTime }] });
    setNewSliceTemp('');
    setNewSliceFrac('');
    scrollConfigToBottom();
  };

  const removeSlice = (i: number) => {
    onChange({ ...data, temperatureProfile: temps.filter((_, idx) => idx !== i) });
  };

  const totalFrac = temps.reduce((s, t) => s + t.fractionOfTime, 0);

  return (
    <div className="config-fields">
      <label>
        Label
        <input value={data.label} onChange={e => onChange({ ...data, label: e.target.value })} />
      </label>
      <label>
        Source Type
        <select value={data.sourceMode || 'fixed'}
          onChange={e => onChange({ ...data, sourceMode: e.target.value as 'fixed' | 'battery' })}>
          <option value="fixed">Fixed Supply</option>
          <option value="battery">Battery</option>
        </select>
      </label>

      <div className="voltage-group">
        <label>
          Nominal Voltage (V)
          <NumInput value={data.nominalVoltage} onChange={v => onChange({ ...data, nominalVoltage: v })} />
        </label>
        <div className="voltage-minmax">
          <label>
            Min (V)
            <OptNumInput value={data.minVoltage} onChange={v => onChange({ ...data, minVoltage: v })} />
          </label>
          <label>
            Max (V)
            <OptNumInput value={data.maxVoltage} onChange={v => onChange({ ...data, maxVoltage: v })} />
          </label>
        </div>
      </div>

      <label>
        Internal Resistance (mohm)
        <NumInput value={data.internalResistance || 0} scale={1000} onChange={v => onChange({ ...data, internalResistance: v })} />
      </label>

      {isBattery && (
        <>
          <label>
            Battery Model
            <select value={batteryMode}
              onChange={e => onChange({ ...data, batteryMode: e.target.value as 'simple' | 'detailed' })}>
              <option value="simple">Simple (Capacity per Temperature)</option>
              <option value="detailed">Detailed (Discharge Curves)</option>
            </select>
          </label>

          <label>
            Cutoff Voltage (V)
            <NumInput value={data.cutoffVoltage || 0} onChange={v => onChange({ ...data, cutoffVoltage: v })} />
          </label>

          {batteryMode === 'simple' && (
            <div className="eff-section">
              <h4>Capacity vs Temperature</h4>
              <span className="upload-hint">Nominal capacity at each temperature (uses source voltage)</span>
              <div className="eff-table">
                <div className="eff-row header">
                  <span>Temp (°C)</span>
                  <span>Capacity (mAh)</span>
                  <span></span>
                </div>
                {caps.map((c, i) => (
                  <div key={i} className="eff-row">
                    <InlineNum value={c.tempC} onCommit={v => {
                      const updated = caps.map((cap, j) => j === i ? { ...cap, tempC: v } : cap).sort((a, b) => a.tempC - b.tempC);
                      onChange({ ...data, capacityAtTemps: updated });
                    }} />
                    <InlineNum value={c.capacityMah} onCommit={v => {
                      const updated = caps.map((cap, j) => j === i ? { ...cap, capacityMah: v } : cap);
                      onChange({ ...data, capacityAtTemps: updated });
                    }} />
                    <button className="remove-btn" onClick={() => removeSimpleCap(i)}>X</button>
                  </div>
                ))}
              </div>
              <div className="eff-add">
                <input placeholder="Temp (°C)" type="text" inputMode="decimal" value={newSimpleTemp} onChange={e => { if (allowSIInput(e.target.value)) { setNewSimpleTemp(e.target.value); setDupTempWarn(false); } }} onKeyDown={e => e.key === 'Enter' && addSimpleCap()} />
                <input placeholder="mAh" type="text" inputMode="decimal" value={newSimpleCap} onChange={e => { if (allowSIInput(e.target.value)) setNewSimpleCap(e.target.value); }} onKeyDown={e => e.key === 'Enter' && addSimpleCap()} />
                <button onClick={addSimpleCap}>Add</button>
              </div>
              {dupTempWarn && <div className="upload-hint warn">A capacity is already defined at that temperature.</div>}
            </div>
          )}

          {batteryMode === 'detailed' && (
            <div className="eff-section">
              <h4>Discharge Curves by Temperature</h4>
              <span className="upload-hint">Separate voltage vs. capacity curve for each temperature</span>
              <div className="vin-tabs">
                {curves.map((c, i) => (
                  <div key={i} className={`vin-tab ${i === selectedCurveIdx ? 'active' : ''}`}>
                    <button className="vin-tab-btn" onClick={() => setSelectedCurveIdx(i)}>{c.tempC}°C</button>
                    <button className="vin-tab-remove" onClick={() => removeTempCurve(i)}>x</button>
                  </div>
                ))}
                <div className="vin-tab-add">
                  <input type="text" inputMode="decimal" placeholder="°C" value={newCurveTemp}
                    onChange={e => { if (allowSIInput(e.target.value)) setNewCurveTemp(e.target.value); }} onKeyDown={e => e.key === 'Enter' && addTempCurve()} />
                  <button onClick={addTempCurve}>+</button>
                </div>
              </div>

              {activeCurve && (
                <>
                  <div className="eff-upload">
                    <label className="file-label">
                      Upload CSV
                      <input type="file" accept=".csv" onChange={handleDischargeCsv} />
                    </label>
                    <button className="file-label" onClick={() => setShowDischargeDigitizer(true)}>
                      Extract from Screenshot
                    </button>
                    <span className="upload-hint">CSV: capacity (mAh), voltage (V)</span>
                  </div>
                  <div className="eff-table">
                    <div className="eff-row header">
                      <span>Capacity (mAh)</span>
                      <span>Voltage (V)</span>
                      <span></span>
                    </div>
                    {activeCurve.points.map((p, i) => (
                      <div key={i} className="eff-row">
                        <InlineNum value={p.capacityMah} onCommit={v => {
                          const pts = activeCurve.points.map((pt, j) => j === i ? { ...pt, capacityMah: v } : pt);
                          updateCurvePoints(pts);
                        }} />
                        <InlineNum value={p.voltage} onCommit={v => {
                          const pts = activeCurve.points.map((pt, j) => j === i ? { ...pt, voltage: v } : pt);
                          updateCurvePoints(pts);
                        }} />
                        <button className="remove-btn" onClick={() => removeDcPoint(i)}>X</button>
                      </div>
                    ))}
                  </div>
                  <div className="eff-add">
                    <input placeholder="mAh" type="text" inputMode="decimal" value={newDcCap} onChange={e => { if (allowSIInput(e.target.value)) setNewDcCap(e.target.value); }} onKeyDown={e => e.key === 'Enter' && addDcPoint()} />
                    <input placeholder="Voltage" type="text" inputMode="decimal" value={newDcV} onChange={e => { if (allowSIInput(e.target.value)) setNewDcV(e.target.value); }} onKeyDown={e => e.key === 'Enter' && addDcPoint()} />
                    <button onClick={addDcPoint}>Add</button>
                  </div>
                </>
              )}
              {curves.length === 0 && (
                <div className="upload-hint">Add a temperature tab to start defining discharge curves.</div>
              )}
            </div>
          )}

          <div className="eff-section">
            <h4>Operating Temperature Profile</h4>
            <span className="upload-hint">Time split between temperatures (should total 100%)</span>
            <div className="eff-table">
              <div className="eff-row header">
                <span>Temp (°C)</span>
                <span>Time (%)</span>
                <span></span>
              </div>
              {temps.map((t, i) => (
                <div key={i} className="eff-row">
                  <InlineNum value={t.tempC} onCommit={v => {
                    const updated = temps.map((s, j) => j === i ? { ...s, tempC: v } : s);
                    onChange({ ...data, temperatureProfile: updated });
                  }} />
                  <InlineNum value={t.fractionOfTime * 100} onCommit={v => {
                    const updated = temps.map((s, j) => j === i ? { ...s, fractionOfTime: v / 100 } : s);
                    onChange({ ...data, temperatureProfile: updated });
                  }} />
                  <button className="remove-btn" onClick={() => removeSlice(i)}>X</button>
                </div>
              ))}
            </div>
            {temps.length > 0 && (
              <div className={`upload-hint ${Math.abs(totalFrac - 1) > 0.01 ? 'warn' : ''}`}>
                Total: {(totalFrac * 100).toFixed(0)}%{Math.abs(totalFrac - 1) > 0.01 ? ' (should be 100%)' : ''}
              </div>
            )}
            <div className="eff-add">
              <input placeholder="Temp (°C)" type="text" inputMode="decimal" value={newSliceTemp} onChange={e => { if (allowSIInput(e.target.value)) setNewSliceTemp(e.target.value); }} onKeyDown={e => e.key === 'Enter' && addSlice()} />
              <input placeholder="Time (%)" type="text" inputMode="decimal" value={newSliceFrac} onChange={e => { if (allowSIInput(e.target.value)) setNewSliceFrac(e.target.value); }} onKeyDown={e => e.key === 'Enter' && addSlice()} />
              <button onClick={addSlice}>Add</button>
            </div>
          </div>

          {showDischargeDigitizer && (
            <GraphDigitizer
              title={`Extract Discharge Curve${activeCurve ? ` (${activeCurve.tempC}°C)` : ''}`}
              xAxisLabel="X-Axis (Capacity, mAh)"
              yAxisLabel="Y-Axis (Voltage, V)"
              defaultXMin="0"
              defaultXMax="1000"
              defaultYMin="2.5"
              defaultYMax="4.2"
              defaultXLog={false}
              onExtract={handleDischargeDigitizer}
              onClose={() => setShowDischargeDigitizer(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

function SeriesConfig({ data, onChange, upstreamAncestorsOff }: { data: SeriesElementData; onChange: (d: SeriesElementData) => void; upstreamAncestorsOff?: boolean }) {
  const enabled = data.enabled !== false;
  const blockTurnOn = !!upstreamAncestorsOff && !enabled;
  const enabledToggle = (
    <button
      type="button"
      className={`toggle-btn ${enabled ? 'on' : 'off'}`}
      disabled={blockTurnOn}
      onClick={() => onChange({ ...data, enabled: !enabled })}
    >
      {enabled ? 'ON' : 'OFF'}
    </button>
  );
  return (
    <div className="config-fields">
      <label>
        Label
        <input value={data.label} onChange={e => onChange({ ...data, label: e.target.value })} />
      </label>
      <label className="toggle-label">
        Enabled
        {blockTurnOn ? (
          <Tooltip text="Enable upstream converters or series elements on the path to the source before turning this on.">
            <span style={{ display: 'inline-block' }}>{enabledToggle}</span>
          </Tooltip>
        ) : enabledToggle}
      </label>
      <label>
        Mode
        <select value={data.seriesMode || 'resistor'}
          onChange={e => onChange({ ...data, seriesMode: e.target.value as 'resistor' | 'diode' })}>
          <option value="resistor">Resistor / FET (Rdson)</option>
          <option value="diode">Diode (Vf drop)</option>
        </select>
      </label>
      {(data.seriesMode || 'resistor') === 'resistor' ? (
        <label>
          Resistance / Rdson (mohm)
          <NumInput value={data.resistance || 0} scale={1000} onChange={v => onChange({ ...data, resistance: v })} />
        </label>
      ) : (
        <label>
          Forward Voltage Vf (mV)
          <NumInput value={data.forwardVoltage || 0} scale={1000} onChange={v => onChange({ ...data, forwardVoltage: v })} />
        </label>
      )}
    </div>
  );
}

function ConverterConfig({ data, onChange, upstreamAncestorsOff }: { data: PowerConverterData; onChange: (d: PowerConverterData) => void; upstreamAncestorsOff?: boolean }) {
  const effMode = data.efficiencyMode ?? (data.efficiencyCurves?.length ? 'curve' : 'flat');
  const curves = data.efficiencyCurves || [];
  const [selectedCurveIdx, setSelectedCurveIdx] = useState(0);
  const [newVin, setNewVin] = useState('');
  const [newLoad, setNewLoad] = useState('');
  const [newEff, setNewEff] = useState('');
  const [showDigitizer, setShowDigitizer] = useState(false);
  const [editingVinIdx, setEditingVinIdx] = useState<number | null>(null);
  const [editingVinVal, setEditingVinVal] = useState('');

  // Reset local state when switching to a different converter node
  const prevLabel = useRef(data.label);
  useEffect(() => {
    if (data.label !== prevLabel.current) {
      prevLabel.current = data.label;
      setSelectedCurveIdx(0);
      setNewVin('');
      setNewLoad('');
      setNewEff('');
      setEditingVinIdx(null);
    }
  }, [data.label]);

  // Clamp selectedCurveIdx if curves changed
  useEffect(() => {
    if (selectedCurveIdx >= curves.length && curves.length > 0) {
      setSelectedCurveIdx(curves.length - 1);
    }
  }, [curves.length, selectedCurveIdx]);

  const activeCurve = curves[selectedCurveIdx] || null;

  const addVinCurve = () => {
    const vin = parseSI(newVin).value;
    if (isNaN(vin) || vin <= 0) return;
    if (curves.some(c => c.inputVoltage === vin)) return;
    const updated = [...curves, { inputVoltage: vin, points: [] }].sort((a, b) => a.inputVoltage - b.inputVoltage);
    onChange({ ...data, efficiencyCurves: updated });
    setSelectedCurveIdx(updated.findIndex(c => c.inputVoltage === vin));
    setNewVin('');
    scrollConfigToBottom();
  };

  const removeVinCurve = (idx: number) => {
    const updated = curves.filter((_, i) => i !== idx);
    onChange({ ...data, efficiencyCurves: updated });
    setSelectedCurveIdx(Math.min(selectedCurveIdx, Math.max(0, updated.length - 1)));
  };

  const commitVinRename = () => {
    if (editingVinIdx === null) return;
    const newV = parseSI(editingVinVal).value;
    if (isNaN(newV) || newV <= 0) { setEditingVinIdx(null); return; }
    if (curves.some((c, i) => i !== editingVinIdx && c.inputVoltage === newV)) { setEditingVinIdx(null); return; }
    const updated = curves.map((c, i) => i === editingVinIdx ? { ...c, inputVoltage: newV } : c).sort((a, b) => a.inputVoltage - b.inputVoltage);
    onChange({ ...data, efficiencyCurves: updated });
    setSelectedCurveIdx(updated.findIndex(c => c.inputVoltage === newV));
    setEditingVinIdx(null);
  };

  const updateCurvePoints = (points: EfficiencyPoint[]) => {
    const updated = curves.map((c, i) =>
      i === selectedCurveIdx ? { ...c, points: points.sort((a, b) => a.loadCurrent - b.loadCurrent) } : c
    );
    onChange({ ...data, efficiencyCurves: updated });
  };

  const addEffPoint = () => {
    if (!activeCurve) return;
    const loadCurrent = parseSI(newLoad).value;
    const efficiency = parseSI(newEff).value / 100;
    if (isNaN(loadCurrent) || isNaN(efficiency)) return;
    updateCurvePoints([...activeCurve.points, { loadCurrent, efficiency }]);
    setNewLoad('');
    setNewEff('');
    scrollConfigToBottom();
  };

  const removeEffPoint = (idx: number) => {
    if (!activeCurve) return;
    updateCurvePoints(activeCurve.points.filter((_, i) => i !== idx));
  };

  const handleEfficiencyCsv = (e: ChangeEvent<HTMLInputElement>) => {
    if (!activeCurve) return;
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      dynamicTyping: true,
      complete: (results) => {
        const points: EfficiencyPoint[] = [];
        for (const row of results.data as Record<string, number>[]) {
          const loadCurrent = row['load_current'] ?? row['current'] ?? row['load'] ?? row['Load Current (A)'];
          const efficiency = row['efficiency'] ?? row['eff'] ?? row['Efficiency (%)'];
          if (typeof loadCurrent === 'number' && typeof efficiency === 'number') {
            points.push({ loadCurrent, efficiency: efficiency > 1 ? efficiency / 100 : efficiency });
          }
        }
        if (points.length > 0) updateCurvePoints(points);
      },
    });
  };

  const handleDigitizerExtract = (points: XYPoint[]) => {
    const effPoints: EfficiencyPoint[] = points.map(p => ({
      loadCurrent: p.x,
      efficiency: p.y > 1 ? p.y / 100 : p.y,
    }));
    updateCurvePoints(effPoints);
    setShowDigitizer(false);
  };

  const convEnabled = data.enabled !== false;
  const blockTurnOn = !!upstreamAncestorsOff && !convEnabled;
  const convToggle = (
    <button
      type="button"
      className={`toggle-btn ${convEnabled ? 'on' : 'off'}`}
      disabled={blockTurnOn}
      onClick={() => onChange({ ...data, enabled: !convEnabled })}
    >
      {convEnabled ? 'ON' : 'OFF'}
    </button>
  );
  return (
    <div className="config-fields">
      <label>
        Label
        <input value={data.label} onChange={e => onChange({ ...data, label: e.target.value })} />
      </label>
      <label className="toggle-label">
        Enabled
        {blockTurnOn ? (
          <Tooltip text="Enable upstream converters or series elements on the path to the source before turning this on.">
            <span style={{ display: 'inline-block' }}>{convToggle}</span>
          </Tooltip>
        ) : convToggle}
      </label>
      <label>
        Type
        <select value={data.converterType}
          onChange={e => onChange({ ...data, converterType: e.target.value as 'switching' | 'ldo' })}>
          <option value="switching">Switching</option>
          <option value="ldo">LDO</option>
        </select>
      </label>
      <label>
        Output Voltage (V)
        <NumInput value={data.outputVoltage} onChange={v => onChange({ ...data, outputVoltage: v })} />
      </label>
      <label>
        Quiescent Current (uA)
        <NumInput value={data.quiescentCurrent || 0} scale={1e6} onChange={v => onChange({ ...data, quiescentCurrent: v })} />
      </label>

      {data.converterType === 'ldo' && (
        <div className="ldo-eff-info">
          Efficiency = Vout / Vin
        </div>
      )}

      {data.converterType === 'switching' && (
        <div className="eff-section">
          <h4>Efficiency</h4>
          <label>
            Mode
            <select value={effMode} onChange={e => onChange({ ...data, efficiencyMode: e.target.value as 'flat' | 'curve' })}>
              <option value="flat">Flat</option>
              <option value="curve">Curve (vs. Load)</option>
            </select>
          </label>

          {effMode === 'flat' && (
            <label>
              Efficiency (%)
              <NumInput value={data.flatEfficiency ?? 0.85} scale={100} onChange={v => onChange({ ...data, flatEfficiency: Math.max(0, Math.min(1, v)) })} />
            </label>
          )}

          {effMode === 'curve' && (
            <>
              <div className="vin-tabs">
                {curves.map((c, i) => (
                  <div key={i} className={`vin-tab ${i === selectedCurveIdx ? 'active' : ''}`}>
                    {editingVinIdx === i ? (
                      <input
                        className="vin-tab-edit"
                        type="text"
                        inputMode="decimal"
                        autoFocus
                        value={editingVinVal}
                        onChange={e => { if (allowSIInput(e.target.value)) setEditingVinVal(e.target.value); }}
                        onKeyDown={e => { if (e.key === 'Enter') commitVinRename(); if (e.key === 'Escape') setEditingVinIdx(null); }}
                        onBlur={commitVinRename}
                      />
                    ) : (
                      <button className="vin-tab-btn" onClick={() => setSelectedCurveIdx(i)}
                        onDoubleClick={() => { setEditingVinIdx(i); setEditingVinVal(String(c.inputVoltage)); }}>
                        {c.inputVoltage}V
                      </button>
                    )}
                    <button className="vin-tab-remove" onClick={() => removeVinCurve(i)}>x</button>
                  </div>
                ))}
                <div className="vin-tab-add">
                  <input type="text" inputMode="decimal" placeholder="Vin" value={newVin}
                    onChange={e => { if (allowSIInput(e.target.value)) setNewVin(e.target.value); }} onKeyDown={e => e.key === 'Enter' && addVinCurve()} />
                  <button onClick={addVinCurve}>+</button>
                </div>
              </div>

              {activeCurve && (
                <>
                  <div className="eff-upload">
                    <label className="file-label">
                      Upload CSV
                      <input type="file" accept=".csv" onChange={handleEfficiencyCsv} />
                    </label>
                    <button className="file-label" onClick={() => setShowDigitizer(true)}>Extract from Screenshot</button>
                    <span className="upload-hint">CSV columns: load_current, efficiency</span>
                  </div>
                  <div className="eff-table">
                    <div className="eff-row header">
                      <span>Load (A)</span><span>Eff (%)</span><span></span>
                    </div>
                    {activeCurve.points.map((p, i) => (
                      <div key={i} className="eff-row">
                        <InlineNum value={p.loadCurrent} onCommit={v => {
                          const pts = activeCurve.points.map((pt, j) => j === i ? { ...pt, loadCurrent: v } : pt);
                          updateCurvePoints(pts);
                        }} />
                        <InlineNum value={p.efficiency * 100} onCommit={v => {
                          const pts = activeCurve.points.map((pt, j) => j === i ? { ...pt, efficiency: v / 100 } : pt);
                          updateCurvePoints(pts);
                        }} />
                        <button className="remove-btn" onClick={() => removeEffPoint(i)}>X</button>
                      </div>
                    ))}
                  </div>
                  <div className="eff-add">
                    <input placeholder="Load (A)" type="text" inputMode="decimal" value={newLoad} onChange={e => { if (allowSIInput(e.target.value)) setNewLoad(e.target.value); }} onKeyDown={e => e.key === 'Enter' && addEffPoint()} />
                    <input placeholder="Eff (%)" type="text" inputMode="decimal" value={newEff} onChange={e => { if (allowSIInput(e.target.value)) setNewEff(e.target.value); }} onKeyDown={e => e.key === 'Enter' && addEffPoint()} />
                    <button onClick={addEffPoint}>Add</button>
                  </div>
                </>
              )}
              {curves.length === 0 && (
                <div className="upload-hint">Add an input voltage tab to start defining efficiency curves.</div>
              )}
            </>
          )}
        </div>
      )}

      {showDigitizer && (
        <GraphDigitizer
          title="Extract Efficiency from Graph"
          xAxisLabel="X-Axis (Load Current, A)"
          yAxisLabel="Y-Axis (Efficiency, %)"
          defaultXMin="0.001"
          defaultXMax="1"
          defaultYMin="0"
          defaultYMax="100"
          defaultXLog={true}
          onExtract={handleDigitizerExtract}
          onClose={() => setShowDigitizer(false)}
        />
      )}
    </div>
  );
}

function LoadConfig({ data, onChange, upstreamAncestorsOff }: { data: LoadData; onChange: (d: LoadData) => void; upstreamAncestorsOff?: boolean }) {
  const [newTime, setNewTime] = useState('');
  const [newCurrent, setNewCurrent] = useState('');

  const addPoint = () => {
    const { value: time } = parseSI(newTime);
    const { value: currentVal, hasSuffix: currentHasSuffix } = parseSI(newCurrent);
    if (isNaN(time) || isNaN(currentVal)) return;
    const currentA = currentVal;
    onChange({ ...data, loadProfile: [...data.loadProfile, { time, current: currentA }].sort((a, b) => a.time - b.time) });
    setNewTime('');
    setNewCurrent('');
    scrollConfigToBottom();
  };

  const removePoint = (idx: number) => {
    onChange({ ...data, loadProfile: data.loadProfile.filter((_, i) => i !== idx) });
  };

  const updatePoint = (idx: number, field: 'time' | 'current', val: number) => {
    const updated = data.loadProfile.map((p, i) =>
      i === idx ? { ...p, [field]: val } : p
    ).sort((a, b) => a.time - b.time);
    onChange({ ...data, loadProfile: updated });
  };

  const [csvProgress, setCsvProgress] = useState<string | null>(null);
  const handleLoadCsv = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvProgress('Starting…');

    const worker = new CsvImportWorker();
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      if (msg.progress) {
        const est = msg.estRows != null ? ` / ~${Number(msg.estRows).toLocaleString()}` : '';
        setCsvProgress(`Importing… ${msg.rows.toLocaleString()}${est} rows (${msg.pct}% of file)`);
        return;
      }
      worker.terminate();
      if (msg.error) { setCsvProgress(null); return; }
      if (!msg.points?.length) { setCsvProgress(null); return; }
      const { points, rowCount, importStats } = msg as {
        points: unknown[];
        rowCount: number;
        importStats?: Record<string, unknown>;
      };
      console.log(
        `Load profile: ${Number(rowCount).toLocaleString()} CSV rows → ${points.length} points (bucketed segments, ≤2000)`,
      );
      if (importStats) {
        console.log('[CSV import] transient / bucket stats', importStats);
      }
      setCsvProgress(null);
      // Defer applying data so the browser can paint after worker + structured clone
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          onChange({ ...data, loadProfile: points });
        });
      });
    };
    worker.onerror = () => { worker.terminate(); setCsvProgress(null); };
    worker.postMessage(file);
  };


  const loadEnabled = data.enabled !== false;
  const blockTurnOn = !!upstreamAncestorsOff && !loadEnabled;
  const loadToggle = (
    <button
      type="button"
      className={`toggle-btn ${loadEnabled ? 'on' : 'off'}`}
      disabled={blockTurnOn}
      onClick={() => onChange({ ...data, enabled: !loadEnabled })}
    >
      {loadEnabled ? 'ON' : 'OFF'}
    </button>
  );
  return (
    <div className="config-fields">
      <label>
        Label
        <input value={data.label} onChange={e => onChange({ ...data, label: e.target.value })} />
      </label>
      <label className="toggle-label">
        Enabled
        {blockTurnOn ? (
          <Tooltip text="Enable upstream converters or series elements on the path to the source before turning this on.">
            <span style={{ display: 'inline-block' }}>{loadToggle}</span>
          </Tooltip>
        ) : loadToggle}
      </label>
      <label>
        Load Mode
        <select value={data.loadMode || 'current_profile'}
          onChange={e => onChange({ ...data, loadMode: e.target.value as 'current_profile' | 'resistor' | 'fixed_current' })}>
          <option value="fixed_current">Fixed Current</option>
          <option value="current_profile">Current Profile (vs Time)</option>
          <option value="resistor">Resistor (constant R)</option>
        </select>
      </label>

      {data.loadMode === 'resistor' ? (
        <label>
          Resistance (ohm)
          <NumInput value={data.resistance || 0} onChange={v => onChange({ ...data, resistance: v })} />
        </label>
      ) : data.loadMode === 'fixed_current' || (!data.loadMode) ? (
        <label>
          Current (A)
          <NumInput value={data.fixedCurrent || 0} onChange={v => onChange({ ...data, fixedCurrent: v })} />
        </label>
      ) : (() => {
        const sortedIdx = data.loadProfile
          .map((p, origIdx) => ({ p, origIdx }))
          .sort((a, b) => a.p.time - b.p.time);
        const period = sortedIdx.length > 0 ? sortedIdx[sortedIdx.length - 1].p.time : 0;
        return (
        <div className="eff-section">
          <h4>Load Profile (Current vs Time)</h4>
          <span className="upload-hint">Each row sets the current from its start time until the next row. The profile repeats periodically.</span>
          <div className="eff-upload">
            <label className="file-label">
              {csvProgress ? csvProgress : 'Upload CSV'}
              <input type="file" accept=".csv" onChange={handleLoadCsv} disabled={!!csvProgress} />
            </label>
            <span className="upload-hint">CSV with time &amp; current columns (instrument exports supported). Three-pass import: adaptive |ΔI| buckets and merge-protected steps (up to ~2000 points). Manual table compression merges plateaus when |I| stays within one decade of the running average (same sign when both are non-zero).</span>
          </div>
          <div className="eff-table">
            <div className="eff-row header" style={{ gridTemplateColumns: '1fr 1fr 1fr 28px' }}>
              <span>Start (s)</span><span>Dur</span><span>Current (A)</span><span></span>
            </div>
            {sortedIdx.map(({ p, origIdx }, i) => {
              const nextTime = i < sortedIdx.length - 1 ? sortedIdx[i + 1].p.time : period;
              const dur = nextTime - p.time;
              return (
              <div key={origIdx} className="eff-row" style={{ gridTemplateColumns: '1fr 1fr 1fr 28px' }}>
                <InlineNum value={p.time} onCommit={v => updatePoint(origIdx, 'time', v)} />
                <span className="dur-cell">{dur > 0 ? `${dur >= 1 ? dur.toFixed(2) + 's' : (dur * 1000).toFixed(0) + 'ms'}` : '--'}</span>
                <InlineNum value={p.current} onCommit={v => updatePoint(origIdx, 'current', v)} unit="A" />
                <button className="remove-btn" onClick={() => removePoint(origIdx)}>X</button>
              </div>
              );
            })}
          </div>
          {period > 0 && (
            <div className="upload-hint" style={{ marginTop: 4 }}>
              Period: {period >= 1 ? `${period.toFixed(2)}s` : `${(period * 1000).toFixed(1)}ms`} (repeats)
            </div>
          )}
          <div className="eff-add">
            <input placeholder="Start (s)" type="text" inputMode="decimal" value={newTime} onChange={e => { if (allowSIInput(e.target.value)) setNewTime(e.target.value); }} onKeyDown={e => e.key === 'Enter' && addPoint()} />
            <input placeholder="Current (A)" type="text" inputMode="decimal" value={newCurrent} onChange={e => { if (allowSIInput(e.target.value)) setNewCurrent(e.target.value); }} onKeyDown={e => e.key === 'Enter' && addPoint()} />
            <button onClick={addPoint}>Add</button>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

let auxIdCounter = 0;

function AuxLoadsSection({
  auxLoads,
  onChange,
  overrides,
  onToggle,
}: {
  auxLoads: AuxLoad[];
  onChange: (auxLoads: AuxLoad[]) => void;
  overrides?: Record<string, boolean>;
  onToggle?: (auxId: string, enabled: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(auxLoads.length > 0);

  const addAux = () => {
    const id = `aux_${Date.now()}_${auxIdCounter++}`;
    onChange([...auxLoads, { id, label: '', mode: 'resistor', resistance: 10000, fixedCurrent: 0.001 }]);
    setExpanded(true);
    scrollConfigToBottom();
  };

  const updateAux = (idx: number, patch: Partial<AuxLoad>) => {
    const updated = auxLoads.map((a, i) => i === idx ? { ...a, ...patch } : a);
    onChange(updated);
  };

  const removeAux = (idx: number) => {
    onChange(auxLoads.filter((_, i) => i !== idx));
  };

  return (
    <div className="aux-loads-section">
      <div className="aux-loads-header">
        {auxLoads.length > 0 && (
          <span className="aux-loads-toggle" onClick={() => setExpanded(!expanded)}>{expanded ? '\u25BE' : '\u25B8'}</span>
        )}
        <span className="aux-loads-title" onClick={() => auxLoads.length > 0 && setExpanded(!expanded)}>Auxiliary Loads{auxLoads.length > 0 ? ` (${auxLoads.length})` : ''}</span>
        <button className="aux-add-btn" onClick={addAux}>+ Add</button>
      </div>
      {expanded && auxLoads.length > 0 && (
        <div className="aux-loads-list">
          {auxLoads.map((al, i) => {
            const enabled = overrides ? overrides[al.id] !== false : true;
            return (
              <div key={al.id} className={`aux-load-row ${enabled ? '' : 'aux-disabled'}`}>
                <input
                  type="text"
                  className="aux-name"
                  placeholder="Name"
                  value={al.label}
                  onChange={e => updateAux(i, { label: e.target.value })}
                />
                <select
                  value={al.mode}
                  onChange={e => updateAux(i, { mode: e.target.value as 'resistor' | 'fixed_current' })}
                  className="aux-mode"
                >
                  <option value="resistor">R</option>
                  <option value="fixed_current">I</option>
                </select>
                {al.mode === 'resistor' ? (
                  <div className="aux-value-group">
                    <NumInput
                      value={al.resistance}
                      onChange={v => updateAux(i, { resistance: v })}
                      placeholder="ohms"
                    />
                    <span className="aux-unit">&Omega;</span>
                  </div>
                ) : (
                  <div className="aux-value-group">
                    <NumInput
                      value={al.fixedCurrent}
                      scale={1000}
                      onChange={v => updateAux(i, { fixedCurrent: v })}
                      placeholder="mA"
                    />
                    <span className="aux-unit">mA</span>
                  </div>
                )}
                {onToggle && (
                  <button
                    className={`aux-toggle ${enabled ? 'on' : 'off'}`}
                    onClick={() => onToggle(al.id, !enabled)}
                  >{enabled ? 'ON' : 'OFF'}</button>
                )}
                <Tooltip text="Remove this auxiliary load">
                  <button className="aux-remove" onClick={() => removeAux(i)}>X</button>
                </Tooltip>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
