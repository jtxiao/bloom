import type { Node, Edge } from '@xyflow/react';
import type {
  AnalysisResult,
  ScenarioTimeSeries,
  BatteryTimeSeriesPoint,
  Diagnostic,
  PowerState,
} from '../types';

export type AnalysisWorkerRequest = {
  type: 'analyze';
  id: number;
  nodes: Node[];
  edges: Edge[];
  powerStates: PowerState[];
};

export type AnalysisWorkerResponse =
  | {
      type: 'done';
      id: number;
      results: AnalysisResult[];
      scenarioTimeSeries: ScenarioTimeSeries[];
      batteryEntries: [string, BatteryTimeSeriesPoint[]][];
      diagnostics: Diagnostic[];
    }
  | { type: 'error'; id: number; message: string; stack?: string };
