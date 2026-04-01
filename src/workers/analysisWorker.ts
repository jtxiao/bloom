import { analyzeTree } from '../engine/calculate';
import type { BatteryTimeSeriesPoint } from '../types';
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysisWorker.types';

self.onmessage = (e: MessageEvent<AnalysisWorkerRequest>) => {
  const msg = e.data;
  if (msg.type !== 'analyze') return;
  const { id, nodes, edges, powerStates } = msg;
  try {
    const out = analyzeTree(nodes, edges, powerStates);
    const batteryEntries = [...out.batteryDischargeSeries.entries()] as [string, BatteryTimeSeriesPoint[]][];
    const res: AnalysisWorkerResponse = {
      type: 'done',
      id,
      results: out.results,
      scenarioTimeSeries: out.scenarioTimeSeries,
      batteryEntries,
      diagnostics: out.diagnostics,
    };
    self.postMessage(res);
  } catch (err) {
    const res: AnalysisWorkerResponse = {
      type: 'error',
      id,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
    self.postMessage(res);
  }
};
