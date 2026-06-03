import type ExcelJS from 'exceljs';
import type { Node, Edge } from '@xyflow/react';
import type {
  AnalysisResult,
  PowerNodeData,
  PowerConverterData,
  LoadData,
  EfficiencyCurveSet,
  EfficiencyPoint,
  PowerState,
  StateResult,
  VoltageScenario,
} from '../types';

export interface ExportExcelArgs {
  projectName: string;
  nodes: Node[];
  edges: Edge[];
  results: AnalysisResult[];
  powerStates: PowerState[];
  activeScenario: VoltageScenario;
}

/** Reduced per-node values used to fill one spreadsheet row. */
interface NodeMetrics {
  vout: number;
  ioutAvg: number;
  ioutPeak: number;
  efficiency: number;
  pin: number;
  pout: number;
  loss: number;
  aux: number;
  disabled: boolean;
}

// Column layout (1-indexed letters used directly in formulas).
const COL = {
  component: 'A',
  type: 'B',
  vin: 'C',
  vout: 'D',
  iout: 'E',
  efficiency: 'F',
  pout: 'G',
  pin: 'H',
  loss: 'I',
  iq: 'J',
  aux: 'K',
  notes: 'L',
} as const;

const HEADERS = [
  'Component',
  'Type',
  'Vin (V)',
  'Vout (V)',
  'Iout (A)',
  'Eff',
  'Pout (W)',
  'Pin (W)',
  'Loss (W)',
  'Iq (A)',
  'Aux (W)',
  'Notes',
];

function childrenOf(nodeId: string, edges: Edge[]): string[] {
  return edges.filter(e => e.source === nodeId).map(e => e.target);
}

function parentOf(nodeId: string, edges: Edge[]): string | null {
  const e = edges.find(ed => ed.target === nodeId);
  return e ? e.source : null;
}

// --- Efficiency curve interpolation (ported from engine/calculate.ts) ---
function interpEffJS(points: EfficiencyPoint[], load: number): number {
  if (points.length === 0) return 1;
  if (points.length === 1) return points[0].efficiency;
  const s = [...points].sort((a, b) => a.loadCurrent - b.loadCurrent);
  if (load <= s[0].loadCurrent) return s[0].efficiency;
  if (load >= s[s.length - 1].loadCurrent) return s[s.length - 1].efficiency;
  for (let i = 0; i < s.length - 1; i++) {
    if (load >= s[i].loadCurrent && load <= s[i + 1].loadCurrent) {
      const denom = s[i + 1].loadCurrent - s[i].loadCurrent;
      if (denom === 0) return s[i].efficiency;
      const t = (load - s[i].loadCurrent) / denom;
      return s[i].efficiency + t * (s[i + 1].efficiency - s[i].efficiency);
    }
  }
  return s[s.length - 1].efficiency;
}

function effForVinJS(curves: EfficiencyCurveSet[], vin: number, load: number): number {
  if (curves.length === 0) return 1;
  if (curves.length === 1) return interpEffJS(curves[0].points, load);
  const s = [...curves].sort((a, b) => a.inputVoltage - b.inputVoltage);
  if (vin <= s[0].inputVoltage) return interpEffJS(s[0].points, load);
  if (vin >= s[s.length - 1].inputVoltage) return interpEffJS(s[s.length - 1].points, load);
  for (let i = 0; i < s.length - 1; i++) {
    if (vin >= s[i].inputVoltage && vin <= s[i + 1].inputVoltage) {
      const eLow = interpEffJS(s[i].points, load);
      const eHigh = interpEffJS(s[i + 1].points, load);
      const denom = s[i + 1].inputVoltage - s[i].inputVoltage;
      if (denom === 0) return eLow;
      const t = (vin - s[i].inputVoltage) / denom;
      return eLow + t * (eHigh - eLow);
    }
  }
  return interpEffJS(s[s.length - 1].points, load);
}

/** Effective (loadCurrent, efficiency) curve at a fixed operating Vin, over the union of load points. */
function effectiveCurve(cd: PowerConverterData, vin: number): { i: number; e: number }[] {
  const curves = cd.efficiencyCurves || [];
  if (curves.length === 0) return [];
  const loads = new Set<number>();
  curves.forEach(cs => cs.points.forEach(p => loads.add(p.loadCurrent)));
  return [...loads].sort((a, b) => a - b).map(i => ({ i, e: effForVinJS(curves, vin, i) }));
}

/** Operating input voltage of a node = its parent's output voltage (nominal). */
function vinOf(nodeId: string, edges: Edge[], resultMap: Map<string, AnalysisResult>): number {
  const pid = parentOf(nodeId, edges);
  if (!pid) return 0;
  return resultMap.get(pid)?.voltageOut ?? 0;
}

/** Reference to a converter's interpolated-efficiency source on the Efficiency Curves tab. */
type EffRef =
  | { kind: 'curve'; sheet: string; col: string; eCol: string; r1: number; r2: number }
  | { kind: 'single'; addr: string };

/** Reference to a load's computed average-current cell on the Load Profiles tab. */
type ProfileRef = { avg: string };

const EFF_SHEET = 'Efficiency Curves';
const PROFILE_SHEET = 'Load Profiles';

