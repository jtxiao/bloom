import { useCallback, useState, useRef, useEffect, DragEvent } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  SelectionMode,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import type { Connection, Node, Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import PowerNode from './components/PowerNode';
import GroupNode from './components/GroupNode';
import TextNode from './components/TextNode';
import Sidebar from './components/Sidebar';
import ConfigPanel from './components/ConfigPanel';
import ResultsPanel from './components/ResultsPanel';
import SmartBezierEdge from './components/SmartBezierEdge';
import DiagnosticsConsole from './components/DiagnosticsConsole';
import NotesDrawer from './components/NotesDrawer';
import NodeSearch from './components/NodeSearch';
import Tooltip from './components/Tooltip';
import { analyzeTree } from './engine/calculate';
import type {
  PowerNodeData,
  AnalysisResult,
  ScenarioTimeSeries,
  BatteryTimeSeriesPoint,
  Diagnostic,
  PowerSourceData,
  PowerConverterData,
  LoadData,
  SeriesElementData,
  PowerState,
  VoltageScenario,
  NoteBullet,
} from './types';

const nodeTypes = { powerNode: PowerNode, groupNode: GroupNode, textNode: TextNode };
const edgeTypes = { smart: SmartBezierEdge };

let nodeId = 0;
function getNextId() {
  return `node_${++nodeId}`;
}
function syncNodeIdCounter(nodes: Node[]) {
  const maxId = nodes.reduce((max, n) => {
    const num = parseInt(n.id.replace(/\D/g, ''), 10);
    return isNaN(num) ? max : Math.max(max, num);
  }, 0);
  if (maxId >= nodeId) nodeId = maxId;
}

function defaultDataForType(type: string): PowerNodeData {
  switch (type) {
    case 'source':
      return {
        type: 'source',
        label: 'Power Source',
        sourceMode: 'fixed',
        batteryMode: 'simple',
        nominalVoltage: 5.0,
        internalResistance: 0,
        capacityAtTemps: [],
        dischargeCurves: [],
        temperatureProfile: [],
        cutoffVoltage: 0,
      } as PowerSourceData;
    case 'converter':
      return {
        type: 'converter',
        label: 'DC-DC',
        converterType: 'switching',
        outputVoltage: 3.3,
        quiescentCurrent: 0.000020,
        efficiencyMode: 'flat' as const,
        flatEfficiency: 0.85,
        efficiencyCurves: [],
        enabled: true,
      } as PowerConverterData;
    case 'series':
      return {
        type: 'series',
        label: 'Load Switch',
        seriesMode: 'resistor',
        resistance: 0.050,
        forwardVoltage: 0,
        enabled: true,
      } as SeriesElementData;
    case 'load':
      return {
        type: 'load',
        label: 'Load',
        voltage: 3.3,
        loadMode: 'fixed_current',
        fixedCurrent: 0.010,
        loadProfile: [],
        resistance: 100,
        enabled: true,
      } as LoadData;
    default:
      return {
        type: 'source', label: 'Source', sourceMode: 'fixed', batteryMode: 'simple',
        nominalVoltage: 5.0, internalResistance: 0, capacityAtTemps: [],
        dischargeCurves: [], temperatureProfile: [], cutoffVoltage: 0,
      } as PowerSourceData;
  }
}

function heatScaleRGB(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  const stops: [number, number, number, number][] = [
    [0.0,  123, 111, 138],
    [0.25,  53, 120, 160],
    [0.5,   74, 168, 118],
    [0.75, 212, 162,  78],
    [1.0,  201,  80,  74],
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

function formatHeatPower(watts: number): string {
  if (watts >= 1) return `${watts.toFixed(1)}W`;
  if (watts >= 0.001) return `${(watts * 1000).toFixed(0)}mW`;
  return `${(watts * 1e6).toFixed(0)}uW`;
}

function HeatmapScale({ maxLoss }: { maxLoss: number }) {
  const steps = 32;
  const gradientStops = Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1);
    const mapped = t > 0 ? 0.08 + 0.92 * Math.pow(t, 0.35) : 0;
    const [r, g, b] = heatScaleRGB(mapped);
    return `rgb(${r},${g},${b})`;
  });
  const gradient = `linear-gradient(to top, ${gradientStops.join(', ')})`;

  return (
    <div className="heatmap-scale">
      <div className="heatmap-scale-label">{formatHeatPower(maxLoss)}</div>
      <div className="heatmap-scale-bar" style={{ background: gradient }} />
      <div className="heatmap-scale-label">0</div>
    </div>
  );
}

function FractionInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [local, setLocal] = useState((value * 100).toFixed(0));
  const committed = useRef(value);
  useEffect(() => {
    if (value !== committed.current) {
      setLocal((value * 100).toFixed(0));
      committed.current = value;
    }
  }, [value]);
  const commit = () => {
    const v = parseFloat(local);
    const clamped = isNaN(v) ? 0 : Math.max(0, Math.min(100, v));
    setLocal(clamped.toFixed(0));
    const fraction = clamped / 100;
    if (fraction !== committed.current) {
      committed.current = fraction;
      onChange(fraction);
    }
  };
  return (
    <label className="state-fraction-label">
      <input
        type="text"
        inputMode="decimal"
        value={local}
        onChange={e => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); }}
      />
      %
    </label>
  );
}

let _analysisFingerprint = '';
let _nodeFpCache = new WeakMap<Record<string, unknown>, string>();
let _edgesFpCache: { ref: unknown; fp: string } = { ref: null, fp: '' };
let _statesFpCache: { ref: unknown; fp: string } = { ref: null, fp: '' };

