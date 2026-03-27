import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { PowerNodeData, PowerSourceData, PowerConverterData, LoadData, SeriesElementData, AnalysisResult, StateResult, VoltageScenario } from '../types';

function formatPower(watts: number): string {
  if (watts >= 1) return `${watts.toFixed(2)} W`;
  if (watts >= 0.001) return `${(watts * 1000).toFixed(1)} mW`;
  return `${(watts * 1e6).toFixed(0)} uW`;
}

function formatCurrent(amps: number): string {
  if (amps >= 1) return `${amps.toFixed(2)} A`;
  if (amps >= 0.001) return `${(amps * 1000).toFixed(1)} mA`;
  return `${(amps * 1e6).toFixed(0)} uA`;
}

function formatTime(hours: number): string {
  if (hours >= 8760) return `${(hours / 8760).toFixed(1)} yr`;
  if (hours >= 24) return `${(hours / 24).toFixed(1)} days`;
  return `${hours.toFixed(1)} hr`;
}

function AnalysisBadge({ analysis, activeStateId, activeScenario }: { analysis: AnalysisResult; activeStateId?: string; activeScenario?: VoltageScenario }) {
  const scenarioStates = activeScenario ? analysis.scenarioStateResults?.[activeScenario] : undefined;
  const sr: StateResult | undefined = activeStateId
    ? (scenarioStates?.[activeStateId] ?? analysis.stateResults?.[activeStateId])
    : undefined;
  const inputP = sr?.inputPower ?? analysis.inputPowerAvg;
  const outputP = sr?.outputPower ?? analysis.outputPowerAvg;
  const auxP = sr?.auxPower ?? analysis.auxPowerAvg ?? 0;
  const lossP = sr?.powerLoss ?? analysis.powerLossAvg;
  const eff = sr?.efficiency ?? analysis.efficiencyAvg;

  return (
    <div className="analysis-badge">
      <div className="analysis-row">
        <span className="analysis-label">In</span>
        <span className="analysis-val">{formatPower(inputP)}</span>
      </div>
      {analysis.type !== 'load' && outputP > 0.0000001 && (
        <div className="analysis-row">
          <span className="analysis-label">Out</span>
          <span className="analysis-val">{formatPower(outputP)}</span>
        </div>
      )}
      {auxP > 0.0000001 && (
        <div className="analysis-row aux">
          <span className="analysis-label">Aux</span>
          <span className="analysis-val">{formatPower(auxP)}</span>
        </div>
      )}
      {lossP > 0.0000001 && (
        <div className="analysis-row loss">
          <span className="analysis-label">Loss</span>
          <span className="analysis-val">{formatPower(lossP)}</span>
        </div>
      )}
      {analysis.type === 'converter' && inputP > 0 && (
        <div className="analysis-row">
          <span className="analysis-label">Eff</span>
          <span className="analysis-val">{(eff * 100).toFixed(1)}%</span>
        </div>
      )}
      {analysis.batteryLifetimeHours != null && analysis.batteryLifetimeHours > 0 && (
        <div className="analysis-row battery-life">
          <span className="analysis-label">Life</span>
          <span className="analysis-val">{formatTime(analysis.batteryLifetimeHours)}</span>
        </div>
      )}
    </div>
  );
}