function getStateMetrics(r: AnalysisResult, stateId: string, scenario: VoltageScenario): NodeMetrics {
  const sr: StateResult | undefined =
    r.scenarioStateResults?.[scenario]?.[stateId] ?? r.stateResults?.[stateId];
  if (!sr) {
    return { vout: 0, ioutAvg: 0, ioutPeak: 0, efficiency: 0, pin: 0, pout: 0, loss: 0, aux: 0, disabled: true };
  }
  return {
    vout: sr.voltageOut,
    ioutAvg: sr.currentOut,
    ioutPeak: sr.peakCurrent,
    efficiency: sr.efficiency,
    pin: sr.inputPower,
    pout: sr.outputPower,
    loss: sr.powerLoss,
    aux: sr.auxPower ?? 0,
    disabled: r.disabled,
  };
}

function getWeightedMetrics(r: AnalysisResult, scenario: VoltageScenario): NodeMetrics {
  const sc = r.scenarios?.[scenario] ?? r.scenarios?.nom;
  return {
    vout: r.voltageOut,
    ioutAvg: r.currentOut,
    ioutPeak: r.peakCurrent,
    efficiency: sc?.efficiencyAvg ?? r.efficiencyAvg,
    pin: sc?.inputPowerAvg ?? r.inputPowerAvg,
    pout: sc?.outputPowerAvg ?? r.outputPowerAvg,
    loss: sc?.powerLossAvg ?? r.powerLossAvg,
    aux: r.auxPowerAvg ?? 0,
    disabled: r.disabled,
  };
}

function typeLabel(t: AnalysisResult['type']): string {
  switch (t) {
    case 'source': return 'Source';
    case 'converter': return 'Converter';
    case 'series': return 'Series';
    case 'load': return 'Load';
    default: return t;
  }
}

// Header fill per node type (mirrors the canvas node colors).
const TYPE_COLOR: Record<AnalysisResult['type'], string> = {
  source: 'FFC9504A',
  converter: 'FF3578A0',
  series: 'FF4AA876',
  load: 'FFD4A24E',
};

// Light tint per type for the budget-sheet Component cell.
const TYPE_TINT: Record<AnalysisResult['type'], string> = {
  source: 'FFF6DAD8',
  converter: 'FFD9E6F0',
  series: 'FFDCF0E5',
  load: 'FFF6E9CF',
};

interface DiagramField { label: string; value: number; numFmt: string; }

const FMT_V = '0.0##';
const FMT_A = '0.000000';
const FMT_W = '0.000000';
const FMT_PCT = '0.0%';

/** Per-node editable fields shown in the diagram block (one cell each). */
function diagramFields(r: AnalysisResult): DiagramField[] {
  switch (r.type) {
    case 'source':
      return [
        { label: 'Vout (V)', value: r.voltageOut, numFmt: FMT_V },
        { label: 'Iout (A)', value: r.currentOut, numFmt: FMT_A },
        { label: 'Pout (W)', value: r.outputPowerAvg, numFmt: FMT_W },
      ];
    case 'converter':
      return [
        { label: 'Vout (V)', value: r.voltageOut, numFmt: FMT_V },
        { label: 'Pin (W)', value: r.inputPowerAvg, numFmt: FMT_W },
        { label: 'Loss (W)', value: r.powerLossAvg, numFmt: FMT_W },
        { label: 'Eff', value: r.efficiencyAvg, numFmt: FMT_PCT },
      ];
    case 'series':
      return [
        { label: 'Vout (V)', value: r.voltageOut, numFmt: FMT_V },
        { label: 'Loss (W)', value: r.powerLossAvg, numFmt: FMT_W },
      ];
    case 'load':
      return [
        { label: 'Vout (V)', value: r.voltageOut, numFmt: FMT_V },
        { label: 'Iout (A)', value: r.currentOut, numFmt: FMT_A },
        { label: 'Pin (W)', value: r.inputPowerAvg, numFmt: FMT_W },
      ];
    default:
      return [{ label: 'Vout (V)', value: r.voltageOut, numFmt: FMT_V }];
  }
}

interface Placement { c0: number; c1: number; r0: number; r1: number; }

const BLOCK_W = 9;        // columns per node block
const LABEL_COLS = 5;     // label area width inside a block (value area = BLOCK_W - LABEL_COLS)
const MAX_FIELDS = 4;     // converter has the most rows
const BLOCK_H = 1 + MAX_FIELDS; // reserve header + max field rows for collision spacing
const DIAGRAM_COL_W = 3.2;
const TOP_OFFSET = 4;     // leave room for a title
const SCALE_X = 0.05;     // cells per canvas px (tighter, smaller blocks)
const SCALE_Y = 0.055;

/**
 * Recreate the canvas block diagram on a worksheet: each power node becomes a
 * colored, bordered block of merged cells positioned from its canvas
 * coordinates, with orthogonal connector "wires" drawn by filling cells.
 */
