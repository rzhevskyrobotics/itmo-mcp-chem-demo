import { state, limits, displayPhase, type SynthesisPlan } from './state.js';
import { adapter } from './adapter.js';
import { logEvent, getLog, type LogSource } from './log.js';

export type ToolKind = 'read' | 'check' | 'prepare' | 'control' | 'report';

export interface ToolParam {
  name: string;
  type: 'number' | 'string' | 'boolean';
  required?: boolean;
  min?: number;
  max?: number;
  description: string;
}

export interface ToolResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

export interface Tool {
  name: string;
  kind: ToolKind;
  description: string;
  params: ToolParam[];
  handler: (p: Record<string, unknown>, source: LogSource) => ToolResult;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

let planCounterSeed = 0;
function newPlanId(): string {
  planCounterSeed += 1;
  return `PLAN-${Date.now().toString(36)}-${planCounterSeed}`;
}

function validatePlan(p: Record<string, unknown>): { ok: boolean; issues: string[]; plan?: SynthesisPlan } {
  const issues: string[] = [];
  const flowA = num(p.flowA);
  const flowB = num(p.flowB);
  const reactorTemp = num(p.reactorTemp ?? p.reactor_temp_c);
  const preheatA = p.preheatA !== undefined ? num(p.preheatA) : 40;
  const preheatB = p.preheatB !== undefined ? num(p.preheatB) : 40;
  const samplingIntervalSec = p.samplingIntervalSec !== undefined ? num(p.samplingIntervalSec) : 5;

  if (flowA === null) issues.push('flowA: требуется число');
  else if (flowA < limits.flow.min || flowA > limits.flow.max) issues.push(`flowA=${flowA} вне диапазона ${limits.flow.min}–${limits.flow.max} мл/мин`);
  if (flowB === null) issues.push('flowB: требуется число');
  else if (flowB < limits.flow.min || flowB > limits.flow.max) issues.push(`flowB=${flowB} вне диапазона ${limits.flow.min}–${limits.flow.max} мл/мин`);
  if (reactorTemp === null) issues.push('reactorTemp: требуется число');
  else if (reactorTemp < limits.reactorTemp.min || reactorTemp > limits.reactorTemp.max) issues.push(`reactorTemp=${reactorTemp} вне диапазона ${limits.reactorTemp.min}–${limits.reactorTemp.max} °C`);
  if (preheatA === null || preheatA < limits.preheat.min || preheatA > limits.preheat.max) issues.push(`preheatA вне диапазона ${limits.preheat.min}–${limits.preheat.max} °C`);
  if (preheatB === null || preheatB < limits.preheat.min || preheatB > limits.preheat.max) issues.push(`preheatB вне диапазона ${limits.preheat.min}–${limits.preheat.max} °C`);
  if (samplingIntervalSec === null || samplingIntervalSec < limits.samplingMinSec) issues.push(`интервал отбора < ${limits.samplingMinSec} с (слишком часто)`);

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    issues: [],
    plan: {
      id: newPlanId(),
      flowA: flowA!, flowB: flowB!,
      preheatA: preheatA!, preheatB: preheatB!,
      reactorTemp: reactorTemp!,
      samplingIntervalSec: samplingIntervalSec!,
    },
  };
}

function systemStatus() {
  const s = state;
  const ts = s.nmr.lastMeasurementAt ? new Date(s.nmr.lastMeasurementAt).toTimeString().slice(0, 8) : null;
  return {
    state: s.state,
    phase: displayPhase(s),
    pumps: {
      A: { flow_ml_min: round(s.pumps.A.flow), pressure_bar: round(s.pumps.A.pressure), status: s.pumps.A.status },
      B: { flow_ml_min: round(s.pumps.B.flow), pressure_bar: round(s.pumps.B.pressure), status: s.pumps.B.status },
    },
    temperature_zones: {
      preheater_A: { target_c: s.thermal.preheaterA.target, current_c: round(s.thermal.preheaterA.current) },
      preheater_B: { target_c: s.thermal.preheaterB.target, current_c: round(s.thermal.preheaterB.current) },
      reactor: { target_c: s.thermal.reactor.target, current_c: round(s.thermal.reactor.current) },
    },
    sampling: { enabled: s.sampling.enabled, interval_sec: s.sampling.intervalSec },
    nmr: { status: s.nmr.status, target_concentration_rel: round(s.nmr.concentration, 3), last_sample_time: ts },
  };
}

