export type ExperimentState =
  | 'IDLE' | 'READY' | 'PREPARING' | 'RUNNING'
  | 'FINISHED' | 'ERROR' | 'EMERGENCY_STOP';

export type PumpStatus = 'IDLE' | 'RUNNING';

export type NmrStatus = 'IDLE' | 'STARTUP_CALIBRATION' | 'SAMPLE_CALIBRATION' | 'ANALYSIS' | 'READY';

export interface ExperimentRecord {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  setFlowA: number;
  setFlowB: number;
  setPreheatA: number;
  setPreheatB: number;
  setReactorTemp: number;
  samplingIntervalSec: number;
  pressureMin: number;
  pressureMax: number;
  sampleCount: number;
  concentrations: number[];
  warnings: string[];
  errors: string[];
  finalStatus: string;
}

export interface SynthesisPlan {
  id: string;
  flowA: number;
  flowB: number;
  preheatA: number;
  preheatB: number;
  reactorTemp: number;
  samplingIntervalSec: number;
}

export interface EmulatorState {
  state: ExperimentState;
  startedAt: number | null;
  finishedAt: number | null;

  reagents: {
    A: { level: number; capacity: number };
    B: { level: number; capacity: number };
  };

  pumps: {
    A: { flowSet: number; flow: number; pressure: number; status: PumpStatus };
    B: { flowSet: number; flow: number; pressure: number; status: PumpStatus };
    sample: { flowSet: number; flow: number; status: PumpStatus };
  };

  thermal: {
    preheaterA: { target: number; current: number };
    preheaterB: { target: number; current: number };
    reactor: { target: number; current: number };
  };

  mixer: { totalFlow: number };
  coil: { residenceTimeSec: number; fillPct: number };
  collection: { volume: number };

  sampling: {
    enabled: boolean;
    intervalSec: number;
    lastSampleAt: number | null;
    nextSampleInMs: number | null;
  };

  nmr: {
    status: NmrStatus;
    statusRemainingMs: number;
    calibrated: boolean;
    concentration: number;
    lastMeasurementAt: number | null;
    history: { t: number; value: number }[];
  };

  plan: SynthesisPlan | null;
  experiment: ExperimentRecord | null;
}

export const limits = {
  flow: { min: 0, max: 5 },
  preheat: { min: 20, max: 80 },
  reactorTemp: { min: 20, max: 100 },
  pressureMax: 10,
  samplingMinSec: 5,
};

export function createInitialState(): EmulatorState {
  return {
    state: 'IDLE',
    startedAt: null,
    finishedAt: null,
    reagents: { A: { level: 250, capacity: 250 }, B: { level: 250, capacity: 250 } },
    pumps: {
      A: { flowSet: 0, flow: 0, pressure: 0, status: 'IDLE' },
      B: { flowSet: 0, flow: 0, pressure: 0, status: 'IDLE' },
      sample: { flowSet: 0, flow: 0, status: 'IDLE' },
    },
    thermal: {
      preheaterA: { target: 25, current: 22 },
      preheaterB: { target: 25, current: 22 },
      reactor: { target: 25, current: 22 },
    },
    mixer: { totalFlow: 0 },
    coil: { residenceTimeSec: 0, fillPct: 0 },
    collection: { volume: 0 },
    sampling: { enabled: false, intervalSec: 5, lastSampleAt: null, nextSampleInMs: null },
    nmr: { status: 'IDLE', statusRemainingMs: 0, calibrated: false, concentration: 0, lastMeasurementAt: null, history: [] },
    plan: null,
    experiment: null,
  };
}

export function displayPhase(s: EmulatorState): string {
  if (s.state === 'RUNNING') {
    if (s.nmr.status === 'STARTUP_CALIBRATION') return 'NMR_CALIBRATION';
    if (s.nmr.status === 'SAMPLE_CALIBRATION') return 'NMR_SAMPLE_CALIBRATION';
    if (s.nmr.status === 'ANALYSIS') return 'ANALYSIS';
    if (s.pumps.sample.flow > 0) return 'SAMPLING';
  }
  return s.state;
}

export const state: EmulatorState = createInitialState();
