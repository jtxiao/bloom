export type NodeType = 'source' | 'converter' | 'load' | 'series';

export interface NoteBullet {
  id: string;
  text: string;
  nodeId?: string;
  nodeIds?: string[];
}
export type ConverterType = 'switching' | 'ldo';
export type LoadMode = 'current_profile' | 'resistor' | 'fixed_current';
export type SeriesMode = 'resistor' | 'diode';
export type SourceMode = 'fixed' | 'battery';
export type BatteryMode = 'simple' | 'detailed';
export type VoltageScenario = 'min' | 'nom' | 'max';

export interface PowerState {
  id: string;
  name: string;
  fractionOfTime: number;
  loadSnapshots: Record<string, LoadData>;
  auxLoadOverrides?: Record<string, Record<string, boolean>>;
  enabledOverrides?: Record<string, boolean>;
}

export interface EfficiencyPoint {
  loadCurrent: number;
  efficiency: number;
}

export interface EfficiencyCurveSet {
  inputVoltage: number;
  points: EfficiencyPoint[];
}

export interface LoadProfilePoint {
  time: number;
  current: number;
}

export interface DischargeCurvePoint {
  capacityMah: number;
  voltage: number;
}

export interface DischargeCurveAtTemp {
  tempC: number;
  points: DischargeCurvePoint[];
}

export interface CapacityAtTemp {
  tempC: number;
  capacityMah: number;
}

export interface TempTimeSlice {
  tempC: number;
  fractionOfTime: number;
}

export interface XYPoint {
  x: number;
  y: number;
}

export interface AuxLoad {
  id: string;
  label: string;
  mode: 'resistor' | 'fixed_current';
  resistance: number;
  fixedCurrent: number;
}

export interface PowerSourceData {
  type: 'source';
  label: string;
  sourceMode: SourceMode;
  batteryMode: BatteryMode;
  nominalVoltage: number;
  minVoltage?: number;
  maxVoltage?: number;
  internalResistance: number;
  capacityAtTemps: CapacityAtTemp[];
  dischargeCurves: DischargeCurveAtTemp[];
  temperatureProfile: TempTimeSlice[];
  cutoffVoltage: number;
  auxLoads?: AuxLoad[];
}

export type EfficiencyMode = 'flat' | 'curve';

export interface PowerConverterData {
  type: 'converter';
  label: string;
  converterType: ConverterType;
  outputVoltage: number;
  quiescentCurrent: number;
  efficiencyMode?: EfficiencyMode;
  flatEfficiency?: number;
  efficiencyCurves: EfficiencyCurveSet[];
  enabled: boolean;
  auxLoads?: AuxLoad[];
}

export interface LoadData {
  type: 'load';
  label: string;
  voltage: number;
  loadMode: LoadMode;
  loadProfile: LoadProfilePoint[];
  resistance: number;
  fixedCurrent: number;
  enabled: boolean;
}

export interface SeriesElementData {
  type: 'series';
  label: string;
  seriesMode: SeriesMode;
  resistance: number;
  forwardVoltage: number;
  enabled: boolean;
  auxLoads?: AuxLoad[];
}

export type PowerNodeData = PowerSourceData | PowerConverterData | LoadData | SeriesElementData;

export interface ScenarioResult {
  inputPowerAvg: number;
  outputPowerAvg: number;
  powerLossAvg: number;
  efficiencyAvg: number;
  batteryLifetimeHours?: number;
}

export interface StateResult {
  inputPower: number;
  outputPower: number;
  powerLoss: number;
  efficiency: number;
  voltageOut: number;
  currentOut: number;
  currentRms: number;
  peakCurrent: number;
  peakInputPower: number;
  auxPower: number;
}

export interface AnalysisResult {
  nodeId: string;
  label: string;
  type: NodeType;
  inputPowerAvg: number;
  outputPowerAvg: number;
  auxPowerAvg: number;
  powerLossAvg: number;
  efficiencyAvg: number;
  voltageOut: number;
  currentOut: number;
  currentRms: number;
  peakCurrent: number;
  peakInputPower: number;
  disabled: boolean;
  batteryLifetimeHours?: number;
  scenarios: Partial<Record<VoltageScenario, ScenarioResult>>;
  stateResults: Record<string, StateResult>;
  scenarioStateResults: Partial<Record<VoltageScenario, Record<string, StateResult>>>;
}

export interface TimeSeriesPoint {
  time: number;
  inputPower: number;
  inputCurrent: number;
  totalLoad: number;
}

export interface BatteryTimeSeriesPoint {
  timeHours: number;
  voltage: number;
  current: number;
  capacityUsedMah: number;
}

export interface ScenarioTimeSeries {
  scenario: VoltageScenario;
  points: TimeSeriesPoint[];
  statePoints?: Record<string, TimeSeriesPoint[]>;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  nodeId?: string;
  nodeLabel?: string;
  message: string;
  scenario?: VoltageScenario;
  stateId?: string;
}
