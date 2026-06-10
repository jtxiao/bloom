import type ExcelJS from 'exceljs';

/**
 * Reconstruct a project from an exported power-budget workbook by reading the
 * (possibly edited) cell VALUES on the Summary budget sheet — no embedded JSON.
 *
 * It rebuilds the tree topology (from row indentation), node types, and the
 * editable inputs (voltages, load currents, converter Iq, source/battery
 * values, aux loads). It also reads the "Efficiency Curves" and "Load Profiles"
 * tabs to restore converter efficiency curves and load current profiles / pulse
 * settings. Remaining simplifications: efficiency curves come back as a single
 * curve at the operating Vin (the export collapses the Vin dimension), profiles
 * are the condensed/downsampled version the export wrote, and the project is
 * rebuilt as a single state (multi-state snapshots and battery discharge curves
 * are not reconstructed).
 */

type CellVal = number | string | { formula?: string; result?: number | string } | null | undefined;

function numOf(v: CellVal): number {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') {
    const r = (v as { result?: number | string }).result;
    if (typeof r === 'number') return r;
    if (typeof r === 'string') { const n = parseFloat(r); return isNaN(n) ? NaN : n; }
  }
  if (typeof v === 'string') { const n = parseFloat(v); return isNaN(n) ? NaN : n; }
  return NaN;
}

function strOf(v: CellVal): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object') {
    const r = (v as { result?: number | string }).result;
    if (r != null) return String(r);
  }
  return '';
}

function formulaOf(v: CellVal): string {
  if (v && typeof v === 'object' && typeof (v as { formula?: string }).formula === 'string') {
    return (v as { formula: string }).formula;
  }
  return '';
}

interface ParsedNode {
  id: string;
  nodeType: 'source' | 'converter' | 'series' | 'load';
  label: string;
  depth: number;
  vout: number;
  iout: number;
  eff: number;
  effIsLdo: boolean;
  iq: number;
  loss: number;
  disabled: boolean;
  auxLoads: { id: string; label: string; mode: 'resistor' | 'fixed_current'; resistance: number; fixedCurrent: number }[];
}

interface BudgetCols { component: number; type: number; vout: number; iout: number; eff: number; loss: number; iq: number; notes: number; }

/** Parse one budget sheet's component rows (topology + per-node values). */
function parseSheetNodes(ws: ExcelJS.Worksheet, headerRow: number, col: BudgetCols): ParsedNode[] {
  const parsed: ParsedNode[] = [];
  let lastNode: ParsedNode | null = null;
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const rawComp = strOf(ws.getCell(r, col.component).value as CellVal);
    const typeStr = strOf(ws.getCell(r, col.type).value as CellVal).trim();
    const compTrim = rawComp.trim();
    if (compTrim === 'SYSTEM TOTAL') break;
    if (compTrim.startsWith('Subtotal')) continue;
    if (!typeStr) continue;

    if (typeStr === 'Aux') {
      if (!lastNode) continue;
      const label = compTrim.replace(/^\u21B3\s*/, '');
      const note = strOf(ws.getCell(r, col.notes).value as CellVal);
      const iout = numOf(ws.getCell(r, col.iout).value as CellVal);
      if (/resistor/i.test(note)) {
        const m = note.match(/([\d.]+)/);
        lastNode.auxLoads.push({ id: nextAuxId(), label, mode: 'resistor', resistance: m ? parseFloat(m[1]) : 0, fixedCurrent: 0 });
      } else {
        lastNode.auxLoads.push({ id: nextAuxId(), label, mode: 'fixed_current', resistance: 0, fixedCurrent: isNaN(iout) ? 0 : iout });
      }
      continue;
    }

    const t = typeStr.toLowerCase();
    if (t !== 'source' && t !== 'converter' && t !== 'series' && t !== 'load') continue;

    const leadingSpaces = rawComp.length - rawComp.replace(/^\s+/, '').length;
    const effCell = ws.getCell(r, col.eff).value as CellVal;
    const node: ParsedNode = {
      id: '',
      nodeType: t as ParsedNode['nodeType'],
      label: compTrim || `Node ${parsed.length + 1}`,
      depth: Math.round(leadingSpaces / 3),
      vout: numOf(ws.getCell(r, col.vout).value as CellVal) || 0,
      iout: numOf(ws.getCell(r, col.iout).value as CellVal) || 0,
      eff: numOf(effCell) || 0,
      effIsLdo: /MIN\(/i.test(formulaOf(effCell)),
      iq: numOf(ws.getCell(r, col.iq).value as CellVal) || 0,
      loss: numOf(ws.getCell(r, col.loss).value as CellVal) || 0,
      disabled: /disabled/i.test(strOf(ws.getCell(r, col.notes).value as CellVal)),
      auxLoads: [],
    };
    parsed.push(node);
    lastNode = node;
  }
  return parsed;
}