function thermalRGB(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  // Ramp using palette: accent purple → converter blue → series green → load gold → source red
  const stops: [number, number, number, number][] = [
    [0.0,  123, 111, 138],  // #7B6F8A accent
    [0.25,  53, 120, 160],  // #3578A0 converter blue
    [0.5,   74, 168, 118],  // #4AA876 series green
    [0.75, 212, 162,  78],  // #D4A24E load gold
    [1.0,  201,  80,  74],  // #C9504A source red
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    if (c <= stops[i + 1][0]) {
      const f = (c - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
      return [
        Math.round(stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f),
        Math.round(stops[i][2] + (stops[i + 1][2] - stops[i][2]) * f),
        Math.round(stops[i][3] + (stops[i + 1][3] - stops[i][3]) * f),
      ];
    }
  }
  return [201, 80, 74];
}

function heatmapStyle(intensity: number): React.CSSProperties {
  const mapped = intensity > 0 ? 0.08 + 0.92 * Math.pow(intensity, 0.35) : 0;
  const c = Math.max(0, Math.min(1, mapped));
  const [r, g, b] = thermalRGB(c);
  const innerSpread = 8 + 25 * c;
  const outerSpread = 18 + 40 * c;
  return {
    background: `rgba(${r}, ${g}, ${b}, ${0.18 + 0.35 * c})`,
    boxShadow: [
      `0 0 ${innerSpread}px ${innerSpread * 0.5}px rgba(${r}, ${g}, ${b}, ${0.35 + 0.4 * c})`,
      `0 0 ${outerSpread}px ${outerSpread * 0.6}px rgba(${r}, ${g}, ${b}, ${0.12 + 0.25 * c})`,
    ].join(', '),
    borderColor: `rgba(${r}, ${g}, ${b}, ${0.5 + 0.4 * c})`,
  };
}

function NoteTooltip({ notes }: { notes: string[] }) {
  if (!notes || notes.length === 0) return null;
  return (
    <div className="node-note-hover">
      <div className="node-note-tooltip">{notes.join('\n')}</div>
    </div>
  );
}

function PowerNode({ data }: { data: Record<string, unknown> }) {
  const d = data as unknown as PowerNodeData & { _analysis?: AnalysisResult; _activeStateId?: string; _activeScenario?: VoltageScenario; _heatmap?: boolean; _maxLoss?: number; _notes?: string[] };
  const analysis = d._analysis;
  const nodeNotes = d._notes;
  const activeStateId = d._activeStateId;
  const activeScenario = d._activeScenario;
  const showHeatmap = d._heatmap === true;
  const maxLoss = d._maxLoss ?? 0;
  const scenarioStates = activeScenario && analysis ? analysis.scenarioStateResults?.[activeScenario] : undefined;
  const stateRes = activeStateId && analysis
    ? (scenarioStates?.[activeStateId] ?? analysis.stateResults?.[activeStateId])
    : undefined;
  const displayVoltage = stateRes ? stateRes.voltageOut : analysis?.voltageOut ?? 0;
  const displayCurrent = stateRes ? stateRes.currentOut : analysis?.currentOut ?? 0;
  const isDisabled = analysis?.disabled === true;

  const heatValue = (() => {
    if (!analysis) return 0;
    if (d.type === 'load') {
      return stateRes ? (stateRes as { inputPower: number }).inputPower : analysis.inputPowerAvg;
    }
    const loss = stateRes ? (stateRes as { powerLoss: number }).powerLoss : analysis.powerLossAvg;
    const aux = stateRes ? ((stateRes as { auxPower?: number }).auxPower ?? 0) : (analysis.auxPowerAvg ?? 0);
    return loss + aux;
  })();
  const heatIntensity = showHeatmap && maxLoss > 0 ? heatValue / maxLoss : 0;
  const heatStyle = showHeatmap ? heatmapStyle(heatIntensity) : undefined;

  if (d.type === 'source') {
    const sd = d as PowerSourceData;
    const r = sd.internalResistance || 0;
    const isBattery = (sd.sourceMode || 'fixed') === 'battery';
    const voltageStr = [
      sd.minVoltage != null && sd.minVoltage > 0 ? `${sd.minVoltage}` : null,
      `${sd.nominalVoltage}`,
      sd.maxVoltage != null && sd.maxVoltage > 0 ? `${sd.maxVoltage}` : null,
    ].filter(Boolean).join(' / ');
    return (
      <div className="power-node source-node" style={heatStyle}>
        <div className="node-header source">{isBattery ? 'BATTERY' : 'SOURCE'}</div>
        <div className="node-body">
          <div className="node-label">{sd.label}</div>
          <div className="node-detail">{voltageStr}V</div>
          {r > 0 && <div className="node-detail-sm">Ri: {r >= 1 ? `${r.toFixed(1)} ohm` : `${(r * 1000).toFixed(0)} mohm`}</div>}
          {r > 0 && displayVoltage > 0 && !isDisabled && <div className="node-detail-sm">Vout: {displayVoltage.toFixed(2)}V</div>}
          {isBattery && (() => {
            const mode = sd.batteryMode || 'simple';
            let nomCap = 0;
            if (mode === 'simple' && sd.capacityAtTemps && sd.capacityAtTemps.length > 0) {
              nomCap = sd.capacityAtTemps.reduce((s, c) => s + c.capacityMah, 0) / sd.capacityAtTemps.length;
            } else if (mode === 'detailed' && sd.dischargeCurves && sd.dischargeCurves.length > 0) {
              for (const c of sd.dischargeCurves) {
                if (c.points.length > 0) {
                  const max = Math.max(...c.points.map(p => p.capacityMah));
                  if (max > nomCap) nomCap = max;
                }
              }
            }
            if (nomCap <= 0) return null;
            return <div className="node-detail">{nomCap >= 1000 ? `${(nomCap / 1000).toFixed(1)} Ah` : `${nomCap.toFixed(0)} mAh`}</div>;
          })()}
        </div>
        {analysis && <AnalysisBadge analysis={analysis} activeStateId={activeStateId} activeScenario={activeScenario} />}
        {nodeNotes && <NoteTooltip notes={nodeNotes} />}
        <Handle type="source" position={Position.Right} id="source" />
      </div>
    );
  }

  if (d.type === 'converter') {
    const cd = d as PowerConverterData;
    const isEnabled = cd.enabled !== false;
    const iq = cd.quiescentCurrent || 0;
    const curveCount = cd.efficiencyCurves?.length ?? 0;
    return (
      <div className={`power-node converter-node ${isDisabled || !isEnabled ? 'node-disabled' : ''}`} style={heatStyle}>
        <div className={`node-header converter ${cd.converterType}`}>
          {cd.converterType.toUpperCase()}
          {!isEnabled && <span className="node-off-badge">OFF</span>}
        </div>
        <div className="node-body">
          <div className="node-label">{cd.label}</div>
          <div className="node-detail">{cd.outputVoltage}V</div>
          <div className="node-detail-sm">
            {cd.converterType === 'switching'
              ? `${curveCount} Vin curve${curveCount !== 1 ? 's' : ''}`
              : 'LDO (Vout/Vin)'
            }
            {iq > 0 && ` / Iq: ${(iq * 1e6).toFixed(0)}uA`}
          </div>
        </div>
        {!isDisabled && analysis && <AnalysisBadge analysis={analysis} activeStateId={activeStateId} activeScenario={activeScenario} />}
        {nodeNotes && <NoteTooltip notes={nodeNotes} />}
        <Handle type="target" position={Position.Left} id="target" />
        <Handle type="source" position={Position.Right} id="source" />
      </div>
    );
  }

  if (d.type === 'series') {
    const sd = d as SeriesElementData;
    const isEnabled = sd.enabled !== false;
    let detail: string;
    if (sd.seriesMode === 'diode') {
      detail = `Vf: ${((sd.forwardVoltage || 0) * 1000).toFixed(0)} mV`;
    } else {
      const r = sd.resistance || 0;
      detail = r >= 1 ? `${r.toFixed(2)} ohm` : `${(r * 1000).toFixed(1)} mohm`;
    }
    return (
      <div className={`power-node series-node ${!isEnabled ? 'node-disabled' : ''}`} style={heatStyle}>
        <div className="node-header series">
          {sd.seriesMode === 'diode' ? 'DIODE' : 'SERIES'}
          {!isEnabled && <span className="node-off-badge">OFF</span>}
        </div>
        <div className="node-body">
          <div className="node-label">{sd.label}</div>
          <div className="node-detail">{detail}</div>
          {isEnabled && displayVoltage > 0 && (
            <div className="node-detail-sm">Vout: {displayVoltage.toFixed(2)}V</div>
          )}
          {isEnabled && displayCurrent > 0 && (() => {
            const vdrop = sd.seriesMode === 'diode'
              ? (sd.forwardVoltage || 0)
              : displayCurrent * (sd.resistance || 0);
            if (vdrop < 0.0001) return null;
            return <div className="node-detail-sm">Vdrop: {vdrop >= 0.1 ? `${vdrop.toFixed(2)}V` : `${(vdrop * 1000).toFixed(1)}mV`}</div>;
          })()}
        </div>
        {isEnabled && analysis && <AnalysisBadge analysis={analysis} activeStateId={activeStateId} activeScenario={activeScenario} />}
        {nodeNotes && <NoteTooltip notes={nodeNotes} />}
        <Handle type="target" position={Position.Left} id="target" />
        <Handle type="source" position={Position.Right} id="source" />
      </div>
    );
  }

  if (d.type === 'load') {
    const ld = d as LoadData;
    const isEnabled = ld.enabled !== false;
    let detail: string;
    if (ld.loadMode === 'resistor') {
      detail = ld.resistance >= 1000
        ? `${(ld.resistance / 1000).toFixed(1)} kohm`
        : `${ld.resistance.toFixed(1)} ohm`;
    } else if (ld.loadMode === 'fixed_current' || !ld.loadMode) {
      detail = (ld.fixedCurrent || 0) > 0 ? formatCurrent(ld.fixedCurrent || 0) : '--';
    } else {
      detail = displayCurrent > 0 ? `Avg: ${formatCurrent(displayCurrent)}` : '--';
    }
    return (
      <div className={`power-node load-node ${isDisabled || !isEnabled ? 'node-disabled' : ''}`} style={heatStyle}>
        <div className="node-header load">
          {ld.loadMode === 'resistor' ? 'RESISTOR' : 'LOAD'}
          {!isEnabled && <span className="node-off-badge">OFF</span>}
        </div>
        <div className="node-body">
          <div className="node-label">{ld.label}</div>
          {!isDisabled && displayVoltage > 0 && (
            <div className="node-detail">{displayVoltage.toFixed(2)}V</div>
          )}
          <div className="node-detail-sm">{detail}</div>
        </div>
        {!isDisabled && analysis && <AnalysisBadge analysis={analysis} activeStateId={activeStateId} activeScenario={activeScenario} />}
        {nodeNotes && <NoteTooltip notes={nodeNotes} />}
        <Handle type="target" position={Position.Left} id="target" />
      </div>
    );
  }

  return null;
}

const META_KEYS = new Set(['_analysis', '_activeStateId', '_activeScenario', '_heatmap', '_maxLoss', '_notes']);

function shallowEqualExceptMeta(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a).filter(k => !META_KEYS.has(k));
  const keysB = Object.keys(b).filter(k => !META_KEYS.has(k));
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

function powerNodePropsEqual(
  prev: { data: Record<string, unknown> },
  next: { data: Record<string, unknown> },
): boolean {
  const pa = prev.data as Record<string, unknown>;
  const na = next.data as Record<string, unknown>;
  if (pa === na) return true;
  if (pa._analysis !== na._analysis) return false;
  if (pa._activeStateId !== na._activeStateId) return false;
  if (pa._activeScenario !== na._activeScenario) return false;
  if (pa._heatmap !== na._heatmap) return false;
  if (pa._maxLoss !== na._maxLoss) return false;
  if (pa._notes !== na._notes) return false;
  return shallowEqualExceptMeta(pa, na);
}

export default memo(PowerNode, powerNodePropsEqual);