function buildDiagramSheet(workbook: ExcelJS.Workbook, args: ExportExcelArgs) {
  const { projectName, nodes, edges, results, activeScenario } = args;
  const ws = workbook.addWorksheet('Diagram', {
    views: [{ showGridLines: false }],
  });

  const resultMap = new Map(results.map(r => [r.nodeId, r]));
  const positioned = nodes
    .filter(n => resultMap.has(n.id) && n.position)
    .map(n => ({ id: n.id, x: n.position.x, y: n.position.y }));
  if (positioned.length === 0) return;

  const minX = Math.min(...positioned.map(p => p.x));
  const minY = Math.min(...positioned.map(p => p.y));

  // Title block.
  ws.getCell('B2').value = `${projectName || 'Untitled Project'} — Block Diagram`;
  ws.getCell('B2').font = { bold: true, size: 14 };
  ws.getCell('B3').value = `${activeScenario.toUpperCase()} Vin · weighted average across power states`;
  ws.getCell('B3').font = { italic: true, color: { argb: 'FF888888' } };

  const occupied = new Set<string>();
  const key = (r: number, c: number) => `${r}:${c}`;
  const isFree = (r0: number, c0: number) => {
    for (let r = r0; r < r0 + BLOCK_H; r++) {
      for (let c = c0; c < c0 + BLOCK_W; c++) {
        if (occupied.has(key(r, c))) return false;
      }
    }
    return true;
  };

  const placements = new Map<string, Placement>();
  // Place top-to-bottom, left-to-right so collision nudging is stable.
  const ordered = [...positioned].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  let maxCol = 1;
  let maxRow = 1;

  for (const p of ordered) {
    const c0 = Math.max(2, Math.round((p.x - minX) * SCALE_X) + 2);
    let r0 = Math.max(TOP_OFFSET, Math.round((p.y - minY) * SCALE_Y) + TOP_OFFSET);
    let guard = 0;
    while (!isFree(r0, c0) && guard < 5000) { r0 += 1; guard += 1; }
    const c1 = c0 + BLOCK_W - 1;
    const r1 = r0 + BLOCK_H - 1;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) occupied.add(key(r, c));
    placements.set(p.id, { c0, c1, r0, r1 });
    maxCol = Math.max(maxCol, c1);
    maxRow = Math.max(maxRow, r1);
  }

  // Connector wires (orthogonal: out the parent's right, vertical, into child's left).
  const wireFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4ECDC4' } };
  const paint = (r: number, c: number) => {
    if (c < 1 || r < 1 || occupied.has(key(r, c))) return;
    ws.getCell(r, c).fill = wireFill;
  };
  for (const e of edges) {
    const p = placements.get(e.source);
    const c = placements.get(e.target);
    if (!p || !c) continue;
    const pRow = p.r0 + Math.floor(BLOCK_H / 2);
    const cRow = c.r0 + Math.floor(BLOCK_H / 2);
    const startCol = p.c1 + 1;
    const endCol = c.c0 - 1;
    const midCol = startCol <= endCol
      ? Math.floor((startCol + endCol) / 2)
      : Math.floor((p.c1 + c.c0) / 2);
    const stepC1 = startCol <= midCol ? 1 : -1;
    for (let col = startCol; col !== midCol + stepC1; col += stepC1) paint(pRow, col);
    const stepR = pRow <= cRow ? 1 : -1;
    for (let row = pRow; row !== cRow + stepR; row += stepR) paint(row, midCol);
    const stepC2 = midCol <= endCol ? 1 : -1;
    for (let col = midCol; col !== endCol + stepC2; col += stepC2) paint(cRow, col);
  }

  // Draw the node blocks on top.
  const edge = { style: 'thin' as const, color: { argb: 'FF777777' } };
  const cMidOffset = LABEL_COLS; // value area starts here within the block
  for (const [id, pl] of placements) {
    const r = resultMap.get(id)!;
    const color = TYPE_COLOR[r.type];
    const fields = diagramFields(r);
    const valueC0 = pl.c0 + cMidOffset;

    // Header (label) row — merged across the block width. Disabled nodes use a
    // muted gray header instead of the type color.
    ws.mergeCells(pl.r0, pl.c0, pl.r0, pl.c1);
    const head = ws.getCell(pl.r0, pl.c0);
    head.value = r.disabled ? `${r.label || id} (off)` : (r.label || id);
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: r.disabled ? 'FFC9CCD2' : color } };
    head.font = { bold: true, color: { argb: r.disabled ? 'FF777777' : 'FFFFFFFF' }, size: 9 };
    head.alignment = { vertical: 'middle', horizontal: 'center' };

    // One row per field: label cell (left) + editable value cell (right).
    fields.forEach((f, i) => {
      const row = pl.r0 + 1 + i;
      ws.mergeCells(row, pl.c0, row, valueC0 - 1);
      const lab = ws.getCell(row, pl.c0);
      lab.value = f.label;
      lab.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1EEE8' } };
      lab.font = { size: 8, color: { argb: r.disabled ? 'FFAAAAAA' : 'FF6A6A6A' } };
      lab.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

      ws.mergeCells(row, valueC0, row, pl.c1);
      const val = ws.getCell(row, valueC0);
      val.value = f.value;
      val.numFmt = f.numFmt;
      val.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
      val.font = { size: 9, color: { argb: r.disabled ? 'FFAAAAAA' : 'FF2C2A26' } };
      val.alignment = { vertical: 'middle', horizontal: 'right', indent: 1 };
    });

    // Outer border around the used block rows.
    const usedR1 = pl.r0 + fields.length;
    for (let row = pl.r0; row <= usedR1; row++) {
      for (let col = pl.c0; col <= pl.c1; col++) {
        const cell = ws.getCell(row, col);
        cell.border = {
          top: row === pl.r0 ? edge : undefined,
          bottom: row === usedR1 ? edge : undefined,
          left: col === pl.c0 ? edge : undefined,
          right: col === pl.c1 ? edge : undefined,
        };
      }
    }
  }

  // Narrow columns so merged blocks look proportional; short-ish rows.
  for (let c = 1; c <= maxCol + 1; c++) ws.getColumn(c).width = DIAGRAM_COL_W;
  for (let r = 1; r <= maxRow + 1; r++) ws.getRow(r).height = 15;

  // Legend.
  const legendRow = maxRow + 3;
  ws.getCell(legendRow, 2).value = 'Legend:';
  ws.getCell(legendRow, 2).font = { bold: true, size: 10 };
  const legend: [string, AnalysisResult['type']][] = [
    ['Source', 'source'], ['Converter', 'converter'], ['Series', 'series'], ['Load', 'load'],
  ];
  legend.forEach(([label, t], i) => {
    const col = 4 + i * 6;
    const cell = ws.getCell(legendRow, col);
    cell.value = label;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TYPE_COLOR[t] } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
    cell.alignment = { horizontal: 'center' };
    ws.mergeCells(legendRow, col, legendRow, col + 3);
  });
}

