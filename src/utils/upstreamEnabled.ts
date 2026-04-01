import type { Edge, Node } from '@xyflow/react';
import type { PowerNodeData, PowerState } from '../types';

/** Per-node enabled for the active power state (override wins over canvas). */
export function effectiveNodeEnabled(nodeId: string, node: Node, state: PowerState | undefined): boolean {
  const d = node.data as unknown as PowerNodeData;
  if (d.type !== 'converter' && d.type !== 'series' && d.type !== 'load') return true;
  if (state?.enabledOverrides && nodeId in state.enabledOverrides) {
    return state.enabledOverrides[nodeId];
  }
  return (node.data as { enabled?: boolean }).enabled !== false;
}

/** True if any upstream converter/series/load on the path to the root is off. */
export function hasUpstreamAncestorOff(
  nodeId: string,
  nodes: Node[],
  edges: Edge[],
  state: PowerState | undefined,
): boolean {
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const parentOf = new Map<string, string>();
  for (const e of edges) parentOf.set(e.target, e.source);
  let p = parentOf.get(nodeId);
  while (p) {
    const pn = nodeById.get(p);
    if (!pn) break;
    const pd = pn.data as unknown as PowerNodeData;
    if (pd.type === 'converter' || pd.type === 'series' || pd.type === 'load') {
      if (!effectiveNodeEnabled(p, pn, state)) return true;
    }
    p = parentOf.get(p);
  }
  return false;
}

export function computeUpstreamAncestorOffMap(
  nodes: Node[],
  edges: Edge[],
  state: PowerState | undefined,
): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const n of nodes) {
    m.set(n.id, hasUpstreamAncestorOff(n.id, nodes, edges, state));
  }
  return m;
}
