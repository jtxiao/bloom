import type ExcelJS from 'exceljs';

/**
 * Reconstruct a project from an exported power-budget workbook by reading the
 * (possibly edited) cell VALUES on the Summary budget sheet — no embedded JSON.
 *
 * This is intentionally a simplified round-trip: it rebuilds the tree topology
 * (from row indentation), node types, and the key editable inputs (voltages,
 * load currents, converter efficiency/Iq, source/battery values, aux loads).
 * Advanced data not represented as plain budget inputs (efficiency curves,
 * load profiles, multi-state load snapshots, battery discharge curves) is
 * flattened to simple equivalents.
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
  auxLoads: { id: string; label: string; mode: 'resistor' | 'fixed_current'; resistance: number; fixedCurrent: number }[];
}

let _impId = 0;
const nextId = () => `node_${++_impId}`;
const nextAuxId = () => `aux_${Date.now()}_${++_impId}`;

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

  const ws = wb.getWorksheet('Summary') ?? wb.worksheets.find(w => findHeaderRow(w) > 0);
  if (!ws) throw new Error('No budget sheet found (expected a "Summary" tab).');
  const headerRow = findHeaderRow(ws);
  if (headerRow < 0) throw new Error('Could not find the budget table header.');

  const col = {
    component: 1,
    type: columnIndex(ws, headerRow, 'Type'),
    vout: columnIndex(ws, headerRow, 'Vout (V)'),
    iout: columnIndex(ws, headerRow, 'Iout (A)'),
    eff: columnIndex(ws, headerRow, 'Eff'),
    loss: columnIndex(ws, headerRow, 'Loss (W)'),
    iq: columnIndex(ws, headerRow, 'Iq (A)'),
    notes: columnIndex(ws, headerRow, 'Notes'),
  };

  // Battery capacity / nominal V map (label -> {capacityMah, nominalV}).
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
        const resistance = m ? parseFloat(m[1]) : 0;
        lastNode.auxLoads.push({ id: nextAuxId(), label, mode: 'resistor', resistance: resistance || 0, fixedCurrent: 0 });
      } else {
        lastNode.auxLoads.push({ id: nextAuxId(), label, mode: 'fixed_current', resistance: 0, fixedCurrent: isNaN(iout) ? 0 : iout });
      }
      continue;
    }

    const t = typeStr.toLowerCase();
    if (t !== 'source' && t !== 'converter' && t !== 'series' && t !== 'load') continue;

    const leadingSpaces = rawComp.length - rawComp.replace(/^\s+/, '').length;
    const depth = Math.round(leadingSpaces / 3);
    const effCell = ws.getCell(r, col.eff).value as CellVal;
    const node: ParsedNode = {
      id: nextId(),
      nodeType: t as ParsedNode['nodeType'],
      label: compTrim || `Node ${parsed.length + 1}`,
      depth,
      vout: numOf(ws.getCell(r, col.vout).value as CellVal) || 0,
      iout: numOf(ws.getCell(r, col.iout).value as CellVal) || 0,
      eff: numOf(effCell) || 0,
      effIsLdo: /MIN\(/i.test(formulaOf(effCell)),
      iq: numOf(ws.getCell(r, col.iq).value as CellVal) || 0,
      loss: numOf(ws.getCell(r, col.loss).value as CellVal) || 0,
      auxLoads: [],
    };
    parsed.push(node);
    lastNode = node;
  }

  if (parsed.length === 0) throw new Error('No component rows found in the budget sheet.');

  // Build edges from indentation: parent = nearest preceding node at depth-1.
  const lastIdAtDepth: Record<number, string> = {};
  const edges: { id: string; source: string; target: string; sourceHandle: string; targetHandle: string }[] = [];
  let edgeNum = 0;
  for (const n of parsed) {
    lastIdAtDepth[n.depth] = n.id;
    if (n.depth > 0) {
      const parentId = lastIdAtDepth[n.depth - 1];
      if (parentId) {
        edges.push({ id: `e_${++edgeNum}`, source: parentId, target: n.id, sourceHandle: 'source', targetHandle: 'target' });
      }
    }
  }

  // Auto-layout: column by depth, stacked vertically in row order.
  let yCursor = 80;
  const nodes = parsed.map(n => {
    const position = { x: 80 + n.depth * 280, y: yCursor };
    yCursor += 120;
    return { id: n.id, type: 'powerNode', position, data: buildNodeData(n, batteryMap) };
  });

  const projectName = (strOf(ws.getCell(1, 1).value as CellVal).replace(/ —.*$/, '').trim()) || 'Imported project';

  const project = {
    version: 4,
    projectName,
    notes: [],
    theme: 'light',
    activeScenario: 'nom',
    powerStates: [{ id: 'imported', name: 'Imported', fractionOfTime: 1, loadSnapshots: {} }],
    nodes,
    edges,
  };
  return JSON.stringify(project, null, 2);
}

function buildNodeData(
  n: ParsedNode,
  batteryMap: Map<string, { capacityMah: number; nominalV: number }>,
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
    case 'converter':
      return {
        type: 'converter',
        label: n.label,
        converterType: n.effIsLdo ? 'ldo' : 'switching',
        outputVoltage: n.vout,
        quiescentCurrent: n.iq || 0,
        efficiencyMode: 'flat',
        flatEfficiency: n.eff > 0 ? Math.min(1, n.eff) : 0.9,
        efficiencyCurves: [],
        enabled: true,
        ...aux,
      };
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
    default:
      return {
        type: 'load',
        label: n.label,
        voltage: n.vout,
        loadMode: 'fixed_current',
        loadProfile: [],
        resistance: n.vout > 0 && n.iout > 0 ? n.vout / n.iout : 100,
        fixedCurrent: n.iout || 0,
        enabled: true,
      };
  }
}