interface OrderedNode {
  id: string;
  depth: number;
  parentId: string | null;
}

/**
 * Depth-first ordering starting from each source, then any remaining (orphan)
 * nodes. Only nodes that have an analysis result are included. Each source's
 * subtree is emitted contiguously so SUM ranges over a rail are valid.
 */
function buildOrder(
  resultMap: Map<string, AnalysisResult>,
  edges: Edge[],
): { groups: OrderedNode[][]; orphans: OrderedNode[] } {
  const visited = new Set<string>();
  const groups: OrderedNode[][] = [];

  const dfs = (id: string, depth: number, parentId: string | null, acc: OrderedNode[]) => {
    if (visited.has(id) || !resultMap.has(id)) return;
    visited.add(id);
    acc.push({ id, depth, parentId });
    for (const childId of childrenOf(id, edges)) {
      dfs(childId, depth + 1, id, acc);
    }
  };

  const sources = [...resultMap.values()].filter(r => r.type === 'source');
  for (const s of sources) {
    const acc: OrderedNode[] = [];
    dfs(s.nodeId, 0, null, acc);
    if (acc.length > 0) groups.push(acc);
  }

  const orphans: OrderedNode[] = [];
  for (const r of resultMap.values()) {
    if (!visited.has(r.nodeId)) {
      dfs(r.nodeId, 0, parentOf(r.nodeId, edges), orphans);
    }
  }

  return { groups, orphans };
}

function styleHeaderRow(row: ExcelJS.Row) {
  row.font = { bold: true };
  row.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2430' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF555555' } } };
  });
}

interface SheetCtx {
  dataMap: Map<string, PowerNodeData>;
  effRef: Map<string, EffRef>;
  profileRef: Map<string, ProfileRef>;
  /** When set, node cells are duty-weighted references to these per-state sheets instead of model formulas. */
  weighted?: { sheet: string; frac: number }[];
}

function buildSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  subtitle: string,
  args: ExportExcelArgs,
  getMetrics: (r: AnalysisResult) => NodeMetrics,
  ctx: SheetCtx,
) {
  const { projectName, edges, results } = args;
  const ws = workbook.addWorksheet(sheetName.slice(0, 31));

  const resultMap = new Map(results.map(r => [r.nodeId, r]));

  // Title block.
  ws.addRow([projectName || 'Untitled Project']).font = { bold: true, size: 14 };
  ws.addRow([subtitle]).font = { italic: true, color: { argb: 'FF666666' } };
  ws.addRow([`Generated ${new Date().toLocaleString()} · live formulas (\u03B7 from "${EFF_SHEET}", profile currents from "${PROFILE_SHEET}")`]).font = { italic: true, color: { argb: 'FF999999' } };
  ws.addRow([]);

  const headerRow = ws.addRow(HEADERS);
  styleHeaderRow(headerRow);
  const firstBodyRow = headerRow.number + 1;

  const rowOf = new Map<string, number>();
  const { groups, orphans } = buildOrder(resultMap, edges);

  const cell = (colKey: keyof typeof COL, rn: number) => `${COL[colKey]}${rn}`;
  const weighted = ctx.weighted;
  // Duty-weighted reference across state sheets, e.g. 0.5*'Active'!H7+0.5*'Sleep'!H7
  const wref = (colLetter: string, rn: number) =>
    weighted!.map(w => `${w.frac}*'${w.sheet.replace(/'/g, "''")}'!${colLetter}${rn}`).join('+');

  const writeNodeRow = (on: OrderedNode): number => {
    const r = resultMap.get(on.id)!;
    const m = getMetrics(r);
    const data = ctx.dataMap.get(on.id);
    const indent = '   '.repeat(on.depth);

    const row = ws.addRow([
      `${indent}${r.label || r.nodeId}`,
      typeLabel(r.type),
      null, // Vin
      weighted ? null : m.vout, // Vout
      null, // Iout
      null, // Eff
      null, // Pout
      null, // Pin
      null, // Loss
      null, // Iq
      weighted ? null : (m.aux || null), // Aux
      m.disabled ? 'disabled' : null,
    ]);
    const rn = row.number;
    rowOf.set(on.id, rn);

    const D = cell('vout', rn), E = cell('iout', rn), F = cell('efficiency', rn);
    const G = cell('pout', rn), H = cell('pin', rn), C = cell('vin', rn);
    const J = cell('iq', rn), K = cell('aux', rn);

    if (!weighted && on.parentId && rowOf.has(on.parentId)) {
      row.getCell(COL.vin).value = { formula: `${COL.vout}${rowOf.get(on.parentId)}` };
    }

    if (weighted) {
      // Every column is a duty-weighted reference to the per-state sheets, so
      // the Summary is an exact weighted average of those sheets. Efficiency is
      // derived from the weighted Pout/Pin (efficiency is not additive).
      row.getCell(COL.vin).value = { formula: wref(COL.vin, rn) };
      row.getCell(COL.vout).value = { formula: wref(COL.vout, rn) };
      row.getCell(COL.iout).value = { formula: wref(COL.iout, rn) };
      row.getCell(COL.pout).value = { formula: wref(COL.pout, rn) };
      row.getCell(COL.pin).value = { formula: wref(COL.pin, rn) };
      row.getCell(COL.loss).value = { formula: wref(COL.loss, rn) };
      row.getCell(COL.iq).value = { formula: wref(COL.iq, rn) };
      row.getCell(COL.aux).value = { formula: wref(COL.aux, rn) };
      if (r.type === 'converter' || r.type === 'series') {
        row.getCell(COL.efficiency).value = { formula: `IF(${H}=0,0,${G}/${H})` };
      }
    } else if (r.type === 'load') {
      // Iout: static value, or live reference to the Load Profiles tab average.
      const pref = ctx.profileRef.get(on.id);
      row.getCell(COL.iout).value = pref ? { formula: pref.avg } : m.ioutAvg;
      // Leaf: Pin = Vout*Iout; Pout = Pin (delivered); loss 0.
      row.getCell(COL.pin).value = { formula: `${D}*${E}` };
      row.getCell(COL.pout).value = { formula: `${H}` };
      row.getCell(COL.loss).value = { formula: `${H}-${G}` };
    } else if (r.type === 'converter') {
      const cd = data as PowerConverterData | undefined;
      const iq = cd?.quiescentCurrent ?? 0;
      row.getCell(COL.iq).value = iq || null;
      // Output current Iout = Pout / Vout.
      row.getCell(COL.iout).value = { formula: `IF(${D}=0,0,${G}/${D})` };
      // Efficiency: LDO = min(1, Vout/Vin); switching w/ curve = interpolated; flat = value.
      if (cd?.converterType === 'ldo') {
        row.getCell(COL.efficiency).value = { formula: `IF(${C}=0,0,MIN(1,${D}/${C}))` };
      } else {
        const ref = ctx.effRef.get(on.id);
        row.getCell(COL.efficiency).value = ref
          ? { formula: effFormula(ref, E) }
          : m.efficiency;
      }
      // Pin = Pout/η + Iq*Vin ; Pout set in pass 2.
      row.getCell(COL.pin).value = { formula: `IF(${F}=0,${G},${G}/${F})+${J}*${C}` };
      row.getCell(COL.loss).value = { formula: `${H}-${G}` };
    } else if (r.type === 'series') {
      row.getCell(COL.iout).value = { formula: `IF(${D}=0,0,${G}/${D})` };
      row.getCell(COL.efficiency).value = m.efficiency; // engine value (series loss is minor)
      row.getCell(COL.pin).value = { formula: `IF(${F}=0,${G},${G}/${F})` };
      row.getCell(COL.loss).value = { formula: `${H}-${G}` };
    } else {
      // source: Iout = Pout/Vout; Pin = Pout (Ri loss ignored); Pout in pass 2.
      row.getCell(COL.iout).value = { formula: `IF(${D}=0,0,${G}/${D})` };
      row.getCell(COL.pin).value = { formula: `${G}` };
      row.getCell(COL.loss).value = { formula: `${H}-${G}` };
    }

    // Color-code Component (light tint) and Type (solid badge) by node type.
    const compCell = row.getCell(COL.component);
    const typeCell = row.getCell(COL.type);
    if (m.disabled) {
      row.font = { color: { argb: 'FF999999' }, italic: true };
      compCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
      typeCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
      typeCell.font = { bold: true, italic: true, color: { argb: 'FF888888' } };
      typeCell.alignment = { horizontal: 'center' };
    } else {
      compCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TYPE_TINT[r.type] } };
      typeCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TYPE_COLOR[r.type] } };
      typeCell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      typeCell.alignment = { horizontal: 'center' };
    }
    return rn;
  };

  const emitGroup = (group: OrderedNode[], railLabel: string) => {
    const first = ws.rowCount + 1;
    for (const on of group) writeNodeRow(on);
    const last = ws.rowCount;

    // Pass 2: parent Pout = sum of children Pin + own aux power.
    // (Skipped in weighted mode, where Pout is a direct reference to state sheets.)
    if (!weighted) {
      for (const on of group) {
        const r = resultMap.get(on.id)!;
        if (r.type === 'load') continue;
        const rn = rowOf.get(on.id)!;
        const childPins = childrenOf(on.id, edges)
          .filter(cid => rowOf.has(cid))
          .map(cid => `${COL.pin}${rowOf.get(cid)}`);
        const terms = [...childPins, `${COL.aux}${rn}`];
        ws.getCell(`${COL.pout}${rn}`).value = { formula: terms.join('+') };
      }
    }

    // Rail subtotal row. Set cells by column key (not positionally) so it stays
    // correct if the column layout changes.
    const subN = ws.addRow([]).number;
    ws.getCell(`${COL.component}${subN}`).value = `Subtotal — ${railLabel}`;
    ws.getCell(`${COL.pout}${subN}`).value = { formula: `SUMIFS(${COL.pin}${first}:${COL.pin}${last},${COL.type}${first}:${COL.type}${last},"Load")` };
    ws.getCell(`${COL.pin}${subN}`).value = { formula: `SUMIFS(${COL.pin}${first}:${COL.pin}${last},${COL.type}${first}:${COL.type}${last},"Source")` };
    ws.getCell(`${COL.loss}${subN}`).value = { formula: `SUM(${COL.loss}${first}:${COL.loss}${last})` };
    ws.getCell(`${COL.notes}${subN}`).value = 'load power / input / loss';
    for (let c = 1; c <= HEADERS.length; c++) {
      const cc = ws.getCell(subN, c);
      cc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2A2F3A' } };
      cc.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    }
  };

  for (const group of groups) {
    const sourceId = group[0]?.id;
    const label = (sourceId && resultMap.get(sourceId)?.label) || 'Rail';
    emitGroup(group, label);
  }
  if (orphans.length > 0) {
    emitGroup(orphans, 'Unconnected');
  }

  const lastBodyRow = ws.rowCount;

  // System total. Pout column = total LOAD power, Pin column = total INPUT power;
  // Loss = input - load; Eff = load / input. Cells set by column key.
  ws.addRow([]);
  const tr = ws.addRow([]).number;
  ws.getCell(`${COL.component}${tr}`).value = 'SYSTEM TOTAL';
  ws.getCell(`${COL.pout}${tr}`).value = { formula: `SUMIFS(${COL.pin}${firstBodyRow}:${COL.pin}${lastBodyRow},${COL.type}${firstBodyRow}:${COL.type}${lastBodyRow},"Load")` };
  ws.getCell(`${COL.pin}${tr}`).value = { formula: `SUMIFS(${COL.pin}${firstBodyRow}:${COL.pin}${lastBodyRow},${COL.type}${firstBodyRow}:${COL.type}${lastBodyRow},"Source")` };
  ws.getCell(`${COL.loss}${tr}`).value = { formula: `${COL.pin}${tr}-${COL.pout}${tr}` };
  ws.getCell(`${COL.efficiency}${tr}`).value = { formula: `IF(${COL.pin}${tr}=0,0,${COL.pout}${tr}/${COL.pin}${tr})` };
  ws.getCell(`${COL.notes}${tr}`).value = 'Pout = total load power · Pin = total input power · Loss = Pin-Pout';
  for (let c = 1; c <= HEADERS.length; c++) {
    const cc = ws.getCell(tr, c);
    cc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF143020' } };
    cc.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    cc.border = { top: { style: 'double', color: { argb: 'FF4ECDC4' } } };
  }

  // Column widths + number formats.
  const widths = [30, 11, 10, 10, 13, 9, 12, 12, 12, 11, 11, 30];
  ws.columns.forEach((c, i) => { c.width = widths[i] ?? 12; });
  // 6 decimals so small values (uW / uA) are not rounded away to 0.
  const voltFmt = '0.0##';
  const pwrFmt = '0.000000';
  const curFmt = '0.000000';
  for (let rn = firstBodyRow; rn <= tr; rn++) {
    ws.getCell(`${COL.vin}${rn}`).numFmt = voltFmt;
    ws.getCell(`${COL.vout}${rn}`).numFmt = voltFmt;
    ws.getCell(`${COL.iout}${rn}`).numFmt = curFmt;
    ws.getCell(`${COL.efficiency}${rn}`).numFmt = '0.0%';
    ws.getCell(`${COL.pout}${rn}`).numFmt = pwrFmt;
    ws.getCell(`${COL.pin}${rn}`).numFmt = pwrFmt;
    ws.getCell(`${COL.loss}${rn}`).numFmt = pwrFmt;
    ws.getCell(`${COL.iq}${rn}`).numFmt = curFmt;
    ws.getCell(`${COL.aux}${rn}`).numFmt = pwrFmt;
  }

  ws.views = [{ state: 'frozen', ySplit: headerRow.number }];
}