function telemetry() {
  const s = state;
  return {
    pumps: { A: { flow_ml_min: round(s.pumps.A.flow), pressure_bar: round(s.pumps.A.pressure) }, B: { flow_ml_min: round(s.pumps.B.flow), pressure_bar: round(s.pumps.B.pressure) } },
    temperatures_c: { preheater_A: round(s.thermal.preheaterA.current), preheater_B: round(s.thermal.preheaterB.current), reactor: round(s.thermal.reactor.current) },
    concentration_rel: round(s.nmr.concentration, 3),
    collection_ml: round(s.collection.volume),
    nmr_status: s.nmr.status,
  };
}

function round(n: number, d = 2): number {
  const k = 10 ** d;
  return Math.round(n * k) / k;
}

export const tools: Tool[] = [
  {
    name: 'get_system_status',
    kind: 'read',
    description: 'Получить общее состояние установки, режим эксперимента, статус ЯМР и текущие параметры.',
    params: [],
    handler: (_p, source) => {
      logEvent('telemetry', source, 'Запрошено состояние установки', { status: 'ok' });
      return { ok: true, message: 'OK', data: systemStatus() };
    },
  },
  {
    name: 'get_telemetry',
    kind: 'read',
    description: 'Получить текущие расходы, давление, температуры и условную концентрацию целевого вещества.',
    params: [],
    handler: (_p, source) => {
      logEvent('telemetry', source, 'Запрошена телеметрия', { status: 'ok' });
      return { ok: true, message: 'OK', data: telemetry() };
    },
  },
  {
    name: 'validate_synthesis_plan',
    kind: 'check',
    description: 'Проверить параметры синтеза на допустимые диапазоны и готовность установки.',
    params: [
      { name: 'flowA', type: 'number', required: true, min: limits.flow.min, max: limits.flow.max, description: 'Расход реагента A, мл/мин' },
      { name: 'flowB', type: 'number', required: true, min: limits.flow.min, max: limits.flow.max, description: 'Расход реагента B, мл/мин' },
      { name: 'reactorTemp', type: 'number', required: true, min: limits.reactorTemp.min, max: limits.reactorTemp.max, description: 'Температура реактора, °C' },
      { name: 'preheatA', type: 'number', min: limits.preheat.min, max: limits.preheat.max, description: 'Температура преднагревателя A, °C (опц., 40 по умолчанию)' },
      { name: 'preheatB', type: 'number', min: limits.preheat.min, max: limits.preheat.max, description: 'Температура преднагревателя B, °C (опц., 40 по умолчанию)' },
      { name: 'samplingIntervalSec', type: 'number', min: limits.samplingMinSec, description: 'Интервал отбора проб, с (опц., 5 по умолчанию)' },
    ],
    handler: (p, source) => {
      const r = validatePlan(p);
      if (!r.ok) {
        logEvent('warning', source, `Проверка плана: нарушения (${r.issues.length})`, { params: { issues: r.issues }, status: 'rejected' });
        return { ok: false, message: 'Параметры вне допустимых диапазонов', data: { issues: r.issues } };
      }
      logEvent('check', source, 'Проверка плана синтеза: нарушений нет', { status: 'ok' });
      return { ok: true, message: 'План корректен', data: { issues: [], plan: r.plan } };
    },
  },
  {
    name: 'prepare_synthesis',
    kind: 'prepare',
    description: 'Сохранить проверенный план синтеза и присвоить ему идентификатор.',
    params: [
      { name: 'flowA', type: 'number', required: true, min: limits.flow.min, max: limits.flow.max, description: 'Расход реагента A, мл/мин' },
      { name: 'flowB', type: 'number', required: true, min: limits.flow.min, max: limits.flow.max, description: 'Расход реагента B, мл/мин' },
      { name: 'reactorTemp', type: 'number', required: true, min: limits.reactorTemp.min, max: limits.reactorTemp.max, description: 'Температура реактора, °C' },
      { name: 'preheatA', type: 'number', min: limits.preheat.min, max: limits.preheat.max, description: 'Температура преднагревателя A, °C' },
      { name: 'preheatB', type: 'number', min: limits.preheat.min, max: limits.preheat.max, description: 'Температура преднагревателя B, °C' },
      { name: 'samplingIntervalSec', type: 'number', min: limits.samplingMinSec, description: 'Интервал отбора проб, с' },
    ],
    handler: (p, source) => {
      const r = validatePlan(p);
      if (!r.ok) {
        logEvent('warning', source, 'Подготовка отклонена: параметры вне диапазонов', { params: { issues: r.issues }, status: 'rejected' });
        return { ok: false, message: 'Параметры вне допустимых диапазонов', data: { issues: r.issues } };
      }
      adapter.prepareSynthesis(r.plan!);
      return { ok: true, message: `План подготовлен: ${r.plan!.id}`, data: { plan_id: r.plan!.id, plan: r.plan } };
    },
  },
  {
    name: 'start_synthesis',
    kind: 'control',
    description: 'Запустить синтез по подготовленному плану (plan_id) либо по прямым параметрам.',
    params: [
      { name: 'plan_id', type: 'string', description: 'Идентификатор подготовленного плана (если есть)' },
      { name: 'flowA', type: 'number', min: limits.flow.min, max: limits.flow.max, description: 'Расход A, мл/мин (если без plan_id)' },
      { name: 'flowB', type: 'number', min: limits.flow.min, max: limits.flow.max, description: 'Расход B, мл/мин (если без plan_id)' },
      { name: 'reactorTemp', type: 'number', min: limits.reactorTemp.min, max: limits.reactorTemp.max, description: 'Температура реактора, °C (если без plan_id)' },
      { name: 'preheatA', type: 'number', min: limits.preheat.min, max: limits.preheat.max, description: 'Температура преднагревателя A, °C' },
      { name: 'preheatB', type: 'number', min: limits.preheat.min, max: limits.preheat.max, description: 'Температура преднагревателя B, °C' },
      { name: 'samplingIntervalSec', type: 'number', min: limits.samplingMinSec, description: 'Интервал отбора проб, с' },
    ],
    handler: (p, source) => {
      let plan: SynthesisPlan | undefined;
      const planId = p.plan_id ? String(p.plan_id) : null;
      if (planId && state.plan && state.plan.id === planId) {
        plan = state.plan;
      } else {
        const r = validatePlan(p);
        if (!r.ok) {
          logEvent('warning', source, 'Запуск отклонён: параметры вне диапазонов', { params: { issues: r.issues }, status: 'rejected' });
          return { ok: false, message: 'Параметры вне допустимых диапазонов', data: { issues: r.issues } };
        }
        plan = r.plan!;
      }
      adapter.startSynthesis(plan);
      return { ok: true, message: 'Синтез запущен', data: { plan_id: plan.id } };
    },
  },
  {
    name: 'stop_synthesis',
    kind: 'control',
    description: 'Остановить текущий эксперимент и перевести установку в безопасное состояние.',
    params: [],
    handler: (_p, source) => {
      adapter.stopSynthesis();
      logEvent('command', source, 'Команда остановки эксперимента', { status: 'ok' });
      return { ok: true, message: 'Эксперимент остановлен' };
    },
  },
  {
    name: 'set_pump_flows',
    kind: 'control',
    description: 'Задать расходы реагентов A и B в допустимых пределах.',
    params: [
      { name: 'flowA', type: 'number', required: true, min: limits.flow.min, max: limits.flow.max, description: 'Расход A, мл/мин' },
      { name: 'flowB', type: 'number', required: true, min: limits.flow.min, max: limits.flow.max, description: 'Расход B, мл/мин' },
    ],
    handler: (p, source) => {
      const a = num(p.flowA), b = num(p.flowB);
      if (a === null || b === null) return { ok: false, message: 'Нужны числовые flowA и flowB' };
      if (a < limits.flow.min || a > limits.flow.max || b < limits.flow.min || b > limits.flow.max) {
        logEvent('warning', source, `Расходы отклонены: вне диапазона ${limits.flow.min}–${limits.flow.max} мл/мин`, { params: { flowA: a, flowB: b }, status: 'rejected' });
        return { ok: false, message: `Расход вне диапазона ${limits.flow.min}–${limits.flow.max} мл/мин` };
      }
      adapter.setPumpFlows(a, b);
      return { ok: true, message: `Расходы заданы: A=${a}, B=${b} мл/мин` };
    },
  },
  {
    name: 'set_temperature_zones',
    kind: 'control',
    description: 'Задать температуры преднагревателей и термостата реактора.',
    params: [
      { name: 'preheaterA', type: 'number', min: limits.preheat.min, max: limits.preheat.max, description: 'Преднагреватель A, °C' },
      { name: 'preheaterB', type: 'number', min: limits.preheat.min, max: limits.preheat.max, description: 'Преднагреватель B, °C' },
      { name: 'reactor', type: 'number', min: limits.reactorTemp.min, max: limits.reactorTemp.max, description: 'Термостат реактора, °C' },
    ],
    handler: (p, source) => {
      const z: { preheaterA?: number; preheaterB?: number; reactor?: number } = {};
      const issues: string[] = [];
      if (p.preheaterA !== undefined) { const v = num(p.preheaterA); if (v === null || v < limits.preheat.min || v > limits.preheat.max) issues.push(`preheaterA вне ${limits.preheat.min}–${limits.preheat.max}`); else z.preheaterA = v; }
      if (p.preheaterB !== undefined) { const v = num(p.preheaterB); if (v === null || v < limits.preheat.min || v > limits.preheat.max) issues.push(`preheaterB вне ${limits.preheat.min}–${limits.preheat.max}`); else z.preheaterB = v; }
      if (p.reactor !== undefined) { const v = num(p.reactor); if (v === null || v < limits.reactorTemp.min || v > limits.reactorTemp.max) issues.push(`reactor вне ${limits.reactorTemp.min}–${limits.reactorTemp.max}`); else z.reactor = v; }
      if (issues.length > 0) {
        logEvent('warning', source, 'Температуры отклонены: вне диапазонов', { params: { issues }, status: 'rejected' });
        return { ok: false, message: 'Температура вне допустимых диапазонов', data: { issues } };
      }
      if (Object.keys(z).length === 0) return { ok: false, message: 'Не задано ни одной зоны' };
      adapter.setTemperatureZones(z);
      return { ok: true, message: 'Температуры заданы' };
    },
  },
  {
    name: 'start_sampling',
    kind: 'control',
    description: 'Включить отбор проб через перистальтический дозатор на ЯМР-модуль.',
    params: [{ name: 'intervalSec', type: 'number', required: true, min: limits.samplingMinSec, description: 'Интервал отбора проб, с (не чаще 5 с)' }],
    handler: (p, source) => {
      const v = num(p.intervalSec ?? p.interval_sec);
      if (v === null) return { ok: false, message: 'Нужен числовой intervalSec' };
      if (v < limits.samplingMinSec) {
        logEvent('warning', source, `Отбор отклонён: интервал ${v} с < ${limits.samplingMinSec} с`, { status: 'rejected' });
        return { ok: false, message: `Интервал отбора не может быть меньше ${limits.samplingMinSec} с` };
      }
      adapter.startSampling(v);
      return { ok: true, message: `Отбор проб включён, интервал ${v} с` };
    },
  },
  {
    name: 'start_nmr_initial_calibration',
    kind: 'control',
    description: 'Запустить стартовую калибровку ЯМР-модуля.',
    params: [],
    handler: (_p, source) => {
      if (state.nmr.status !== 'IDLE' && state.nmr.status !== 'READY') return { ok: false, message: 'ЯМР занят' };
      adapter.startNmrInitialCalibration();
      logEvent('command', source, 'Запрошена стартовая калибровка ЯМР', { status: 'ok' });
      return { ok: true, message: 'Стартовая калибровка ЯМР запущена' };
    },
  },
  {
    name: 'generate_experiment_report',
    kind: 'report',
    description: 'Сформировать краткий отчёт по последнему эксперименту.',
    params: [],
    handler: (_p, source) => {
      const e = state.experiment;
      if (!e) return { ok: false, message: 'Нет данных об эксперименте' };
      const conc = e.concentrations;
      const avg = conc.length ? conc.reduce((a, b) => a + b, 0) / conc.length : 0;
      const report = {
        id: e.id,
        startedAt: new Date(e.startedAt).toISOString(),
        finishedAt: e.finishedAt ? new Date(e.finishedAt).toISOString() : null,
        durationSec: e.finishedAt ? Math.round((e.finishedAt - e.startedAt) / 1000) : Math.round((Date.now() - e.startedAt) / 1000),
        setFlows: { A: e.setFlowA, B: e.setFlowB },
        temperatures: { preheaterA: e.setPreheatA, preheaterB: e.setPreheatB, reactor: e.setReactorTemp, reactorActual: round(state.thermal.reactor.current) },
        pressureRange: { min: e.pressureMin === Infinity ? 0 : round(e.pressureMin), max: round(e.pressureMax) },
        sampleCount: e.sampleCount,
        concentrations: conc.map((c) => round(c, 3)),
        avgConcentration: round(avg, 3),
        lastConcentration: conc.length ? round(conc[conc.length - 1], 3) : null,
        warnings: e.warnings,
        errors: e.errors,
        finalStatus: e.finalStatus,
      };
      logEvent('report', source, `Сформирован отчёт по эксперименту ${e.id}`, { status: 'ok' });
      return { ok: true, message: 'Отчёт сформирован', data: report };
    },
  },

  {
    name: 'emergency_stop',
    kind: 'control',
    description: 'Аварийная остановка: немедленно обнулить потоки и перевести в безопасное состояние.',
    params: [],
    handler: (_p, source) => {
      logEvent('command', source, 'АВАРИЙНАЯ ОСТАНОВКА (ручная)', { status: 'ok' });
      adapter.emergencyStop();
      return { ok: true, message: 'Аварийная остановка выполнена' };
    },
  },
  {
    name: 'reset_demo',
    kind: 'control',
    description: 'Сбросить демо в исходное состояние и очистить эксперимент.',
    params: [],
    handler: (_p, source) => {
      adapter.reset();
      logEvent('command', source, 'Сброс демо', { status: 'ok' });
      return { ok: true, message: 'Демо сброшено' };
    },
  },
];

const byName = new Map(tools.map((t) => [t.name, t]));

export function listTools(): Tool[] {
  return tools;
}

export function runTool(name: string, params: Record<string, unknown>, source: LogSource): ToolResult {
  const tool = byName.get(name);
  if (!tool) return { ok: false, message: `Неизвестный инструмент: ${name}` };
  try {
    return tool.handler(params ?? {}, source);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logEvent('error', source, `Ошибка инструмента ${name}: ${msg}`, { status: 'error' });
    return { ok: false, message: msg };
  }
}

export function experimentLog() {
  return getLog();
}
