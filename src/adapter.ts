import { state, createInitialState, type EmulatorState, type SynthesisPlan } from './state.js';
import { logEvent } from './log.js';

export interface DeviceAdapter {
  getState(): EmulatorState;
  setPumpFlows(flowA: number, flowB: number): void;
  setTemperatureZones(z: { preheaterA?: number; preheaterB?: number; reactor?: number }): void;
  startSampling(intervalSec: number): void;
  stopSampling(): void;
  startNmrInitialCalibration(): void;
  prepareSynthesis(plan: SynthesisPlan): void;
  startSynthesis(plan: SynthesisPlan): void;
  stopSynthesis(): void;
  emergencyStop(): void;
  reset(): void;
}

export class EmulatorAdapter implements DeviceAdapter {
  getState(): EmulatorState {
    return state;
  }

  setPumpFlows(flowA: number, flowB: number): void {
    state.pumps.A.flowSet = flowA;
    state.pumps.B.flowSet = flowB;
    logEvent('command', 'emulator', `Дозатор A установлен на ${flowA} мл/мин`, { params: { flow_ml_min: flowA }, status: 'ok' });
    logEvent('command', 'emulator', `Дозатор B установлен на ${flowB} мл/мин`, { params: { flow_ml_min: flowB }, status: 'ok' });
  }

  setTemperatureZones(z: { preheaterA?: number; preheaterB?: number; reactor?: number }): void {
    if (z.preheaterA !== undefined) {
      state.thermal.preheaterA.target = z.preheaterA;
      logEvent('command', 'emulator', `Преднагреватель A: уставка ${z.preheaterA} °C`, { status: 'ok' });
    }
    if (z.preheaterB !== undefined) {
      state.thermal.preheaterB.target = z.preheaterB;
      logEvent('command', 'emulator', `Преднагреватель B: уставка ${z.preheaterB} °C`, { status: 'ok' });
    }
    if (z.reactor !== undefined) {
      state.thermal.reactor.target = z.reactor;
      logEvent('command', 'emulator', `Термостат реактора: уставка ${z.reactor} °C`, { status: 'ok' });
    }
  }

  startSampling(intervalSec: number): void {
    state.sampling.enabled = true;
    state.sampling.intervalSec = intervalSec;
    state.sampling.nextSampleInMs = null;
    logEvent('command', 'emulator', `Отбор проб включён, интервал ${intervalSec} с`, { params: { interval_sec: intervalSec }, status: 'ok' });
  }

  stopSampling(): void {
    state.sampling.enabled = false;
    state.sampling.nextSampleInMs = null;
    logEvent('command', 'emulator', 'Отбор проб выключен', { status: 'ok' });
  }

  startNmrInitialCalibration(): void {
    state.nmr.status = 'STARTUP_CALIBRATION';
    state.nmr.statusRemainingMs = 8000;
    state.nmr.calibrated = false;
    logEvent('info', 'nmr', 'Стартовая калибровка ЯМР начата', { status: 'running' });
  }

  prepareSynthesis(plan: SynthesisPlan): void {
    state.plan = plan;
    state.state = 'READY';
    logEvent('check', 'adapter', `План синтеза подготовлен (id=${plan.id})`, { params: { ...plan }, status: 'ok' });
  }

  startSynthesis(plan: SynthesisPlan): void {
    this.setTemperatureZones({ preheaterA: plan.preheatA, preheaterB: plan.preheatB, reactor: plan.reactorTemp });
    this.setPumpFlows(plan.flowA, plan.flowB);
    this.startSampling(plan.samplingIntervalSec);
    state.plan = plan;
    state.state = 'RUNNING';
    state.startedAt = Date.now();
    state.finishedAt = null;
    state.experiment = {
      id: plan.id,
      startedAt: Date.now(),
      finishedAt: null,
      setFlowA: plan.flowA,
      setFlowB: plan.flowB,
      setPreheatA: plan.preheatA,
      setPreheatB: plan.preheatB,
      setReactorTemp: plan.reactorTemp,
      samplingIntervalSec: plan.samplingIntervalSec,
      pressureMin: Infinity,
      pressureMax: 0,
      sampleCount: 0,
      concentrations: [],
      warnings: [],
      errors: [],
      finalStatus: 'RUNNING',
    };
    if (!state.nmr.calibrated && state.nmr.status === 'IDLE') this.startNmrInitialCalibration();
    logEvent('info', 'emulator', 'Эксперимент запущен (RUNNING)', { status: 'ok' });
  }

  stopSynthesis(): void {
    state.pumps.A.flowSet = 0;
    state.pumps.B.flowSet = 0;
    state.pumps.sample.flowSet = 0;
    state.sampling.enabled = false;
    state.sampling.nextSampleInMs = null;
    state.finishedAt = Date.now();
    if (state.experiment && state.experiment.finishedAt === null) {
      state.experiment.finishedAt = Date.now();
      state.experiment.finalStatus = 'FINISHED';
    }
    state.state = 'FINISHED';
    logEvent('info', 'emulator', 'Эксперимент остановлен (FINISHED), потоки = 0', { status: 'ok' });
  }

  emergencyStop(): void {
    state.pumps.A.flowSet = 0;
    state.pumps.B.flowSet = 0;
    state.pumps.sample.flowSet = 0;
    state.sampling.enabled = false;
    state.state = 'EMERGENCY_STOP';
    if (state.experiment && state.experiment.finishedAt === null) {
      state.experiment.finishedAt = Date.now();
      state.experiment.finalStatus = 'EMERGENCY_STOP';
    }
    logEvent('warning', 'emulator', 'АВАРИЙНАЯ ОСТАНОВКА: все потоки остановлены', { status: 'error' });
  }

  reset(): void {
    Object.assign(state, createInitialState());
    logEvent('info', 'system', 'Демо сброшено в исходное состояние', { status: 'ok' });
  }
}

export const adapter: DeviceAdapter = new EmulatorAdapter();