function colsFor(ws: ExcelJS.Worksheet, headerRow: number): BudgetCols {
  return {
    component: 1,
    type: columnIndex(ws, headerRow, 'Type'),
    vout: columnIndex(ws, headerRow, 'Vout (V)'),
    iout: columnIndex(ws, headerRow, 'Iout (A)'),
    eff: columnIndex(ws, headerRow, 'Eff'),
    loss: columnIndex(ws, headerRow, 'Loss (W)'),
    iq: columnIndex(ws, headerRow, 'Iq (A)'),
    notes: columnIndex(ws, headerRow, 'Notes'),
  };
}

let _impId = 0;
const nextId = () => `node_${++_impId}`;
const nextAuxId = () => `aux_${Date.now()}_${++_impId}`;

interface EffCurve { vin: number; points: { loadCurrent: number; efficiency: number }[]; }
type ProfileInfo =
  | { kind: 'profile'; points: { time: number; current: number }[] }
  | { kind: 'pulse'; baseline: number; peak: number; period: number; dutyCycle: number };

/** Read the "Efficiency Curves" tab into label -> effective curve at operating Vin. */
function parseEfficiencyTab(wb: ExcelJS.Workbook): Map<string, EffCurve> {
  const map = new Map<string, EffCurve>();
  const ws = wb.getWorksheet('Efficiency Curves');
  if (!ws) return map;
  let cur: { label: string; vin: number; points: EffCurve['points'] } | null = null;
  const flush = () => { if (cur && cur.points.length > 0) map.set(cur.label, { vin: cur.vin, points: cur.points }); cur = null; };
  for (let r = 1; r <= ws.rowCount; r++) {
    const aStr = strOf(ws.getCell(r, 1).value as CellVal);
    const header = aStr.match(/^(.*?)\s+\(Vin/);
    if (header) {
      flush();
      const vinM = aStr.match(/([\d.]+)\s*V\)/);
      cur = { label: header[1].trim(), vin: vinM ? parseFloat(vinM[1]) : 0, points: [] };
      continue;
    }
    if (aStr === 'Iout (A)') continue;
    if (cur) {
      const ia = numOf(ws.getCell(r, 1).value as CellVal);
      const ib = numOf(ws.getCell(r, 2).value as CellVal);
      if (!isNaN(ia) && !isNaN(ib)) cur.points.push({ loadCurrent: ia, efficiency: ib });
      else if (aStr === '') flush();
    }
  }
  flush();
  return map;
}

/** Read the "Load Profiles" tab into label -> profile points or pulse settings. */
function parseProfilesTab(wb: ExcelJS.Workbook): Map<string, ProfileInfo> {
  const map = new Map<string, ProfileInfo>();
  const ws = wb.getWorksheet('Load Profiles');
  if (!ws) return map;
  const FIELD_LABELS = new Set(['Baseline current (A)', 'Pulse current (A)', 'Period (s)', 'Pulse width (s)', 'Average current (A)', 'Time (s)', 'Current (A)', 'Duration (s)']);
  let pendingLabel = '';
  for (let r = 1; r <= ws.rowCount; r++) {
    const aStr = strOf(ws.getCell(r, 1).value as CellVal).trim();
    if (aStr === 'Baseline current (A)') {
      const baseline = numOf(ws.getCell(r, 2).value as CellVal) || 0;
      const peak = numOf(ws.getCell(r + 1, 2).value as CellVal) || 0;
      const period = numOf(ws.getCell(r + 2, 2).value as CellVal) || 0;
      const width = numOf(ws.getCell(r + 3, 2).value as CellVal) || 0;
      if (pendingLabel) map.set(pendingLabel, { kind: 'pulse', baseline, peak, period, dutyCycle: period > 0 ? width / period : 0 });
      r += 4;
      continue;
    }
    if (aStr === 'Time (s)') {
      const points: { time: number; current: number }[] = [];
      let k = r + 1;
      for (; k <= ws.rowCount; k++) {
        const t = numOf(ws.getCell(k, 1).value as CellVal);
        const i = numOf(ws.getCell(k, 2).value as CellVal);
        if (isNaN(t) || isNaN(i)) break;
        points.push({ time: t, current: i });
      }
      if (pendingLabel && points.length > 0) map.set(pendingLabel, { kind: 'profile', points });
      r = k - 1;
      continue;
    }
    if (aStr && !FIELD_LABELS.has(aStr) && isNaN(numOf(ws.getCell(r, 1).value as CellVal))) {
      pendingLabel = aStr;
    }
  }
  return map;
}