/** Build the live η lookup formula (without leading '=') for a converter's output-current cell. */
function effFormula(ref: EffRef, ioutCell: string): string {
  if (ref.kind === 'single') return ref.addr;
  const q = `'${ref.sheet}'`;
  const IR = `${q}!$${ref.col}$${ref.r1}:$${ref.col}$${ref.r2}`;
  const ER = `${q}!$${ref.eCol}$${ref.r1}:$${ref.eCol}$${ref.r2}`;
  const A1 = `${q}!$${ref.col}$${ref.r1}`;
  const A2 = `${q}!$${ref.col}$${ref.r2}`;
  const B1 = `${q}!$${ref.eCol}$${ref.r1}`;
  const B2 = `${q}!$${ref.eCol}$${ref.r2}`;
  const m = `MATCH(${ioutCell},${IR},1)`;
  const interp = `INDEX(${ER},${m})+(${ioutCell}-INDEX(${IR},${m}))/(INDEX(${IR},${m}+1)-INDEX(${IR},${m}))*(INDEX(${ER},${m}+1)-INDEX(${ER},${m}))`;
  return `IF(${ioutCell}<=${A1},${B1},IF(${ioutCell}>=${A2},${B2},${interp}))`;
}

interface EffEntry { id: string; label: string; cd: PowerConverterData; vin: number; }