function FlowCanvas({ theme, onSetTheme, heatmap, projectNotes, onSetProjectNotes, onSetNotesOpen, nodeListRef, navigateToNodeRef }: { theme: 'dark' | 'light'; onSetTheme: (t: 'dark' | 'light') => void; heatmap: boolean; projectNotes: NoteBullet[]; onSetProjectNotes: (n: NoteBullet[]) => void; onSetNotesOpen: (v: boolean) => void; nodeListRef: React.MutableRefObject<{ id: string; label: string }[]>; navigateToNodeRef: React.MutableRefObject<(nodeId: string) => void> }) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, setCenter, getZoom, fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [resultsMounted, setResultsMounted] = useState(false);
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [scenarioTimeSeries, setScenarioTimeSeries] = useState<ScenarioTimeSeries[]>([]);
  const [batteryDischargeSeries, setBatteryDischargeSeries] = useState<Map<string, BatteryTimeSeriesPoint[]>>(new Map());
  const [heatmapMaxLoss, setHeatmapMaxLoss] = useState(0);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [isCalculating, setIsCalculating] = useState(false);
  const [autoCalc, setAutoCalc] = useState(true);
  const [analysisStale, setAnalysisStale] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [projectName, setProjectName] = useState('Untitled Project');
  const [powerStates, setPowerStates] = useState<PowerState[]>([
    { id: 'active', name: 'Active', fractionOfTime: 0.5, loadSnapshots: {} },
    { id: 'sleep', name: 'Sleep', fractionOfTime: 0.5, loadSnapshots: {} },
  ]);
  const [activeStateId, setActiveStateId] = useState('active');
  const activeStateIdRef = useRef(activeStateId);
  const [activeScenario, setActiveScenario] = useState<VoltageScenario>('nom');

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string; nodeLabel: string } | null>(null);

  // Keep nodeListRef and navigateToNodeRef in sync for Sidebar
  nodeListRef.current = (nodes as Node[])
    .filter(n => n.type !== 'groupNode' && n.type !== 'textNode')
    .map(n => ({ id: n.id, label: ((n.data as Record<string, unknown>).label as string) || n.id }));

  navigateToNodeRef.current = (nodeId: string) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    const w = node.measured?.width ?? node.width ?? 150;
    const h = node.measured?.height ?? node.height ?? 80;
    setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: getZoom(), duration: 200 });
  };

  // Undo/redo history
  interface Snapshot {
    nodes: Node[];
    edges: Edge[];
    powerStates: PowerState[];
    activeStateId: string;
  }
  const historyRef = useRef<Snapshot[]>([]);
  const historyIndexRef = useRef(-1);
  const isUndoRedoRef = useRef(false);

  const pushHistory = useCallback(() => {
    if (isUndoRedoRef.current) return;
    const snap: Snapshot = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges)),
      powerStates: JSON.parse(JSON.stringify(powerStates)),
      activeStateId,
    };
    const history = historyRef.current;
    const idx = historyIndexRef.current;
    historyRef.current = [...history.slice(0, idx + 1), snap].slice(-50);
    historyIndexRef.current = historyRef.current.length - 1;
  }, [nodes, edges, powerStates, activeStateId]);

  const pushHistoryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePushHistory = useCallback(() => {
    if (pushHistoryTimer.current) clearTimeout(pushHistoryTimer.current);
    pushHistoryTimer.current = setTimeout(() => pushHistory(), 300);
  }, [pushHistory]);

  const prevNodesRef = useRef(nodes);
  const prevEdgesRef = useRef(edges);
  const prevStatesRef = useRef(powerStates);
  const prevActiveRef = useRef(activeStateId);
  useEffect(() => {
    const changed = nodes !== prevNodesRef.current || edges !== prevEdgesRef.current
      || powerStates !== prevStatesRef.current || activeStateId !== prevActiveRef.current;
    prevNodesRef.current = nodes;
    prevEdgesRef.current = edges;
    prevStatesRef.current = powerStates;
    prevActiveRef.current = activeStateId;
    if (!changed) return;
    if (isUndoRedoRef.current) {
      isUndoRedoRef.current = false;
      return;
    }
    schedulePushHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, powerStates, activeStateId]);

  const undo = useCallback(() => {
    const idx = historyIndexRef.current;
    if (idx <= 0) return;
    const newIdx = idx - 1;
    const snap = historyRef.current[newIdx];
    if (!snap) return;
    // Cancel any pending debounced history push
    if (pushHistoryTimer.current) { clearTimeout(pushHistoryTimer.current); pushHistoryTimer.current = null; }
    isUndoRedoRef.current = true;
    historyIndexRef.current = newIdx;
    syncNodeIdCounter(snap.nodes as Node[]);
    setNodes(snap.nodes as Node[]);
    setEdges(snap.edges as Edge[]);
    setPowerStates(snap.powerStates);
    setActiveStateId(snap.activeStateId);
    activeStateIdRef.current = snap.activeStateId;
    setSelectedNode(null);
  }, [setNodes, setEdges, setPowerStates]);

  const redo = useCallback(() => {
    const idx = historyIndexRef.current;
    if (idx >= historyRef.current.length - 1) return;
    const newIdx = idx + 1;
    const snap = historyRef.current[newIdx];
    if (!snap) return;
    if (pushHistoryTimer.current) { clearTimeout(pushHistoryTimer.current); pushHistoryTimer.current = null; }
    isUndoRedoRef.current = true;
    historyIndexRef.current = newIdx;
    syncNodeIdCounter(snap.nodes as Node[]);
    setNodes(snap.nodes as Node[]);
    setEdges(snap.edges as Edge[]);
    setPowerStates(snap.powerStates);
    setActiveStateId(snap.activeStateId);
    activeStateIdRef.current = snap.activeStateId;
    setSelectedNode(null);
  }, [setNodes, setEdges, setPowerStates]);

  // Clipboard for copy/cut/paste
  const clipboardRef = useRef<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const saveProjectRef = useRef<(() => void) | null>(null);
  const runManualAnalysisRef = useRef<(() => void) | null>(null);

  const copySelected = useCallback(() => {
    const selected = (nodes as unknown as Node[]).filter(n => n.selected);
    if (selected.length === 0) return;
    const selectedIds = new Set(selected.map(n => n.id));
    const internalEdges = (edges as unknown as Edge[]).filter(
      e => selectedIds.has(e.source) && selectedIds.has(e.target)
    );
    clipboardRef.current = {
      nodes: JSON.parse(JSON.stringify(selected.map(n => {
        const { _analysis, _activeStateId, _activeScenario, _heatmap, _maxLoss, _notes, ...rest } = n.data as Record<string, unknown>;
        void _analysis; void _activeStateId; void _activeScenario; void _heatmap; void _maxLoss; void _notes;
        return { ...n, data: rest };
      }))),
      edges: JSON.parse(JSON.stringify(internalEdges.map(e => ({
        id: e.id, source: e.source, target: e.target,
        sourceHandle: e.sourceHandle, targetHandle: e.targetHandle,
      })))),
    };
  }, [nodes, edges]);

  const cutSelected = useCallback(() => {
    copySelected();
    const selected = (nodes as unknown as Node[]).filter(n => n.selected);
    const selectedIds = new Set(selected.map(n => n.id));
    setNodes(nds => nds.filter(n => !selectedIds.has(n.id)));
    setEdges(eds => eds.filter(e => !selectedIds.has(e.source) && !selectedIds.has(e.target)));
    setSelectedNode(null);
  }, [copySelected, nodes, setNodes, setEdges]);

  const pasteClipboard = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip || clip.nodes.length === 0) return;
    const idMap = new Map<string, string>();
    const newNodes: Node[] = clip.nodes.map(n => {
      const newId = getNextId();
      idMap.set(n.id, newId);
      return {
        ...n,
        id: newId,
        position: { x: n.position.x + 40, y: n.position.y + 40 },
        selected: true,
      };
    });
    const pastedIds = new Set(clip.nodes.map(n => n.id));
    const newEdges: Edge[] = clip.edges
      .filter(e => pastedIds.has(e.source) && pastedIds.has(e.target))
      .map(e => ({
        id: `e_${idMap.get(e.source)}_${idMap.get(e.target)}`,
        source: idMap.get(e.source)!,
        target: idMap.get(e.target)!,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        type: 'smart',
        animated: true,
        style: { stroke: theme === 'light' ? '#2A9D8F' : '#4ECDC4', strokeWidth: 2 },
      }));
    setNodes(nds => [...nds.map(n => ({ ...n, selected: false })), ...newNodes]);
    setEdges(eds => [...eds, ...newEdges]);
    // Add per-state snapshots and enabled overrides for pasted nodes
    setPowerStates(prev => prev.map(s => {
      const newSnapshots = { ...s.loadSnapshots };
      const newEnabled = { ...s.enabledOverrides };
      const newAuxOv = { ...(s.auxLoadOverrides || {}) };
      for (const origNode of clip.nodes) {
        const newId = idMap.get(origNode.id);
        if (!newId) continue;
        const d = origNode.data as unknown as PowerNodeData;
        if (d.type === 'load') {
          // Copy the snapshot from the original node if it exists, otherwise use current data
          newSnapshots[newId] = JSON.parse(JSON.stringify(s.loadSnapshots[origNode.id] ?? origNode.data));
        }
        if (d.type === 'converter' || d.type === 'series' || d.type === 'load') {
          newEnabled[newId] = s.enabledOverrides?.[origNode.id] ?? (d as { enabled?: boolean }).enabled !== false;
        }
        if (s.auxLoadOverrides?.[origNode.id]) {
          newAuxOv[newId] = JSON.parse(JSON.stringify(s.auxLoadOverrides[origNode.id]));
        }
      }
      return { ...s, loadSnapshots: newSnapshots, enabledOverrides: newEnabled, auxLoadOverrides: newAuxOv };
    }));
    // Update clipboard positions so next paste offsets further
    clipboardRef.current = {
      nodes: clip.nodes.map(n => ({ ...n, position: { x: n.position.x + 40, y: n.position.y + 40 } })),
      edges: clip.edges,
    };
  }, [setNodes, setEdges, theme]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
      if (isInput) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
        e.preventDefault();
        copySelected();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'x') {
        e.preventDefault();
        cutSelected();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
        e.preventDefault();
        pasteClipboard();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveProjectRef.current?.();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'r') {
        e.preventDefault();
        runManualAnalysisRef.current?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, copySelected, cutSelected, pasteClipboard]);

  const onConnect = useCallback(
    (params: Connection) => {
      if (!params.source || !params.target) return;
      // Prevent circular connections: walk from source up the ancestor chain
      // to check if target is an ancestor of source
      setEdges(eds => {
        const wouldCreateCycle = (source: string, target: string): boolean => {
          const visited = new Set<string>();
          const queue = [target];
          while (queue.length > 0) {
            const cur = queue.pop()!;
            if (cur === source) return true;
            if (visited.has(cur)) continue;
            visited.add(cur);
            for (const e of eds) {
              if (e.source === cur) queue.push(e.target);
            }
          }
          return false;
        };
        if (wouldCreateCycle(params.source!, params.target!)) return eds;
        // Prevent multiple parents: target should not already have an incoming edge
        if (eds.some(e => e.target === params.target)) return eds;
        return addEdge({
          ...params,
          type: 'smart',
          animated: true,
          style: { stroke: theme === 'light' ? '#2A9D8F' : '#4ECDC4', strokeWidth: 2 },
        }, eds);
      });
    },
    [setEdges, theme]
  );

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const snapshotCurrentLoads = useCallback((): Record<string, LoadData> => {
    const snap: Record<string, LoadData> = {};
    const allNodes = nodes as unknown as Node[];
    for (const n of allNodes) {
      const d = n.data as unknown as PowerNodeData;
      if (d.type === 'load') {
        const { _analysis, _activeStateId, _activeScenario, _heatmap, _maxLoss, _notes, ...rest } = n.data as Record<string, unknown>;
        void _analysis; void _activeStateId; void _activeScenario; void _heatmap; void _maxLoss; void _notes;
        snap[n.id] = rest as unknown as LoadData;
      }
    }
    return snap;
  }, [nodes]);

  const switchState = useCallback((newStateId: string) => {
    if (newStateId === activeStateIdRef.current) return;
    const currentSnap = snapshotCurrentLoads();

    skipAnalysisRef.current = true;
    setPowerStates(prev => {
      const updated = prev.map(s => {
        if (s.id !== activeStateIdRef.current) return s;
        const newLoadSnaps = { ...s.loadSnapshots, ...currentSnap };
        const prevOv = s.enabledOverrides ?? {};
        const newEnabledOv = { ...prevOv };
        let ovChanged = false;
        for (const n of nodes as unknown as Node[]) {
          const d = n.data as unknown as PowerNodeData;
          if (d.type === 'converter' || d.type === 'series' || d.type === 'load') {
            const cur = (d as { enabled?: boolean }).enabled !== false;
            const old = n.id in prevOv ? prevOv[n.id] : undefined;
            if (old !== cur) { newEnabledOv[n.id] = cur; ovChanged = true; }
          }
        }
        if (JSON.stringify(newLoadSnaps) === JSON.stringify(s.loadSnapshots) && !ovChanged) {
          return s;
        }
        return { ...s, loadSnapshots: newLoadSnaps, enabledOverrides: ovChanged ? newEnabledOv : prevOv };
      });
      if (updated.every((s, i) => s === prev[i])) return prev;
      return updated;
    });

    const targetState = powerStates.find(s => s.id === newStateId);
    if (targetState) {
      setNodes(nds => nds.map(n => {
        const d = n.data as Record<string, unknown>;
        const nodeType = (d as unknown as PowerNodeData).type;

        // Build a new data object — never mutate the existing one
        let newData = { ...d };

        if (targetState.enabledOverrides && n.id in targetState.enabledOverrides &&
            (nodeType === 'converter' || nodeType === 'series' || nodeType === 'load')) {
          newData = { ...newData, enabled: targetState.enabledOverrides[n.id] };
        }

        if (nodeType !== 'load') return { ...n, data: newData };
        const snap = targetState.loadSnapshots[n.id];
        if (snap) {
          const enabled = targetState.enabledOverrides?.[n.id] ?? (snap.enabled !== false);
          // Restore everything from the snapshot (including loadMode and resistance)
          return { ...n, data: { ...snap, label: d.label, enabled, _analysis: d._analysis, _activeStateId: newStateId } };
        }
        return { ...n, data: newData };
      }));
    }

    activeStateIdRef.current = newStateId;
    setActiveStateId(newStateId);

    if (targetState) {
      setSelectedNode(prev => {
        if (!prev) return null;
        const d = prev.data as unknown as PowerNodeData;
        if (d.type === 'load') {
          const snap = targetState.loadSnapshots[prev.id];
          if (snap) {
            const pd = prev.data as Record<string, unknown>;
            const enabled = targetState.enabledOverrides?.[prev.id] ?? (snap.enabled !== false);
            return { ...prev, data: { ...snap, label: pd.label, enabled, _analysis: pd._analysis, _activeStateId: newStateId } };
          }
        }
        if (d.type === 'converter' || d.type === 'series') {
          const enabled = targetState.enabledOverrides?.[prev.id] ?? (d as { enabled?: boolean }).enabled !== false;
          return { ...prev, data: { ...prev.data as Record<string, unknown>, enabled } };
        }
        return prev;
      });
    }
  }, [snapshotCurrentLoads, powerStates, nodes, setNodes, setPowerStates]);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/powernode');
      if (!type) return;

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const newId = getNextId();

      if (type === 'group') {
        const newNode: Node = {
          id: newId,
          type: 'groupNode',
          position,
          style: { width: 300, height: 200 },
          zIndex: -1,
          data: {},
        };
        setNodes(nds => [...nds, newNode]);
        return;
      }

      if (type === 'text') {
        const textNodeId = newId;
        const newNode: Node = {
          id: textNodeId,
          type: 'textNode',
          position,
          zIndex: 10,
          data: {
            text: 'Text', fontSize: 14, color: 'var(--text)',
            _onTextChange: (text: string) => { onTextNodeChange(textNodeId, { text }); },
          },
        };
        setNodes(nds => [...nds, newNode]);
        return;
      }

      const data = defaultDataForType(type);

      const newNode: Node = {
        id: newId,
        type: 'powerNode',
        position,
        data,
      };

      setNodes(nds => [...nds, newNode]);

      if (data.type === 'load') {
        setPowerStates(prev => prev.map(s => ({
          ...s,
          loadSnapshots: { ...s.loadSnapshots, [newId]: JSON.parse(JSON.stringify(data)) },
        })));
      }
    },
    [screenToFlowPosition, setNodes, setPowerStates]
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.type === 'groupNode') return;
    const w = node.measured?.width ?? node.width ?? 150;
    const h = node.measured?.height ?? node.height ?? 80;
    setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: getZoom(), duration: 200 });
    requestAnimationFrame(() => {
      setShowResults(false);
      setSelectedNode(node);
    });
  }, [setCenter, getZoom]);

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    if (node.type === 'groupNode' || node.type === 'textNode') return;
    e.preventDefault();
    const label = ((node.data as Record<string, unknown>).label as string) || node.id;
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id, nodeLabel: label });
  }, []);

  const addNoteForNode = useCallback((nId: string) => {
    const node = (nodes as Node[]).find(n => n.id === nId);
    const label = node ? ((node.data as Record<string, unknown>).label as string) || nId : nId;
    const bullet: NoteBullet = { id: crypto.randomUUID(), text: '\u2022 @' + label + ' ', nodeIds: [nId] };
    onSetProjectNotes([...projectNotes, bullet]);
    onSetNotesOpen(true);
    setContextMenu(null);
  }, [projectNotes, onSetProjectNotes, onSetNotesOpen, nodes]);

  const onTextNodeChange = useCallback((nodeId: string, updates: Record<string, unknown>) => {
    setNodes(nds => nds.map(n => {
      if (n.id !== nodeId) return n;
      const newData = { ...n.data, ...updates };
      // Inject the text change callback for TextNode
      if (n.type === 'textNode') {
        (newData as Record<string, unknown>)._onTextChange = (text: string) => {
          onTextNodeChange(nodeId, { text });
        };
      }
      return { ...n, data: newData };
    }));
    setSelectedNode(prev => prev && prev.id === nodeId ? { ...prev, data: { ...prev.data, ...updates } } : prev);
  }, [setNodes]);

  useEffect(() => {
    if (showResults && results.length > 0) {
      setResultsMounted(true);
    } else {
      const id = setTimeout(() => setResultsMounted(false), 2000);
      return () => clearTimeout(id);
    }
  }, [showResults, results.length]);

  const closeResults = useCallback(() => setShowResults(false), []);

  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);

  const onFlowMouseDown = useCallback((e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onPaneClick = useCallback((event: unknown) => {
    const e = event as MouseEvent;
    const start = mouseDownPos.current;
    if (start) {
      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - start.y);
      if (dx > 5 || dy > 5) return;
    }
    setSelectedNode(null);
    setShowResults(false);
    setContextMenu(null);
  }, []);

  const closeConfigPanel = useCallback(() => setSelectedNode(null), []);

  const onNodesDelete = useCallback((deleted: Node[]) => {
    setSelectedNode(prev => {
      if (prev && deleted.some(n => n.id === prev.id)) return null;
      return prev;
    });
  }, []);

  const updateNodeData = useCallback(
    (id: string, data: PowerNodeData) => {
      const isSwitch = data.type === 'converter' || data.type === 'series';
      const switchEnabled = isSwitch ? (data as { enabled?: boolean }).enabled !== false : true;

      setNodes(nds => {
        let changed = false;
        const updated = nds.map(n => {
          if (n.id !== id) return n;
          const prev = n.data as Record<string, unknown>;
          const { _analysis, _activeStateId, _activeScenario, _heatmap, _maxLoss, ...prevRest } = prev;
          const { _analysis: _a2, _activeStateId: _s2, _activeScenario: _sc2, _heatmap: _h2, _maxLoss: _m2, ...newRest } = data as unknown as Record<string, unknown>;
          void _a2; void _s2; void _sc2; void _h2; void _m2;
          if (JSON.stringify(prevRest) === JSON.stringify(newRest)) return n;
          changed = true;
          return { ...n, data: { ...data, _analysis, _activeStateId, _activeScenario, _heatmap, _maxLoss } };
        });
        if (!changed) return nds;
        if (isSwitch) {
          const descendants = new Set<string>();
          const walk = (nid: string) => {
            for (const e of edges) {
              if (e.source === nid && !descendants.has(e.target)) {
                descendants.add(e.target);
                walk(e.target);
              }
            }
          };
          walk(id);
          if (descendants.size > 0) {
            return updated.map(n => {
              if (!descendants.has(n.id)) return n;
              const a = (n.data as Record<string, unknown>)?._analysis as Record<string, unknown> | undefined;
              if (!a) return n;
              return { ...n, data: { ...n.data, _analysis: { ...a, disabled: !switchEnabled } } };
            });
          }
        }
        return updated;
      });
      setSelectedNode(prev => (prev && prev.id === id ? { ...prev, data } : prev));
      setResults(prev => {
        const old = prev.find(r => r.nodeId === id);
        if (old && old.label !== data.label) {
          return prev.map(r => r.nodeId === id ? { ...r, label: data.label } : r);
        }
        return prev;
      });
      if (data.type === 'load') {
        setPowerStates(prev => prev.map(s =>
          s.id === activeStateIdRef.current
            ? { ...s, loadSnapshots: { ...s.loadSnapshots, [id]: data as LoadData }, enabledOverrides: { ...s.enabledOverrides, [id]: (data as LoadData).enabled !== false } }
            : s
        ));
      } else if (isSwitch) {
        setPowerStates(prev => prev.map(s =>
          s.id === activeStateIdRef.current
            ? { ...s, enabledOverrides: { ...s.enabledOverrides, [id]: switchEnabled } }
            : s
        ));
      }
    },
    [setNodes, setPowerStates, edges]
  );

  const onAuxOverrideToggle = useCallback((nodeId: string, auxId: string, enabled: boolean) => {
    setPowerStates(prev => prev.map(s => {
      if (s.id !== activeStateIdRef.current) return s;
      const nodeOverrides = { ...(s.auxLoadOverrides?.[nodeId] || {}), [auxId]: enabled };
      return { ...s, auxLoadOverrides: { ...(s.auxLoadOverrides || {}), [nodeId]: nodeOverrides } };
    }));
  }, [setPowerStates]);

  const deleteNode = useCallback(
    (id: string) => {
      setNodes(nds => nds.filter(n => n.id !== id));
      setEdges(eds => eds.filter(e => e.source !== id && e.target !== id));
      setSelectedNode(null);
      setPowerStates(prev => prev.map(s => {
        const ls = { ...s.loadSnapshots };
        delete ls[id];
        const eo = s.enabledOverrides ? { ...s.enabledOverrides } : undefined;
        if (eo) delete eo[id];
        const ao = s.auxLoadOverrides ? { ...s.auxLoadOverrides } : undefined;
        if (ao) delete ao[id];
        return { ...s, loadSnapshots: ls, enabledOverrides: eo, auxLoadOverrides: ao };
      }));
    },
    [setNodes, setEdges, setPowerStates]
  );

  // Auto-run analysis whenever nodes or edges change (fingerprint prevents redundant runs).
  // Fingerprint computation is deferred so selection-only changes don't block the UI.
  const ANALYSIS_VERSION = 15;

  const runAnalysis = useRef<() => void>();
  runAnalysis.current = () => {
    const powerNodes = nodes.filter(n => n.type !== 'groupNode' && n.type !== 'textNode');
    let r: AnalysisResult[];
    let sts: ScenarioTimeSeries[];
    let bds: Map<string, BatteryTimeSeriesPoint[]>;
    let diags: Diagnostic[] = [];
    try {
      const out = analyzeTree(powerNodes, edges, powerStates);
      r = out.results;
      sts = out.scenarioTimeSeries;
      bds = out.batteryDischargeSeries;
      diags = out.diagnostics;
    } catch (err) {
      console.error('Analysis error:', err);
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(0, 3).join('\n')}` : String(err);
      diags = [{ severity: 'error', message: `Analysis failed: ${errMsg}` }];
      r = [];
      sts = [];
      bds = new Map();
    }
    setResults(r);
    setDiagnostics(diags);
    setScenarioTimeSeries(sts);
    setBatteryDischargeSeries(bds);

    const resultMap = new Map(r.map(res => [res.nodeId, res]));
    const heatVal = (res: AnalysisResult) => res.type === 'load' ? res.inputPowerAvg : (res.powerLossAvg + (res.auxPowerAvg ?? 0));
    const maxLoss = Math.max(...r.map(heatVal), 0);
    setHeatmapMaxLoss(maxLoss);
    setNodes(nds => {
      let changed = false;
      const updated = nds.map(n => {
        const d = n.data as Record<string, unknown>;
        const res = resultMap.get(n.id);
        if (d._analysis === res && d._activeStateId === activeStateId
          && d._activeScenario === activeScenario && d._heatmap === heatmap && d._maxLoss === maxLoss) {
          return n;
        }
        changed = true;
        return { ...n, data: { ...d, _analysis: res, _activeStateId: activeStateId, _activeScenario: activeScenario, _heatmap: heatmap, _maxLoss: maxLoss } };
      });
      return changed ? updated : nds;
    });

    const edgeColors = theme === 'light'
      ? { active: '#2A9D8F', disabled: '#C5BFAE', labelDim: '#999', labelNorm: '#7A7568', labelBg: '#FEFCF8' }
      : { active: '#4ECDC4', disabled: '#3A3E48', labelDim: '#555', labelNorm: '#8B8F9A', labelBg: '#1E222A' };

    const curState = powerStates.find(s => s.id === activeStateId);
    const stateOff = new Set<string>();
    if (curState) {
      const nm = new Map(nodes.map(n => [n.id, n]));
      const pm = new Map<string, string>();
      for (const e of edges) pm.set(e.target, e.source);
      const oc = new Map<string, boolean>();
      const isOff = (nid: string): boolean => {
        if (oc.has(nid)) return oc.get(nid)!;
        const nd = nm.get(nid);
        if (!nd) { oc.set(nid, false); return false; }
        const d = nd.data as Record<string, unknown>;
        const nt = d.type as string;
        let off = false;
        if (nt === 'series' || nt === 'converter' || nt === 'load') {
          if (curState.enabledOverrides && nid in curState.enabledOverrides) {
            off = !curState.enabledOverrides[nid];
          } else if ((d as { enabled?: boolean }).enabled === false) {
            off = true;
          }
        }
        if (!off) {
          const pid = pm.get(nid);
          if (pid) off = isOff(pid);
        }
        oc.set(nid, off);
        return off;
      };
      for (const n of nodes) {
        if (isOff(n.id)) stateOff.add(n.id);
      }
    }

    setEdges(eds => {
      let eChanged = false;
      const updatedEdges = eds.map(e => {
        const sourceResult = resultMap.get(e.source);
        const targetResult = resultMap.get(e.target);
        const isEdgeDisabled = stateOff.has(e.source) || stateOff.has(e.target)
          || sourceResult?.disabled === true || targetResult?.disabled === true;
        const scenarioStates = activeScenario ? targetResult?.scenarioStateResults?.[activeScenario] : undefined;
        const stateRes = scenarioStates?.[activeStateId] ?? targetResult?.stateResults?.[activeStateId];
        const currentA = stateRes?.currentOut ?? targetResult?.currentOut ?? 0;
        let label: string;
        if (currentA >= 1) label = `${currentA.toFixed(2)} A`;
        else if (currentA >= 0.001) label = `${(currentA * 1000).toFixed(1)} mA`;
        else if (currentA > 0) label = `${(currentA * 1e6).toFixed(0)} uA`;
        else label = '0 mA';

        if (e.label === label && e.animated === !isEdgeDisabled) return e;
        eChanged = true;

        const edgeStyle = isEdgeDisabled
          ? { stroke: edgeColors.disabled, strokeWidth: 1.5, strokeDasharray: '6 3' }
          : { stroke: edgeColors.active, strokeWidth: 2 };
        const labelFill = isEdgeDisabled ? edgeColors.labelDim : edgeColors.labelNorm;

        return { ...e, label, animated: !isEdgeDisabled, style: edgeStyle,
          labelStyle: { fill: labelFill, fontSize: 10, fontWeight: 600 },
          labelBgStyle: { fill: edgeColors.labelBg, fillOpacity: 0.9 },
          labelBgPadding: [4, 2] as [number, number] };
      });
      return eChanged ? updatedEdges : eds;
    });
    setIsCalculating(false);
  };

  const analysisRafRef = useRef<number>(0);
  const skipAnalysisRef = useRef(false);
  const autoCalcRef = useRef(autoCalc);
  autoCalcRef.current = autoCalc;

  const toggleAutoCalc = useCallback(() => {
    setAutoCalc(prev => {
      const next = !prev;
      if (next) {
        setAnalysisStale(stale => {
          if (stale) {
            if (analysisRafRef.current) cancelAnimationFrame(analysisRafRef.current);
            setIsCalculating(true);
            analysisRafRef.current = requestAnimationFrame(() => {
              analysisRafRef.current = requestAnimationFrame(() => {
                analysisRafRef.current = 0;
                runAnalysis.current?.();
              });
            });
          }
          return false;
        });
      }
      return next;
    });
  }, []);

  const analysisFp = (() => {
    const cache = _nodeFpCache;
    const nodeParts: string[] = [];
    for (const n of nodes) {
      if (n.type === 'groupNode' || n.type === 'textNode') continue;
      const d = n.data as Record<string, unknown>;
      let cached = cache.get(d);
      if (!cached) {
        const { _analysis, _activeStateId, _activeScenario, _heatmap, _maxLoss, _notes, enabled: _en, label: _lbl, ...rest } = d;
        void _analysis; void _activeStateId; void _activeScenario; void _heatmap; void _maxLoss; void _notes; void _en; void _lbl;
        cached = n.id + ':' + JSON.stringify(rest);
        cache.set(d, cached);
      }
      nodeParts.push(cached);
    }
    if (_edgesFpCache.ref !== edges) {
      _edgesFpCache = { ref: edges, fp: edges.map(e => e.source + '-' + e.target).join('|') };
    }
    if (_statesFpCache.ref !== powerStates) {
      _statesFpCache = { ref: powerStates, fp: JSON.stringify(powerStates) };
    }
    return nodeParts.join('|') + '||' + _edgesFpCache.fp
      + '||' + _statesFpCache.fp + '||v' + ANALYSIS_VERSION;
  })();

  useEffect(() => {
    const skip = skipAnalysisRef.current;
    if (skip) skipAnalysisRef.current = false;

    if (analysisFp === _analysisFingerprint) return;
    _analysisFingerprint = analysisFp;
    if (skip) return;

    if (nodes.length === 0) {
      setResults([]);
      setScenarioTimeSeries([]);
      setBatteryDischargeSeries(new Map());
      setDiagnostics([]);
      setAnalysisStale(false);
      return;
    }

    if (!autoCalcRef.current) {
      setAnalysisStale(true);
      return;
    }

    setAnalysisStale(false);
    if (analysisRafRef.current) cancelAnimationFrame(analysisRafRef.current);
    setIsCalculating(true);
    analysisRafRef.current = requestAnimationFrame(() => {
      analysisRafRef.current = requestAnimationFrame(() => {
        analysisRafRef.current = 0;
        runAnalysis.current?.();
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisFp]);

  // Re-inject display props when activeScenario or activeStateId changes (no re-analysis needed)
  useEffect(() => {
    if (results.length === 0) return;
    const resultMap = new Map(results.map(res => [res.nodeId, res]));
    const heatVal = (res: AnalysisResult) => res.type === 'load' ? res.inputPowerAvg : (res.powerLossAvg + (res.auxPowerAvg ?? 0));
    const maxLoss = Math.max(...results.map(heatVal), 0);
    setNodes(nds => {
      let changed = false;
      const updated = nds.map(n => {
        const d = n.data as Record<string, unknown>;
        const res = resultMap.get(n.id);
        if (d._analysis === res && d._activeStateId === activeStateId
          && d._activeScenario === activeScenario && d._heatmap === heatmap && d._maxLoss === maxLoss) {
          return n;
        }
        changed = true;
        return { ...n, data: { ...n.data, _analysis: res, _activeStateId: activeStateId, _activeScenario: activeScenario, _heatmap: heatmap, _maxLoss: maxLoss } };
      });
      return changed ? updated : nds;
    });

    const edgeColors = theme === 'light'
      ? { active: '#2A9D8F', disabled: '#C5BFAE', labelDim: '#999', labelNorm: '#7A7568', labelBg: '#FEFCF8' }
      : { active: '#4ECDC4', disabled: '#3A3E48', labelDim: '#555', labelNorm: '#8B8F9A', labelBg: '#1E222A' };

    // Build per-state disabled set: a node is disabled in this state if its
    // enabledOverride is false (or base enabled is false with no override),
    // OR if any ancestor in the tree is disabled in this state.
    const activeState = powerStates.find(s => s.id === activeStateId);
    const stateDisabled = new Set<string>();
    if (activeState) {
      const nodeMap = new Map(nodes.map(n => [n.id, n]));
      const parentMap = new Map<string, string>();
      for (const e of edges) parentMap.set(e.target, e.source);
      const cache = new Map<string, boolean>();
      const isNodeOffInState = (nid: string): boolean => {
        if (cache.has(nid)) return cache.get(nid)!;
        const nd = nodeMap.get(nid);
        if (!nd) { cache.set(nid, false); return false; }
        const d = nd.data as Record<string, unknown>;
        const nodeType = d.type as string;
        let off = false;
        if (nodeType === 'series' || nodeType === 'converter' || nodeType === 'load') {
          if (activeState.enabledOverrides && nid in activeState.enabledOverrides) {
            off = !activeState.enabledOverrides[nid];
          } else if ((d as { enabled?: boolean }).enabled === false) {
            off = true;
          }
        }
        if (!off) {
          const pid = parentMap.get(nid);
          if (pid) off = isNodeOffInState(pid);
        }
        cache.set(nid, off);
        return off;
      };
      for (const n of nodes) {
        if (isNodeOffInState(n.id)) stateDisabled.add(n.id);
      }
    }

    setEdges(eds => eds.map(e => {
      const targetResult = resultMap.get(e.target);
      const isEdgeDisabled = stateDisabled.has(e.source) || stateDisabled.has(e.target)
        || resultMap.get(e.source)?.disabled === true || targetResult?.disabled === true;
      const scenarioStates = activeScenario ? targetResult?.scenarioStateResults?.[activeScenario] : undefined;
      const stateRes = scenarioStates?.[activeStateId] ?? targetResult?.stateResults?.[activeStateId];
      const currentA = stateRes?.currentOut ?? targetResult?.currentOut ?? 0;
      let label: string;
      if (currentA >= 1) label = `${currentA.toFixed(2)} A`;
      else if (currentA >= 0.001) label = `${(currentA * 1000).toFixed(1)} mA`;
      else if (currentA > 0) label = `${(currentA * 1e6).toFixed(0)} uA`;
      else label = '0 mA';
      const edgeStyle = isEdgeDisabled
        ? { stroke: edgeColors.disabled, strokeWidth: 1.5, strokeDasharray: '6 3' }
        : { stroke: edgeColors.active, strokeWidth: 2 };
      const animated = !isEdgeDisabled;
      const labelFill = isEdgeDisabled ? edgeColors.labelDim : edgeColors.labelNorm;
      return { ...e, label, animated, style: edgeStyle,
        labelStyle: { fill: labelFill, fontSize: 10, fontWeight: 600 },
        labelBgStyle: { fill: edgeColors.labelBg, fillOpacity: 0.9 },
        labelBgPadding: [4, 2] as [number, number] };
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScenario, activeStateId, theme, heatmap]);

  const nodeLabelFp = (() => {
    const parts: string[] = [];
    for (const n of nodes as Node[]) {
      if (n.type === 'groupNode' || n.type === 'textNode') continue;
      parts.push(n.id + ':' + (((n.data as Record<string, unknown>).label as string) || n.id));
    }
    return parts.join('|');
  })();

  useEffect(() => {
    const nodesByLabel = new Map<string, string>();
    for (const part of nodeLabelFp.split('|')) {
      if (!part) continue;
      const sep = part.indexOf(':');
      const id = part.slice(0, sep);
      const label = part.slice(sep + 1);
      nodesByLabel.set(label, id);
    }
    const labelsSorted = [...nodesByLabel.keys()].sort((a, b) => b.length - a.length);
    const notesByNode = new Map<string, string[]>();
    for (const b of projectNotes) {
      if (!b.text.trim()) continue;
      let searchPos = 0;
      while (searchPos < b.text.length) {
        const atIdx = b.text.indexOf('@', searchPos);
        if (atIdx < 0) break;
        const after = b.text.slice(atIdx + 1);
        const matchedLabel = labelsSorted.find(l => after.startsWith(l));
        if (matchedLabel) {
          const nId = nodesByLabel.get(matchedLabel)!;
          const arr = notesByNode.get(nId);
          if (arr) { if (!arr.includes(b.text)) arr.push(b.text); }
          else notesByNode.set(nId, [b.text]);
          searchPos = atIdx + 1 + matchedLabel.length;
        } else {
          searchPos = atIdx + 1;
        }
      }
    }
    setNodes(nds => {
      let changed = false;
      const updated = nds.map(n => {
        const d = n.data as Record<string, unknown>;
        const notes = notesByNode.get(n.id) ?? null;
        const prev = (d._notes as string[] | null) ?? null;
        if (notes === prev || (notes && prev && notes.length === prev.length && notes.every((t, i) => t === prev[i]))) return n;
        changed = true;
        return { ...n, data: { ...n.data, _notes: notes } };
      });
      return changed ? updated : nds;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectNotes, nodeLabelFp]);

  const resetProject = useCallback(() => {
    _analysisFingerprint = '';
    _nodeFpCache = new WeakMap();
    _edgesFpCache = { ref: null, fp: '' };
    _statesFpCache = { ref: null, fp: '' };
    setNodes([]);
    setEdges([]);
    setSelectedNode(null);
    setShowResults(false);
    setResults([]);
    setDiagnostics([]);
    setScenarioTimeSeries([]);
    setBatteryDischargeSeries(new Map());
    setProjectName('Untitled Project');
    onSetProjectNotes([]);
    setPowerStates([
      { id: 'active', name: 'Active', fractionOfTime: 0.5, loadSnapshots: {} },
      { id: 'sleep', name: 'Sleep', fractionOfTime: 0.5, loadSnapshots: {} },
    ]);
    setActiveStateId('active');
    activeStateIdRef.current = 'active';
    fileHandleRef.current = null;
    nodeId = 0;
    historyRef.current = [];
    historyIndexRef.current = -1;
  }, [setNodes, setEdges, setPowerStates]);

  const [showSaveConfirm, setShowSaveConfirm] = useState<'new' | 'load' | null>(null);
  const pendingLoadRef = useRef<(() => void) | null>(null);

  const newProject = useCallback(() => {
    if (nodes.length > 0) {
      setShowSaveConfirm('new');
    } else {
      resetProject();
    }
  }, [nodes.length, resetProject]);

  const handleSaveConfirm = useCallback(async (action: 'save' | 'discard' | 'cancel') => {
    const intent = showSaveConfirm;
    setShowSaveConfirm(null);
    if (action === 'cancel') {
      pendingLoadRef.current = null;
      return;
    }
    if (action === 'save') {
      await saveProjectRef.current?.();
    }
    if (intent === 'new') {
      resetProject();
    } else if (intent === 'load' && pendingLoadRef.current) {
      pendingLoadRef.current();
      pendingLoadRef.current = null;
    }
  }, [showSaveConfirm, resetProject]);

  const openResults = useCallback(() => {
    setShowResults(true);
    setSelectedNode(null);
  }, []);

  const runManualAnalysis = useCallback(() => {
    if (nodes.length === 0) return;
    setAnalysisStale(false);
    if (analysisRafRef.current) cancelAnimationFrame(analysisRafRef.current);
    setIsCalculating(true);
    analysisRafRef.current = requestAnimationFrame(() => {
      analysisRafRef.current = requestAnimationFrame(() => {
        analysisRafRef.current = 0;
        runAnalysis.current?.();
      });
    });
  }, [nodes.length]);
  runManualAnalysisRef.current = runManualAnalysis;

  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);

  const buildProjectJson = useCallback(() => {
    // Snapshot current state into powerStates before saving so any
    // unsaved toggle/load edits in the active state are persisted.
    const currentSnap = snapshotCurrentLoads();
    const enabledSnap: Record<string, boolean> = {};
    for (const n of nodes as unknown as Node[]) {
      const d = n.data as unknown as PowerNodeData;
      if (d.type === 'converter' || d.type === 'series' || d.type === 'load') {
        enabledSnap[n.id] = (d as { enabled?: boolean }).enabled !== false;
      }
    }
    const savedPowerStates = powerStates.map(s =>
      s.id === activeStateIdRef.current
        ? { ...s, loadSnapshots: { ...s.loadSnapshots, ...currentSnap }, enabledOverrides: { ...s.enabledOverrides, ...enabledSnap } }
        : s
    );

    const stripped = nodes.map(n => {
      const { _analysis, _activeStateId, _activeScenario, _heatmap, _maxLoss, _notes, ...rest } = n.data as Record<string, unknown>;
      void _analysis; void _activeStateId; void _activeScenario; void _heatmap; void _maxLoss; void _notes;
      return { ...n, data: rest };
    });
    return JSON.stringify({
      version: 4,
      projectName,
      notes: projectNotes,
      theme,
      activeScenario,
      powerStates: savedPowerStates,
      nodes: stripped.map(n => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data,
        ...(n.type === 'groupNode' ? { width: n.width ?? n.style?.width ?? 300, height: n.height ?? n.style?.height ?? 200, style: n.style, zIndex: -1 } : {}),
      })),
      edges: edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
      })),
    }, null, 2);
  }, [nodes, edges, powerStates, projectName, projectNotes, theme, activeScenario, snapshotCurrentLoads]);

  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (nodes.length === 0) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      try {
        localStorage.setItem('power-tree-autosave', buildProjectJson());
      } catch { /* storage full or unavailable */ }
    }, 1000);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [nodes, edges, powerStates, projectName, projectNotes, theme, activeScenario, buildProjectJson]);

  const [saveToast, setSaveToast] = useState(false);
  const showSaveToast = useCallback(() => {
    setSaveToast(true);
    setTimeout(() => setSaveToast(false), 1500);
  }, []);

  const saveProject = useCallback(async () => {
    const json = buildProjectJson();
    if (fileHandleRef.current) {
      try {
        const writable = await fileHandleRef.current.createWritable();
        await writable.write(json);
        await writable.close();
        showSaveToast();
        return;
      } catch {
        // Permission revoked or handle stale — fall through
      }
    }
    // No file handle — save to localStorage and show toast
    try { localStorage.setItem('power-tree-autosave', json); } catch { /* */ }
    showSaveToast();
  }, [buildProjectJson, showSaveToast]);

  saveProjectRef.current = saveProject;

  const saveAsProject = useCallback(async () => {
    const json = buildProjectJson();
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await (window as unknown as { showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
          suggestedName: `${projectName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'power-tree'}.json`,
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
        });
        fileHandleRef.current = handle;
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
        showSaveToast();
      } catch { /* user cancelled */ }
    } else {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${projectName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'power-tree'}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showSaveToast();
    }
  }, [buildProjectJson, projectName, showSaveToast]);

  const onTextNodeChangeRef = useRef(onTextNodeChange);
  onTextNodeChangeRef.current = onTextNodeChange;

  const loadProjectFromJson = useCallback((json: string) => {
    try {
      const project = JSON.parse(json);
      const loadedNodes: Node[] = project.nodes.map((n: { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown>; style?: Record<string, unknown>; zIndex?: number; width?: number; height?: number }) => {
        const nodeData = { ...n.data };
        if (n.type === 'textNode') {
          const nId = n.id;
          nodeData._onTextChange = (text: string) => { onTextNodeChangeRef.current(nId, { text }); };
        }
        return {
          id: n.id,
          type: n.type || 'powerNode',
          position: n.position,
          data: nodeData,
          ...(n.type === 'groupNode' ? { width: n.width ?? (n.style?.width as number) ?? 300, height: n.height ?? (n.style?.height as number) ?? 200, style: n.style, zIndex: -1 } : {}),
          ...(n.type === 'textNode' ? { zIndex: 10 } : {}),
        };
      });
      const loadedEdges: Edge[] = project.edges.map((ed: { id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string }) => ({
        id: ed.id,
        source: ed.source,
        target: ed.target,
        sourceHandle: ed.sourceHandle,
        targetHandle: ed.targetHandle,
        type: 'smart',
        animated: true,
        style: { stroke: theme === 'light' ? '#2A9D8F' : '#4ECDC4', strokeWidth: 2 },
      }));

      // Apply the first power state's snapshots and overrides to the loaded nodes
      let resolvedNodes = loadedNodes;
      if (project.powerStates && Array.isArray(project.powerStates) && project.powerStates.length > 0) {
        const firstState = project.powerStates[0] as PowerState;
        resolvedNodes = loadedNodes.map((n: Node) => {
          const d = n.data as Record<string, unknown>;
          const nodeType = (d as unknown as PowerNodeData).type;

          if (nodeType === 'load' && firstState.loadSnapshots && firstState.loadSnapshots[n.id]) {
            const snap = firstState.loadSnapshots[n.id];
            const enabled = firstState.enabledOverrides?.[n.id] ?? (snap.enabled !== false);
            return { ...n, data: { ...snap, enabled } };
          }

          if ((nodeType === 'converter' || nodeType === 'series') && firstState.enabledOverrides && n.id in firstState.enabledOverrides) {
            return { ...n, data: { ...d, enabled: firstState.enabledOverrides[n.id] } };
          }

          return n;
        });
      }

      setNodes(resolvedNodes);
      setEdges(loadedEdges);
      setSelectedNode(null);
      setShowResults(false);

      if (project.projectName) setProjectName(project.projectName);
      if (Array.isArray(project.notes)) {
        onSetProjectNotes(project.notes.map((b: NoteBullet) => {
          if (b.nodeId && !b.nodeIds) return { ...b, nodeIds: [b.nodeId] };
          return b;
        }));
      } else if (typeof project.notes === 'string' && project.notes.trim()) {
        onSetProjectNotes(project.notes.split('\n').filter((l: string) => l.trim()).map((l: string) => ({ id: crypto.randomUUID(), text: l.trim() })));
      } else {
        onSetProjectNotes([]);
      }
      if (project.theme) onSetTheme(project.theme);
      if (project.activeScenario) setActiveScenario(project.activeScenario);

      if (project.powerStates && Array.isArray(project.powerStates)) {
        setPowerStates(project.powerStates);
        if (project.powerStates.length > 0) {
          setActiveStateId(project.powerStates[0].id);
          activeStateIdRef.current = project.powerStates[0].id;
        }
      }

      syncNodeIdCounter(resolvedNodes);

      _analysisFingerprint = '';
      _nodeFpCache = new WeakMap();
      _edgesFpCache = { ref: null, fp: '' };
      _statesFpCache = { ref: null, fp: '' };
    } catch {
      alert('Invalid project file.');
    }
  }, [setNodes, setEdges, theme, onSetTheme, setPowerStates]);

  const didAutoLoad = useRef(false);
  useEffect(() => {
    if (didAutoLoad.current) return;
    didAutoLoad.current = true;
    try {
      const saved = localStorage.getItem('power-tree-autosave');
      if (saved) loadProjectFromJson(saved);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doLoadProject = useCallback(async () => {
    if ('showOpenFilePicker' in window) {
      try {
        const [handle] = await (window as unknown as { showOpenFilePicker: (opts: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker({
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
          multiple: false,
        });
        fileHandleRef.current = handle;
        const file = await handle.getFile();
        const text = await file.text();
        loadProjectFromJson(text);
      } catch { /* user cancelled */ }
    } else {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => loadProjectFromJson(reader.result as string);
        reader.readAsText(file);
      };
      input.click();
    }
  }, [loadProjectFromJson]);

  const loadProject = useCallback(() => {
    if (nodes.length > 0) {
      pendingLoadRef.current = doLoadProject;
      setShowSaveConfirm('load');
    } else {
      doLoadProject();
    }
  }, [nodes.length, doLoadProject]);

  const [showStateManager, setShowStateManager] = useState(false);
  const [newStateName, setNewStateName] = useState('');

  const addPowerState = useCallback(() => {
    if (!newStateName.trim()) return;
    const id = newStateName.trim().toLowerCase().replace(/\s+/g, '_') + '_' + Date.now();
    const currentSnap = snapshotCurrentLoads();
    const enabledSnap: Record<string, boolean> = {};
    for (const n of nodes as unknown as Node[]) {
      const d = n.data as unknown as PowerNodeData;
      if (d.type === 'converter' || d.type === 'series' || d.type === 'load') {
        enabledSnap[n.id] = (d as { enabled?: boolean }).enabled !== false;
      }
    }
    setPowerStates(prev => [...prev, { id, name: newStateName.trim(), fractionOfTime: 0, loadSnapshots: { ...currentSnap }, enabledOverrides: enabledSnap }]);
    setNewStateName('');
  }, [newStateName, nodes, snapshotCurrentLoads]);

  const copyPowerState = useCallback((stateId: string) => {
    const source = powerStates.find(s => s.id === stateId);
    if (!source) return;
    let currentSnaps = source.loadSnapshots;
    let enabledOv = source.enabledOverrides ? { ...source.enabledOverrides } : {};
    if (stateId === activeStateIdRef.current) {
      currentSnaps = { ...currentSnaps, ...snapshotCurrentLoads() };
      for (const n of nodes as unknown as Node[]) {
        const d = n.data as unknown as PowerNodeData;
        if (d.type === 'converter' || d.type === 'series' || d.type === 'load') {
          enabledOv[n.id] = (d as { enabled?: boolean }).enabled !== false;
        }
      }
    }
    const newId = source.name.toLowerCase().replace(/\s+/g, '_') + '_copy_' + Date.now();
    setPowerStates(prev => [...prev, {
      id: newId,
      name: `${source.name} (copy)`,
      fractionOfTime: source.fractionOfTime,
      loadSnapshots: JSON.parse(JSON.stringify(currentSnaps)),
      auxLoadOverrides: source.auxLoadOverrides ? JSON.parse(JSON.stringify(source.auxLoadOverrides)) : undefined,
      enabledOverrides: Object.keys(enabledOv).length > 0 ? { ...enabledOv } : undefined,
    }]);
  }, [powerStates, nodes, snapshotCurrentLoads]);

  const removePowerState = useCallback((stateId: string) => {
    setPowerStates(prev => {
      const next = prev.filter(s => s.id !== stateId);
      if (next.length === 0) return prev;
      if (activeStateIdRef.current === stateId) {
        const targetState = next[0];
        const newActiveId = targetState.id;
        activeStateIdRef.current = newActiveId;
        setActiveStateId(newActiveId);
        setNodes(nds => nds.map(n => {
          const d = n.data as Record<string, unknown>;
          const nodeType = (d as unknown as PowerNodeData).type;
          let newData = { ...d };
          if (targetState.enabledOverrides && n.id in targetState.enabledOverrides &&
              (nodeType === 'converter' || nodeType === 'series' || nodeType === 'load')) {
            newData = { ...newData, enabled: targetState.enabledOverrides[n.id] };
          }
          if (nodeType !== 'load') return { ...n, data: newData };
          const snap = targetState.loadSnapshots[n.id];
          if (snap) {
            const enabled = targetState.enabledOverrides?.[n.id] ?? (snap.enabled !== false);
            return { ...n, data: { ...snap, label: d.label, enabled, _analysis: d._analysis, _activeStateId: newActiveId } };
          }
          return { ...n, data: newData };
        }));
      }
      return next;
    });
  }, [setNodes]);

  const updateStateFraction = useCallback((stateId: string, fraction: number) => {
    const clamped = Math.max(0, Math.min(1, fraction));
    setPowerStates(prev => prev.map(s => s.id === stateId ? { ...s, fractionOfTime: clamped } : s));
  }, []);

  const renameState = useCallback((stateId: string, name: string) => {
    setPowerStates(prev => prev.map(s => s.id === stateId ? { ...s, name } : s));
  }, []);

  return (
    <>
      <div className="main-area">
        <div className="toolbar">
          <div className="toolbar-left">
            <Tooltip text="Project name — click to rename">
              <input
                className="project-name-input"
                value={projectName}
                onChange={e => setProjectName(e.target.value)}
                spellCheck={false}
              />
            </Tooltip>
          </div>
          <div className="toolbar-actions">
            <Tooltip text="Create a new empty project (unsaved changes will prompt to save)">
              <button className="toolbar-btn secondary" onClick={newProject}>New</button>
            </Tooltip>
            <Tooltip text="Open a saved project file (.json)">
              <button className="toolbar-btn secondary" onClick={loadProject}>Load</button>
            </Tooltip>
            <Tooltip text="Save to the current file (Cmd+S)">
              <button className="toolbar-btn secondary" onClick={saveProject} disabled={nodes.length === 0}>Save</button>
            </Tooltip>
            <Tooltip text="Save as a new file">
              <button className="toolbar-btn secondary" onClick={saveAsProject} disabled={nodes.length === 0}>Save As</button>
            </Tooltip>
            <Tooltip text="Open the analysis results panel with power, loss, and efficiency breakdowns">
              <button className="analyze-btn" onClick={openResults} disabled={nodes.length === 0}>Details</button>
            </Tooltip>
          </div>
        </div>
        {saveToast && <div className="save-toast">Saved</div>}
        <div className="state-tabs-bar">
          {powerStates.map(s => (
            <Tooltip key={s.id} text={`Switch to ${s.name} (${(s.fractionOfTime * 100).toFixed(0)}% duty cycle). Each state can have different load values and enabled/disabled components.`}>
              <button
                className={`state-tab ${activeStateId === s.id ? 'active' : ''}`}
                onClick={() => switchState(s.id)}
              >
                {s.name}
                <span className="state-tab-pct">{(s.fractionOfTime * 100).toFixed(0)}%</span>
              </button>
            </Tooltip>
          ))}
          <Tooltip text="Add, remove, or rename power states and adjust their duty cycle percentages">
            <button className="state-tab state-tab-manage" onClick={() => setShowStateManager(true)}>Manage States</button>
          </Tooltip>
          {(() => {
            let hasMin = false, hasMax = false;
            for (const n of nodes) {
              const nd = n.data as unknown as PowerNodeData;
              if (nd.type === 'source') {
                const sd = nd as PowerSourceData;
                if (sd.minVoltage != null && sd.minVoltage > 0) hasMin = true;
                if (sd.maxVoltage != null && sd.maxVoltage > 0) hasMax = true;
              }
            }
            if (!hasMin && !hasMax) return null;
            return (
              <Tooltip text="Switch between min, nominal, and max input voltage scenarios defined on your power sources">
                <div className="scenario-toggle">
                  <span className="scenario-label">Vin:</span>
                  {hasMin && <button className={`scenario-btn ${activeScenario === 'min' ? 'active' : ''}`} onClick={() => setActiveScenario(activeScenario === 'min' ? 'nom' : 'min')}>Min</button>}
                  <button className={`scenario-btn ${activeScenario === 'nom' ? 'active' : ''}`} onClick={() => setActiveScenario('nom')}>Nom</button>
                  {hasMax && <button className={`scenario-btn ${activeScenario === 'max' ? 'active' : ''}`} onClick={() => setActiveScenario(activeScenario === 'max' ? 'nom' : 'max')}>Max</button>}
                </div>
              </Tooltip>
            );
          })()}
          <div className="auto-calc-spacer" />
          <div className="auto-calc-group">
            <Tooltip text="When on, analysis runs automatically after every change. Turn off to batch edits and recalculate manually when ready.">
              <label className="auto-calc-label">
                <span className="auto-calc-text">Auto-calculate</span>
                <button
                  className={`toggle-switch ${autoCalc ? 'on' : 'off'}`}
                  onClick={toggleAutoCalc}
                  role="switch"
                  aria-checked={autoCalc}
                >
                  <span className="toggle-knob" />
                </button>
              </label>
            </Tooltip>
            {!autoCalc && (
              <Tooltip text="Run analysis now with the current parameters (Cmd+Shift+R)">
                <button className="recalc-btn" onClick={runManualAnalysis} disabled={!analysisStale}>
                  Recalculate
                </button>
              </Tooltip>
            )}
          </div>
        </div>
        <div className="flow-container" ref={reactFlowWrapper} onMouseDown={onFlowMouseDown}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={onNodeClick}
            onNodeContextMenu={onNodeContextMenu}
            onPaneClick={onPaneClick}
            onNodesDelete={onNodesDelete}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={{ type: 'smart' }}
            defaultViewport={{ x: 100, y: 100, zoom: 1 }}
            minZoom={0.05}
            maxZoom={4}
            deleteKeyCode={['Backspace', 'Delete']}
            connectionRadius={30}
            connectOnClick={false}
            panOnDrag
            selectionMode={SelectionMode.Partial}
            selectionKeyCode="Shift"
            proOptions={{ hideAttribution: true }}
          >
            <Controls />
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={theme === 'light' ? '#D5CEBC' : '#1A1D24'} />
          </ReactFlow>
          {heatmap && heatmapMaxLoss > 0 && <HeatmapScale maxLoss={heatmapMaxLoss} />}
          {isCalculating && <div className="calc-toast"><span className="calc-toast-spinner" />Calculating…</div>}
          {!isCalculating && analysisStale && !autoCalc && (
            <div className="calc-toast stale-toast" onClick={runManualAnalysis} style={{ cursor: 'pointer' }}>
              Changes pending — click to recalculate
            </div>
          )}
          {contextMenu && (
            <div className="ctx-menu-overlay" onClick={() => setContextMenu(null)} onContextMenu={e => { e.preventDefault(); setContextMenu(null); }}>
              <div className="ctx-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={e => e.stopPropagation()}>
                <button className="ctx-menu-item" onClick={() => addNoteForNode(contextMenu.nodeId)}>
                  Add note for "{contextMenu.nodeLabel}"
                </button>
              </div>
            </div>
          )}
        </div>
        <DiagnosticsConsole
          diagnostics={diagnostics}
          onNodeClick={(nodeId) => {
            const node = nodes.find(n => n.id === nodeId);
            if (node) {
              setSelectedNode(node);
              fitView({ nodes: [{ id: nodeId }], duration: 400, padding: 0.3 });
            }
          }}
        />
        {showSearch && (
          <NodeSearch
            nodes={nodes}
            onHover={(nodeId) => {
              fitView({ nodes: [{ id: nodeId }], duration: 300, padding: 0.3 });
            }}
            onSelect={(nodeId) => {
              const node = nodes.find(n => n.id === nodeId);
              if (node) {
                setSelectedNode(node);
                fitView({ nodes: [{ id: nodeId }], duration: 400, padding: 0.3 });
              }
            }}
            onClose={() => setShowSearch(false)}
          />
        )}
      </div>

      {selectedNode && selectedNode.type === 'textNode' && (() => {
        const td = selectedNode.data as Record<string, unknown>;
        const currentColor = (td.color as string) || 'var(--text)';
        const currentSize = (td.fontSize as number) || 14;
        return (
          <div className="config-panel">
            <div className="config-header">
              <h3>Configure text</h3>
              <button className="close-btn" onClick={() => setSelectedNode(null)}>X</button>
            </div>
            <div className="config-body">
              <div className="config-fields">
                <label>
                  Font Size (px)
                  <input
                    type="number"
                    min="8"
                    max="72"
                    value={currentSize}
                    onChange={e => {
                      const v = parseInt(e.target.value, 10);
                      if (!isNaN(v) && v > 0) onTextNodeChange(selectedNode.id, { fontSize: v });
                    }}
                  />
                </label>
                <label>
                  Color
                  <div className="text-color-swatches">
                    {[
                      'var(--text)',
                      'var(--text-dim)',
                      '#8B5C5C',
                      '#7B8A5C',
                      '#5C7B8A',
                      '#6B5C8A',
                      '#8A7A5C',
                      '#5C8A7B',
                    ].map(c => (
                      <button key={c}
                        className={`text-color-swatch ${currentColor === c ? 'active' : ''}`}
                        style={{ background: c }}
                        onClick={() => onTextNodeChange(selectedNode.id, { color: c })}
                      />
                    ))}
                  </div>
                </label>
              </div>
            </div>
            <div className="config-footer">
              <button className="delete-btn" onClick={() => { deleteNode(selectedNode.id); setSelectedNode(null); }}>
                Delete
              </button>
            </div>
          </div>
        );
      })()}

      {selectedNode && selectedNode.type !== 'textNode' && (
        <ConfigPanel
          node={selectedNode}
          onUpdate={updateNodeData}
          onClose={closeConfigPanel}
          onDelete={deleteNode}
          auxOverrides={powerStates.find(s => s.id === activeStateId)?.auxLoadOverrides?.[selectedNode.id]}
          onAuxOverrideToggle={onAuxOverrideToggle}
        />
      )}

      {resultsMounted && (
        <div style={showResults && !selectedNode ? { display: 'flex', height: '100%' } : { display: 'none' }}>
          <ResultsPanel
            results={results}
            scenarioTimeSeries={scenarioTimeSeries}
            batteryDischargeSeries={batteryDischargeSeries}
            onClose={closeResults}
            powerStates={powerStates}
            activeStateId={activeStateId}
            theme={theme}
          />
        </div>
      )}

      {showSaveConfirm && (
        <div className="panel-overlay" onClick={() => handleSaveConfirm('cancel')}>
          <div className="state-manager-panel" style={{ maxWidth: 380, padding: 24 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>{showSaveConfirm === 'new' ? 'New Project' : 'Load Project'}</h2>
            <p style={{ margin: '0 0 24px', color: 'var(--text-dim)', fontSize: 14, lineHeight: 1.5 }}>
              Do you want to save the current project first?
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="toolbar-btn secondary" onClick={() => handleSaveConfirm('cancel')}>Cancel</button>
              <button className="toolbar-btn secondary" onClick={() => handleSaveConfirm('discard')}>Don't Save</button>
              <button className="analyze-btn" onClick={() => handleSaveConfirm('save')}>Save</button>
            </div>
          </div>
        </div>
      )}
      {showStateManager && (
        <div className="panel-overlay" onClick={() => setShowStateManager(false)}>
          <div className="state-manager-panel" onClick={e => e.stopPropagation()}>
            <div className="panel-header">
              <h2>Power States</h2>
              <button className="close-btn" onClick={() => setShowStateManager(false)}>X</button>
            </div>
            <div className="state-manager-body">
              <p className="state-hint">Define the operating states of your device and how much time is spent in each.</p>
              {powerStates.map(s => (
                <div key={s.id} className="state-row">
                  <input
                    type="text"
                    value={s.name}
                    onChange={e => renameState(s.id, e.target.value)}
                    className="state-name-input"
                  />
                  <FractionInput
                    value={s.fractionOfTime}
                    onChange={v => updateStateFraction(s.id, v)}
                  />
                  <Tooltip text="Duplicate this state with the same settings">
                    <button
                      className="state-copy-btn"
                      onClick={() => copyPowerState(s.id)}
                    >Copy</button>
                  </Tooltip>
                  <Tooltip text="Remove this state">
                    <button
                      className="state-remove-btn"
                      onClick={() => removePowerState(s.id)}
                      disabled={powerStates.length <= 1}
                    >X</button>
                  </Tooltip>
                </div>
              ))}
              <div className="state-add-row">
                <input
                  type="text"
                  placeholder="New state name"
                  value={newStateName}
                  onChange={e => setNewStateName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addPowerState()}
                />
                <button onClick={addPowerState} disabled={!newStateName.trim()}>Add</button>
              </div>
              {(() => {
                const total = powerStates.reduce((s, st) => s + st.fractionOfTime, 0);
                if (Math.abs(total - 1) > 0.01) {
                  return <p className="state-warning">Time fractions sum to {(total * 100).toFixed(0)}% (should be 100%)</p>;
                }
                return null;
              })()}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function getInitialTheme(): 'dark' | 'light' {
  try {
    const saved = localStorage.getItem('power-tree-autosave');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.theme === 'dark' || parsed.theme === 'light') return parsed.theme;
    }
  } catch { /* */ }
  return 'light';
}

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(getInitialTheme);
  const [heatmap, setHeatmap] = useState(false);
  const [projectNotes, setProjectNotes] = useState<NoteBullet[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const nodeListRef = useRef<{ id: string; label: string }[]>([]);
  const navigateToNodeRef = useRef<(nodeId: string) => void>(() => {});

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div className="app-container">
      <Sidebar
        theme={theme}
        onToggleTheme={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
        heatmap={heatmap}
        onToggleHeatmap={() => setHeatmap(h => !h)}
      />
      <NotesDrawer
        open={notesOpen}
        onToggle={() => setNotesOpen(o => !o)}
        notes={projectNotes}
        onNotesChange={setProjectNotes}
        nodeList={nodeListRef}
        onNodeNavigate={navigateToNodeRef}
      />
      <ReactFlowProvider>
        <FlowCanvas theme={theme} onSetTheme={setTheme} heatmap={heatmap} projectNotes={projectNotes} onSetProjectNotes={setProjectNotes} onSetNotesOpen={setNotesOpen} nodeListRef={nodeListRef} navigateToNodeRef={navigateToNodeRef} />
      </ReactFlowProvider>
    </div>
  );
}