function findHeaderRow(ws: ExcelJS.Worksheet): number {
  for (let r = 1; r <= Math.min(ws.rowCount, 20); r++) {
    if (strOf(ws.getCell(r, 1).value as CellVal).trim() === 'Component') return r;
  }
  return -1;
}

function columnIndex(ws: ExcelJS.Worksheet, headerRow: number, name: string): number {
  for (let c = 1; c <= 14; c++) {
    if (strOf(ws.getCell(headerRow, c).value as CellVal).trim() === name) return c;
  }
  return -1;
}

export async function importProjectFromExcel(file: File): Promise<string> {
  _impId = 0;
  const ExcelJSRuntime = (await import('exceljs')).default;
  const wb = new ExcelJSRuntime.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());

  // Budget sheets (those with a Component header). The multi-state "Summary"
  // is duty-weighted FORMULAS (no values without recalc), so prefer the
  // per-state sheets, which carry the actual input values. Fall back to Summary
  // for single-state exports (its Summary holds real values).
  const budgetSheets = wb.worksheets
    .map(w => ({ ws: w, hr: findHeaderRow(w) }))
    .filter(x => x.hr > 0);
  if (budgetSheets.length === 0) throw new Error('No budget sheet found.');
  const stateSheets = budgetSheets.filter(x => x.ws.name !== 'Summary');
  const sourceSheets = stateSheets.length > 0 ? stateSheets : budgetSheets;
  const base = sourceSheets[0];
  const baseCols = colsFor(base.ws, base.hr);

  // Battery capacity / nominal V map.
  const batteryMap = new Map<string, { capacityMah: number; nominalV: number }>();
  const bt = wb.getWorksheet('Battery Life');
  if (bt) {
    for (let r = 3; r <= bt.rowCount; r++) {
      const label = strOf(bt.getCell(r, 1).value as CellVal).trim();
      if (!label) continue;
      batteryMap.set(label, {
        capacityMah: numOf(bt.getCell(r, 2).value as CellVal) || 0,
        nominalV: numOf(bt.getCell(r, 3).value as CellVal) || 0,
      });
    }
  }

  // Canonical node list + ids from the first per-state sheet.
  const canonical = parseSheetNodes(base.ws, base.hr, baseCols);
  if (canonical.length === 0) throw new Error('No component rows found in the budget sheet.');
  canonical.forEach(n => { n.id = nextId(); });

  // Edges from indentation: parent = nearest preceding node at depth-1.
  const lastIdAtDepth: Record<number, string> = {};
  const edges: { id: string; source: string; target: string; sourceHandle: string; targetHandle: string }[] = [];
  let edgeNum = 0;
  for (const n of canonical) {
    lastIdAtDepth[n.depth] = n.id;
    if (n.depth > 0 && lastIdAtDepth[n.depth - 1]) {
      edges.push({ id: `e_${++edgeNum}`, source: lastIdAtDepth[n.depth - 1], target: n.id, sourceHandle: 'source', targetHandle: 'target' });
    }
  }

  const effMap = parseEfficiencyTab(wb);
  const profileMap = parseProfilesTab(wb);

  // Tidy tree layout: x by depth (left->right), y so leaves stack and each
  // parent is centered on its children (avoids a diagonal cascade).
  const COL_W = 320, ROW_H = 110;
  const childrenMap = new Map<string, string[]>();
  for (const e of edges) {
    const arr = childrenMap.get(e.source) ?? [];
    arr.push(e.target);
    childrenMap.set(e.source, arr);
  }
  const yOf = new Map<string, number>();
  let nextLeafY = 80;
  const assignY = (id: string): number => {
    if (yOf.has(id)) return yOf.get(id)!;
    const kids = childrenMap.get(id) ?? [];
    let y: number;
    if (kids.length === 0) { y = nextLeafY; nextLeafY += ROW_H; }
    else {
      const ys = kids.map(assignY);
      y = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
    yOf.set(id, y);
    return y;
  };
  const hasParent = new Set(edges.map(e => e.target));
  for (const n of canonical) if (!hasParent.has(n.id)) assignY(n.id);
  for (const n of canonical) if (!yOf.has(n.id)) assignY(n.id); // any stragglers

  const nodes = canonical.map(n => ({
    id: n.id,
    type: 'powerNode',
    position: { x: 80 + n.depth * COL_W, y: yOf.get(n.id) ?? 80 },
    data: buildNodeData(n, batteryMap, effMap, profileMap),
  }));

  // Reconstruct power states from each per-state sheet (or one state if single).
  const powerStates = sourceSheets.map((s, si) => {
    const cols = colsFor(s.ws, s.hr);
    const rows = parseSheetNodes(s.ws, s.hr, cols);
    const subtitle = strOf(s.ws.getCell(2, 1).value as CellVal);
    const dutyM = subtitle.match(/\(([\d.]+)%\s*duty\)/);
    const frac = dutyM ? parseFloat(dutyM[1]) / 100 : (1 / sourceSheets.length);
    const stateName = stateSheets.length > 0 ? s.ws.name : (strOf(s.ws.getCell(2, 1).value as CellVal).match(/"([^"]+)"/)?.[1] || 'Operating');

    const loadSnapshots: Record<string, unknown> = {};
    const enabledOverrides: Record<string, boolean> = {};
    canonical.forEach((cn, i) => {
      const rv = rows[i] ?? cn; // aligned by identical layout
      if (cn.nodeType === 'load') {
        const baseData = nodes[i].data as Record<string, unknown>;
        loadSnapshots[cn.id] = {
          ...baseData,
          voltage: rv.vout || (baseData.voltage as number) || 0,
          fixedCurrent: rv.iout || 0,
          enabled: !rv.disabled,
        };
      }
      if (cn.nodeType === 'converter' || cn.nodeType === 'series' || cn.nodeType === 'load') {
        enabledOverrides[cn.id] = !rv.disabled;
      }
    });

    return {
      id: stateSheets.length > 0 ? (s.ws.name || `state_${si}`) : 'operating',
      name: stateName,
      fractionOfTime: frac,
      loadSnapshots,
      enabledOverrides,
    };
  });

  const projectName = (strOf(base.ws.getCell(1, 1).value as CellVal).replace(/ —.*$/, '').trim()) || 'Imported project';

  const project = {
    version: 4,
    projectName,
    notes: [],
    theme: 'light',
    activeScenario: 'nom',
    powerStates,
    nodes,
    edges,
  };
  return JSON.stringify(project, null, 2);
}