function buildEfficiencyTab(workbook: ExcelJS.Workbook, entries: EffEntry[]): Map<string, EffRef> {
  const refs = new Map<string, EffRef>();
  if (entries.length === 0) return refs;
  const ws = workbook.addWorksheet(EFF_SHEET);
  ws.getCell('A1').value = 'Efficiency curves (effective curve at each converter\u2019s operating Vin). Editable; the budget interpolates \u03B7 vs Iout from these points.';
  ws.getCell('A1').font = { italic: true, color: { argb: 'FF888888' } };
  ws.columns = [{ width: 26 }, { width: 14 }, { width: 14 }];
  let row = 3;
  for (const e of entries) {
    const eff = effectiveCurve(e.cd, e.vin);
    if (eff.length === 0) continue;
    const head = ws.getCell(row, 1);
    head.value = `${e.label}  (Vin \u2248 ${e.vin ? e.vin.toFixed(2) : '?'} V)`;
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TYPE_COLOR.converter } };
    ws.mergeCells(row, 1, row, 3);
    row += 1;
    const hdr = ws.getRow(row);
    hdr.getCell(1).value = 'Iout (A)';
    hdr.getCell(2).value = 'Efficiency';
    hdr.font = { bold: true };
    row += 1;
    if (eff.length === 1) {
      ws.getCell(row, 1).value = eff[0].i;
      ws.getCell(row, 1).numFmt = '0.000000';
      const ec = ws.getCell(row, 2);
      ec.value = eff[0].e; ec.numFmt = '0.0%';
      refs.set(e.id, { kind: 'single', addr: `'${EFF_SHEET}'!$B$${row}` });
      row += 2;
      continue;
    }
    const r1 = row;
    for (const pt of eff) {
      ws.getCell(row, 1).value = pt.i; ws.getCell(row, 1).numFmt = '0.000000';
      ws.getCell(row, 2).value = pt.e; ws.getCell(row, 2).numFmt = '0.0%';
      row += 1;
    }
    const r2 = row - 1;
    refs.set(e.id, { kind: 'curve', sheet: EFF_SHEET, col: 'A', eCol: 'B', r1, r2 });
    row += 1; // gap between blocks
  }
  return refs;
}

interface ProfileEntry { id: string; label: string; ld: LoadData; }

function buildProfilesTab(workbook: ExcelJS.Workbook, entries: ProfileEntry[]): Map<string, ProfileRef> {
  const refs = new Map<string, ProfileRef>();
  if (entries.length === 0) return refs;
  const ws = workbook.addWorksheet(PROFILE_SHEET);
  ws.getCell('A1').value = 'Load current profiles. Time-weighted average current is computed here and used by the budget for these loads.';
  ws.getCell('A1').font = { italic: true, color: { argb: 'FF888888' } };
  ws.columns = [{ width: 26 }, { width: 14 }, { width: 14 }, { width: 14 }];
  let row = 3;
  for (const e of entries) {
    const head = ws.getCell(row, 1);
    head.value = e.label;
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TYPE_COLOR.load } };
    ws.mergeCells(row, 1, row, 4);
    row += 1;

    if (e.ld.loadMode === 'pulse_duty') {
      const T = e.ld.pulsePeriodSeconds ?? 0;
      const dc = Math.max(0, Math.min(1, e.ld.pulseDutyCycle ?? 0));
      const baseRow = row, peakRow = row + 1, perRow = row + 2, pwRow = row + 3, avgRow = row + 4;
      const set = (rr: number, label: string, val: number, fmt: string) => {
        ws.getCell(rr, 1).value = label;
        const c = ws.getCell(rr, 2); c.value = val; c.numFmt = fmt;
      };
      set(baseRow, 'Baseline current (A)', e.ld.pulseBaselineCurrent ?? 0, '0.000000');
      set(peakRow, 'Pulse current (A)', e.ld.pulsePeakCurrent ?? 0, '0.000000');
      set(perRow, 'Period (s)', T, '0.000000');
      set(pwRow, 'Pulse width (s)', dc * T, '0.000000');
      ws.getCell(avgRow, 1).value = 'Average current (A)';
      ws.getCell(avgRow, 1).font = { bold: true };
      const avg = ws.getCell(avgRow, 2);
      // avg = baseline + (peak-baseline) * (pulseWidth / period)
      avg.value = { formula: `IF($B$${perRow}=0,$B$${baseRow},$B$${baseRow}+($B$${peakRow}-$B$${baseRow})*$B$${pwRow}/$B$${perRow})` };
      avg.numFmt = '0.000000';
      avg.font = { bold: true };
      refs.set(e.id, { avg: `'${PROFILE_SHEET}'!$B$${avgRow}` });
      row = avgRow + 2;
      continue;
    }

    // current_profile: time/current points with left-hold durations.
    const pts = [...(e.ld.loadProfile || [])].sort((a, b) => a.time - b.time);
    if (pts.length === 0) { row += 1; continue; }
    const period = pts[pts.length - 1].time;
    const hdr = ws.getRow(row);
    hdr.getCell(1).value = 'Time (s)';
    hdr.getCell(2).value = 'Current (A)';
    hdr.getCell(3).value = 'Duration (s)';
    hdr.font = { bold: true };
    row += 1;
    const dataR1 = row;
    // optional wrap segment [0, t0) holds the last sample's current
    if (pts[0].time > 0) {
      ws.getCell(row, 1).value = 0;
      ws.getCell(row, 2).value = pts[pts.length - 1].current;
      ws.getCell(row, 3).value = pts[0].time;
      ws.getCell(row, 1).numFmt = '0.000000'; ws.getCell(row, 2).numFmt = '0.000000'; ws.getCell(row, 3).numFmt = '0.000000';
      row += 1;
    }
    for (let i = 0; i < pts.length; i++) {
      const dur = i < pts.length - 1 ? pts[i + 1].time - pts[i].time : 0;
      ws.getCell(row, 1).value = pts[i].time; ws.getCell(row, 1).numFmt = '0.000000';
      ws.getCell(row, 2).value = pts[i].current; ws.getCell(row, 2).numFmt = '0.000000';
      ws.getCell(row, 3).value = dur; ws.getCell(row, 3).numFmt = '0.000000';
      row += 1;
    }
    const dataR2 = row - 1;
    ws.getCell(row, 1).value = 'Average current (A)';
    ws.getCell(row, 1).font = { bold: true };
    const avg = ws.getCell(row, 2);
    const durRange = `$C$${dataR1}:$C$${dataR2}`;
    const curRange = `$B$${dataR1}:$B$${dataR2}`;
    avg.value = { formula: `IF(SUM(${durRange})=0,AVERAGE(${curRange}),SUMPRODUCT(${durRange},${curRange})/SUM(${durRange}))` };
    avg.numFmt = '0.000000';
    avg.font = { bold: true };
    void period;
    refs.set(e.id, { avg: `'${PROFILE_SHEET}'!$B$${row}` });
    row += 2;
  }
  return refs;
}

