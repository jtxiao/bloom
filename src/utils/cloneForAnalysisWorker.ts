import type { Node, Edge } from '@xyflow/react';
import type { PowerState } from '../types';

function deepStripFunctions<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepStripFunctions) as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as object)) {
    if (typeof val === 'function') continue;
    out[k] = deepStripFunctions(val);
  }
  return out as T;
}

/** Plain, structured-clone-safe nodes for the analysis worker (no callbacks on `data`). */
export function cloneNodesForAnalysisWorker(nodes: Node[]): Node[] {
  return nodes.map(n => ({
    id: n.id,
    type: n.type,
    position: { x: n.position.x, y: n.position.y },
    data: deepStripFunctions(n.data as object) as Node['data'],
    ...(n.width != null ? { width: n.width } : {}),
    ...(n.height != null ? { height: n.height } : {}),
  })) as Node[];
}

/** Topology-only edges — all `analyzeTree` needs. */
export function cloneEdgesForAnalysisWorker(edges: Edge[]): Edge[] {
  return edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    type: e.type ?? 'smart',
  })) as Edge[];
}

export function clonePowerStatesForWorker(states: PowerState[]): PowerState[] {
  return JSON.parse(JSON.stringify(states)) as PowerState[];
}