function buildNodeData(
  n: ParsedNode,
  batteryMap: Map<string, { capacityMah: number; nominalV: number }>,
  effMap: Map<string, EffCurve>,
  profileMap: Map<string, ProfileInfo>,
): Record<string, unknown> {
  const aux = n.auxLoads.length > 0 ? { auxLoads: n.auxLoads } : {};
  switch (n.nodeType) {
    case 'source': {
      const bat = batteryMap.get(n.label);
      const isBattery = !!bat;
      return {
        type: 'source',
        label: n.label,
        sourceMode: isBattery ? 'battery' : 'fixed',
        batteryMode: 'simple',
        nominalVoltage: n.vout || bat?.nominalV || 5,
        internalResistance: 0,
        capacityAtTemps: isBattery && bat ? [{ tempC: 25, capacityMah: bat.capacityMah }] : [],
        dischargeCurves: [],
        temperatureProfile: [],
        cutoffVoltage: 0,
        ...aux,
      };
    }
    case 'converter': {
      const curve = effMap.get(n.label);
      const hasCurve = !n.effIsLdo && curve && curve.points.length > 1;
      return {
        type: 'converter',
        label: n.label,
        converterType: n.effIsLdo ? 'ldo' : 'switching',
        outputVoltage: n.vout,
        quiescentCurrent: n.iq || 0,
        efficiencyMode: hasCurve ? 'curve' : 'flat',
        flatEfficiency: n.eff > 0 ? Math.min(1, n.eff) : 0.9,
        efficiencyCurves: hasCurve
          ? [{ inputVoltage: curve!.vin || n.vout, points: curve!.points }]
          : [],
        enabled: true,
        ...aux,
      };
    }
    case 'series': {
      const resistance = n.iout > 0 && n.loss > 0 ? n.loss / (n.iout * n.iout) : 0.05;
      return {
        type: 'series',
        label: n.label,
        seriesMode: 'resistor',
        resistance,
        forwardVoltage: 0,
        enabled: true,
        ...aux,
      };
    }
    case 'load':
    default: {
      const prof = profileMap.get(n.label);
      const base = {
        type: 'load',
        label: n.label,
        voltage: n.vout,
        resistance: n.vout > 0 && n.iout > 0 ? n.vout / n.iout : 100,
        fixedCurrent: n.iout || 0,
        loadProfile: [] as { time: number; current: number }[],
        enabled: true,
      };
      if (prof?.kind === 'profile') {
        return { ...base, loadMode: 'current_profile', loadProfile: prof.points };
      }
      if (prof?.kind === 'pulse') {
        return {
          ...base,
          loadMode: 'pulse_duty',
          pulseBaselineCurrent: prof.baseline,
          pulsePeakCurrent: prof.peak,
          pulsePeriodSeconds: prof.period,
          pulseDutyCycle: prof.dutyCycle,
        };
      }
      return { ...base, loadMode: 'fixed_current' };
    }
  }
}