export async function buildPowerBudgetWorkbook(args: ExportExcelArgs): Promise<ExcelJS.Workbook> {
  // Dynamic import keeps the ~900KB exceljs bundle out of the initial app load.
  const ExcelJSRuntime = (await import('exceljs')).default;
  const workbook = new ExcelJSRuntime.Workbook();
  workbook.creator = 'Bloom Power Tree';
  workbook.created = new Date();

  const { nodes, edges, results, powerStates, activeScenario } = args;
  const scenarioLabel = `${activeScenario.toUpperCase()} Vin`;
  const states = powerStates.length > 0 ? powerStates : [];
  const multiState = states.length > 1;

  const resultMap = new Map(results.map(r => [r.nodeId, r]));
  const dataMap = new Map<string, PowerNodeData>(
    nodes.map(n => [n.id, n.data as unknown as PowerNodeData]),
  );

  // Block diagram first (spatial recreation of the canvas).
  buildDiagramSheet(workbook, args);

  // Detail tabs: efficiency curves (switching converters) and load profiles.
  const effEntries: EffEntry[] = [];
  const profileEntries: ProfileEntry[] = [];
  for (const r of results) {
    const data = dataMap.get(r.nodeId);
    if (!data) continue;
    if (r.type === 'converter') {
      const cd = data as PowerConverterData;
      const mode = cd.efficiencyMode ?? (cd.efficiencyCurves?.length ? 'curve' : 'flat');
      if (cd.converterType === 'switching' && mode === 'curve' && (cd.efficiencyCurves?.length ?? 0) > 0) {
        effEntries.push({ id: r.nodeId, label: r.label || r.nodeId, cd, vin: vinOf(r.nodeId, edges, resultMap) });
      }
    } else if (r.type === 'load') {
      const ld = data as LoadData;
      if (ld.loadMode === 'current_profile' && (ld.loadProfile?.length ?? 0) > 1) {
        profileEntries.push({ id: r.nodeId, label: r.label || r.nodeId, ld });
      } else if (ld.loadMode === 'pulse_duty') {
        profileEntries.push({ id: r.nodeId, label: r.label || r.nodeId, ld });
      }
    }
  }
  const effRef = buildEfficiencyTab(workbook, effEntries);
  const profileRef = buildProfilesTab(workbook, profileEntries);
  const ctx: SheetCtx = { dataMap, effRef, profileRef };

  if (multiState) {
    // Sheet names must match what buildSheet uses (sliced to 31 chars) so the
    // weighted Summary can reference each state sheet's cells by name.
    const stateSheets = states.map(st => ({
      st,
      sheet: (st.name || st.id).slice(0, 31),
      frac: st.fractionOfTime,
    }));

    // Summary first (in tab order) — a true duty-weighted reference to the
    // per-state sheets. Excel resolves the references by name regardless of
    // creation order, and every sheet shares identical row layout.
    buildSheet(
      workbook,
      'Summary',
      `Weighted average across power states (duty-weighted reference to state tabs) — ${scenarioLabel}`,
      args,
      r => getWeightedMetrics(r, activeScenario),
      { ...ctx, weighted: stateSheets.map(s => ({ sheet: s.sheet, frac: s.frac })) },
    );

    // Per-state sheets (live model formulas).
    for (const { st, sheet } of stateSheets) {
      const pct = (st.fractionOfTime * 100).toFixed(0);
      buildSheet(
        workbook,
        sheet,
        `Power state "${st.name}" (${pct}% duty) — ${scenarioLabel}`,
        args,
        r => getStateMetrics(r, st.id, activeScenario),
        ctx,
      );
    }
  } else {
    buildSheet(
      workbook,
      'Summary',
      `Power budget — ${scenarioLabel}`,
      args,
      r => getWeightedMetrics(r, activeScenario),
      ctx,
    );
  }

  return workbook;
}

function sanitizeFileName(name: string): string {
  return (name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'power-tree');
}

export async function exportPowerBudgetExcel(args: ExportExcelArgs): Promise<void> {
  const workbook = await buildPowerBudgetWorkbook(args);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFileName(args.projectName)}-power-budget.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
