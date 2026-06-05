import { state, limits, type EmulatorState } from './state.js';
import { logEvent } from './log.js';

const STARTUP_CAL_MS = 8000;
const SAMPLE_CAL_MS = 4000;
const ANALYSIS_MS = 3000;

function approach(value: number, target: number, rate: number, noise = 0): number {
  const next = value + (target - value) * rate;
  return next + (noise ? (Math.random() - 0.5) * noise : 0);
}

function pressureForFlow(flow: number): number {
  if (flow <= 0) return 0;
  return 0.9 + 0.3 * flow;
}

function targetConcentration(residenceSec: number, reactorTemp: number): number {
  if (residenceSec <= 0) return 0;
  const kT = 1 / (1 + Math.exp(-(reactorTemp - 45) / 12));
  const kR = 1 - Math.exp(-residenceSec / 25);
  return Math.max(0, Math.min(1, 0.15 + 0.8 * kT * kR));
}

function beginSampleCalibration(s: EmulatorState) {
  s.nmr.status = 'SAMPLE_CALIBRATION';
  s.nmr.statusRemainingMs = SAMPLE_CAL_MS;
  s.pumps.sample.flowSet = Math.max(s.pumps.sample.flowSet, 3);
  logEvent('info', 'nmr', 'Отбор пробы: запущена калибровка ЯМР перед анализом', { status: 'running' });
}

export function tick(dtMs: number): void {
  const s = state;
  const now = Date.now();
  const dtMin = dtMs / 60000;
  const active = s.state === 'RUNNING';

  for (const key of ['A', 'B'] as const) {
    const p = s.pumps[key];
    const wantFlow = active ? p.flowSet : 0;
    p.flow = approach(p.flow, wantFlow, 0.25);
    if (p.flow < 0.02) p.flow = 0;
    p.pressure = approach(p.pressure, pressureForFlow(p.flow), 0.2, p.flow > 0 ? 0.02 : 0);
    if (p.pressure < 0.01) p.pressure = 0;
    p.status = p.flow > 0 ? 'RUNNING' : 'IDLE';
  }
  const sp = s.pumps.sample;
  sp.flow = approach(sp.flow, active ? sp.flowSet : 0, 0.35);
  if (sp.flow < 0.02) sp.flow = 0;
  sp.status = sp.flow > 0 ? 'RUNNING' : 'IDLE';

  if (active) {
    s.reagents.A.level = Math.max(0, s.reagents.A.level - s.pumps.A.flow * dtMin);
    s.reagents.B.level = Math.max(0, s.reagents.B.level - s.pumps.B.flow * dtMin);
    const toJar = Math.max(0, s.pumps.A.flow + s.pumps.B.flow - s.pumps.sample.flow);
    s.collection.volume += toJar * dtMin;
  }

  s.thermal.preheaterA.current = approach(s.thermal.preheaterA.current, s.thermal.preheaterA.target, 0.08, 0.04);
  s.thermal.preheaterB.current = approach(s.thermal.preheaterB.current, s.thermal.preheaterB.target, 0.08, 0.04);
  s.thermal.reactor.current = approach(s.thermal.reactor.current, s.thermal.reactor.target, 0.06, 0.04);

  s.mixer.totalFlow = s.pumps.A.flow + s.pumps.B.flow;
  const COIL_VOLUME_ML = 10;
  s.coil.residenceTimeSec = s.mixer.totalFlow > 0 ? (COIL_VOLUME_ML / s.mixer.totalFlow) * 60 : 0;
  s.coil.fillPct = approach(s.coil.fillPct, s.mixer.totalFlow > 0 ? 100 : 0, 0.05);

  const maxP = Math.max(s.pumps.A.pressure, s.pumps.B.pressure);
  if (maxP > limits.pressureMax && s.state !== 'EMERGENCY_STOP') {
    s.state = 'EMERGENCY_STOP';
    s.pumps.A.flowSet = 0;
    s.pumps.B.flowSet = 0;
    s.pumps.sample.flowSet = 0;
    if (s.experiment) s.experiment.errors.push(`Превышение давления: ${maxP.toFixed(1)} бар`);
    logEvent('error', 'system', `Аварийная остановка: давление ${maxP.toFixed(1)} бар > ${limits.pressureMax} бар`, { status: 'error' });
  }

  const nmr = s.nmr;
  if (nmr.statusRemainingMs > 0) {
    nmr.statusRemainingMs -= dtMs;
    if (nmr.statusRemainingMs <= 0) {
      nmr.statusRemainingMs = 0;
      if (nmr.status === 'STARTUP_CALIBRATION') {
        nmr.calibrated = true;
        nmr.status = 'READY';
        logEvent('info', 'nmr', 'Стартовая калибровка ЯМР завершена', { status: 'ok' });
      } else if (nmr.status === 'SAMPLE_CALIBRATION') {
        nmr.status = 'ANALYSIS';
        nmr.statusRemainingMs = ANALYSIS_MS;
      } else if (nmr.status === 'ANALYSIS') {
        const target = targetConcentration(s.coil.residenceTimeSec, s.thermal.reactor.current);
        const measured = Math.max(0, Math.min(1, target + (Math.random() - 0.5) * 0.04));
        nmr.concentration = measured;
        nmr.lastMeasurementAt = now;
        nmr.history.push({ t: now, value: measured });
        if (nmr.history.length > 200) nmr.history.shift();
        nmr.status = 'READY';
        s.pumps.sample.flowSet = 0;
        s.sampling.lastSampleAt = now;
        if (s.experiment) {
          s.experiment.sampleCount++;
          s.experiment.concentrations.push(measured);
        }
        logEvent('telemetry', 'nmr', `Анализ ЯМР: концентрация целевого вещества ${(measured * 100).toFixed(1)}%`, { params: { concentration_rel: Number(measured.toFixed(3)) }, status: 'ok' });
      }
    }
  }

  if (active && s.sampling.enabled && nmr.calibrated && (nmr.status === 'READY' || nmr.status === 'IDLE')) {
    if (s.sampling.nextSampleInMs === null) {
      s.sampling.nextSampleInMs = s.sampling.intervalSec * 1000;
    } else {
      s.sampling.nextSampleInMs -= dtMs;
      if (s.sampling.nextSampleInMs <= 0) {
        beginSampleCalibration(s);
        s.sampling.nextSampleInMs = s.sampling.intervalSec * 1000;
      }
    }
  }

  if (active && s.experiment) {
    s.experiment.pressureMin = Math.min(s.experiment.pressureMin, s.pumps.A.pressure, s.pumps.B.pressure);
    s.experiment.pressureMax = Math.max(s.experiment.pressureMax, s.pumps.A.pressure, s.pumps.B.pressure);
  }
}

export function startSimulation(tickMs: number, onTick?: (s: EmulatorState) => void): () => void {
  const handle = setInterval(() => {
    tick(tickMs);
    onTick?.(state);
  }, tickMs);
  return () => clearInterval(handle);
}
