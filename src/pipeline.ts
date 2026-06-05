import { config } from './config.js';
import { logEvent } from './log.js';
import { STAGES, stageById, TOTAL_STAGES, type FallbackContext, type StageDef } from './agents.js';

export interface ProjectSpec {
  request: string;
  product: string;
  application: string;
  properties: string;
  constraints: string;
  scale: string;
}
export interface StageOutput {
  id: number;
  module: string;
  agent: string;
  text: string;
  source: 'gpt' | 'fallback' | 'installation';
  at: number;
}
export interface SuggestedPlan {
  flowA: number; flowB: number; reactorTemp: number;
  preheatA: number; preheatB: number; samplingIntervalSec: number;
}
export interface ExperimentSummary {
  flowA: number; flowB: number; reactorTemp: number;
  sampleCount: number; lastConc: number; avgConc: number;
  pressureMin: number; pressureMax: number; durationSec: number; finalStatus: string;
}
type ProjectStatus = 'INTAKE' | 'RUNNING' | 'AWAIT_INSTALLATION' | 'INSTALLATION_DONE' | 'FINISHED';

export interface Project {
  id: string;
  createdAt: number;
  status: ProjectStatus;
  intakeStep: number;
  intakeAnswers: Record<string, string>;
  intakeMsgs: string[];
  intakeAsked: string;
  spec: ProjectSpec | null;
  currentStage: number;
  outputs: StageOutput[];
  suggestedPlan: SuggestedPlan | null;
  experiment: ExperimentSummary | null;
}

const projects = new Map<string, Project>();
let seed = 0;
const newId = () => `PRJ-${Date.now().toString(36)}-${++seed}`;

export function getProject(id: string): Project | undefined {
  return projects.get(id);
}

const INTAKE_FIELDS: { key: keyof ProjectSpec; q: string }[] = [
  { key: 'request', q: 'Опишите задачу как можно полнее: какой продукт нужен, для чего, ключевые требования, ограничения и масштаб. Можно одним сообщением — я сам разберу детали и уточню только то, чего не хватает.' },
  { key: 'application', q: 'Где и в какой среде будет применяться продукт? (область применения, рабочая среда)' },
  { key: 'properties', q: 'Какие ключевые целевые свойства критичны? (например: активность, термостабильность, растворимость)' },
  { key: 'constraints', q: 'Есть ли ограничения и требования безопасности? (запрещённые компоненты, токсичность, регуляторика)' },
  { key: 'scale', q: 'Какой целевой масштаб? (ориентир по объёму опытной партии или тоннажу)' },
];
const filledFields = (a: Record<string, string>) =>
  INTAKE_FIELDS.filter((f) => a[f.key] && a[f.key] !== '—').length;
const nextMissingField = (a: Record<string, string>) =>
  INTAKE_FIELDS.find((f) => !a[f.key] || a[f.key] === '—');

const INTAKE_GREETING =
  'Здравствуйте. Я — агент постановки задачи. Опишите, какой химический продукт нужно ' +
  'разработать. Я проанализирую ваш ответ, сам извлеку нужные параметры и задам только ' +
  'недостающие вопросы.';

export function startIntake(initialRequest?: string): {
  projectId: string; greeting: string; question: string; step: number; total: number;
} {
  const p: Project = {
    id: newId(), createdAt: Date.now(), status: 'INTAKE',
    intakeStep: 0, intakeAnswers: {}, intakeMsgs: [], intakeAsked: 'request', spec: null,
    currentStage: 1, outputs: [], suggestedPlan: null, experiment: null,
  };
  projects.set(p.id, p);
  logEvent('info', 'agent', 'Агент постановки задачи: начато уточнение ТЗ', { status: 'running' });

  if (initialRequest && initialRequest.trim()) {
    p.intakeMsgs.push(initialRequest.trim());
    p.intakeAnswers['request'] = initialRequest.trim();
  }
  return {
    projectId: p.id, greeting: INTAKE_GREETING,
    question: INTAKE_FIELDS[0].q, step: filledFields(p.intakeAnswers), total: INTAKE_FIELDS.length,
  };
}

export interface IntakeAnswerResult {
  done: boolean;
  question?: string; step?: number; total?: number;
  spec?: ProjectSpec; summaryText?: string;
}

function parseJsonLoose(raw: string): any | null {
  let t = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const i = t.indexOf('{'); const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) t = t.slice(i, j + 1);
  try { return JSON.parse(t); } catch { return null; }
}
async function extractSpecFields(p: Project): Promise<boolean> {
  const dialogue = p.intakeMsgs.map((m, i) => `Реплика ${i + 1}: ${m}`).join('\n');
  const instructions = [
    'Ты — агент постановки задачи в системе автономной разработки химических продуктов.',
    'Из реплик заказчика извлеки и НОРМАЛИЗУЙ поля технического задания.',
    'Верни СТРОГО JSON без markdown и пояснений со следующими ключами и строковыми значениями:',
    '{"productName": string|null, "request": string|null, "application": string|null, "properties": string|null, "constraints": string|null, "scale": string|null}',
    'Смысл полей: request — суть задачи и целевой продукт кратко; productName — короткое название продукта (3–7 слов);',
    'application — где и в какой среде применяется; properties — ключевые целевые свойства; constraints — ограничения и требования безопасности; scale — целевой масштаб.',
    'Если по полю в репликах нет данных — верни для него null. Не выдумывай отсутствующее.',
    'Формулируй кратко, по существу, в именительном падеже, без вводных оборотов вроде «цель увеличить».',
  ].join('\n');
  const raw = await callOpenAI(instructions, dialogue || '(пусто)', 1);
  if (!raw) return false;
  const json = parseJsonLoose(raw);
  if (!json || typeof json !== 'object') return false;
  const a = p.intakeAnswers;
  const set = (k: string, v: unknown) => {
    if (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' && (!a[k] || a[k] === '—')) a[k] = v.trim();
  };
  set('request', json.request); set('application', json.application); set('properties', json.properties);
  set('constraints', json.constraints); set('scale', json.scale);
  if (typeof json.productName === 'string' && json.productName.trim()) a['__product'] = json.productName.trim();
  return true;
}

export async function answerIntake(projectId: string, answer: string): Promise<IntakeAnswerResult | { error: string }> {
  const p = projects.get(projectId);
  if (!p) return { error: 'Проект не найден' };
  if (p.status !== 'INTAKE') return { error: 'Этап постановки задачи уже завершён' };

  const ans = (answer ?? '').trim();
  const asked = p.intakeAsked;
  if (ans) p.intakeMsgs.push(ans);

  await extractSpecFields(p);

  if (asked && ans && (!p.intakeAnswers[asked] || p.intakeAnswers[asked] === '—')) {
    p.intakeAnswers[asked] = ans;
  }

  const next = nextMissingField(p.intakeAnswers);
  if (next) {
    p.intakeAsked = next.key;
    return { done: false, question: next.q, step: filledFields(p.intakeAnswers), total: INTAKE_FIELDS.length };
  }

  const a = p.intakeAnswers;
  const spec: ProjectSpec = {
    request: a['request'] || '—',
    product: a['__product'] || shortProduct(a['request'] || '—'),
    application: a['application'] || '—',
    properties: a['properties'] || '—',
    constraints: a['constraints'] || '—',
    scale: a['scale'] || '—',
  };
  p.spec = spec;
  p.status = 'RUNNING';

  const stage1 = stageById.get(1)!;
  dbg(1, 'start', `Этап 1 «${stage1.module}» — старт`, { module: stage1.module, agent: stage1.agent });
  const t0 = Date.now();
  const text = await produceStageText(p, stage1);
  const ms = Date.now() - t0;
  recordOutput(p, stage1, text.text, text.source);
  p.currentStage = 2;

  logEvent('info', 'agent', 'Агент постановки задачи: ТЗ сформировано', { status: 'ok' });
  dbg(1, 'done', `Этап 1 завершён за ${ms} мс (источник: ${text.source === 'gpt' ? 'GPT' : 'эмуляция'})`, { ms, source: text.source }, 'ok');
  return { done: true, spec, summaryText: text.text };
}

function shortProduct(req: string): string {
  const words = req.replace(/\s+/g, ' ').trim().split(' ');
  return words.slice(0, 8).join(' ') + (words.length > 8 ? '…' : '');
}

function fallbackContext(p: Project): FallbackContext {
  const s = p.spec!;
  return {
    request: s.request, product: s.product, properties: s.properties,
    application: s.application, constraints: s.constraints, scale: s.scale,
    experiment: p.experiment ?? undefined,
  };
}

function contextSummary(p: Project): string {
  const s = p.spec!;
  const lines = [
    `Задача (формализованное ТЗ):`,
    `- Продукт: ${s.product}`,
    `- Целевые свойства: ${s.properties}`,
    `- Применение/среда: ${s.application}`,
    `- Ограничения/безопасность: ${s.constraints}`,
    `- Масштаб: ${s.scale}`,
  ];
  const prev = p.outputs.filter((o) => o.id >= 2).slice(-6);
  if (prev.length) {
    lines.push('', 'Итоги предыдущих этапов:');
    for (const o of prev) lines.push(`- Этап ${o.id} (${o.agent}): ${o.text.replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  if (p.experiment) {
    const e = p.experiment;
    lines.push('', `Данные эксперимента на установке: расходы A=${e.flowA}, B=${e.flowB} мл/мин; реактор ${e.reactorTemp} °C; ` +
      `проб ${e.sampleCount}; относительная концентрация целевого вещества (посл./сред.) ${(e.lastConc * 100).toFixed(0)}%/${(e.avgConc * 100).toFixed(0)}%; ` +
      `давление ${e.pressureMin.toFixed(1)}–${e.pressureMax.toFixed(1)} бар; статус ${e.finalStatus}.`);
  }
  return lines.join('\n');
}

function dbg(stage: number, phase: string, message: string, extra: Record<string, unknown> = {}, status: 'ok' | 'rejected' | 'running' | 'error' = 'running') {
  logEvent('info', 'agent', message, { params: { debug: true, stage, phase, ...extra }, status });
}

async function callOpenAI(instructions: string, input: string, stageId: number): Promise<string | null> {
  if (!config.openaiApiKey) {
    dbg(stageId, 'fallback', `Этап ${stageId}: ключ OpenAI не задан — офлайн-шаблон`, { reason: 'no_key' }, 'rejected');
    return null;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  const t0 = Date.now();
  dbg(stageId, 'openai_request', `Этап ${stageId}: запрос к OpenAI (модель ${config.openaiModel})`, { model: config.openaiModel });
  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openaiApiKey}` },
      body: JSON.stringify({ model: config.openaiModel, instructions, input }),
      signal: ctrl.signal,
    });
    const ms = Date.now() - t0;
    const raw = await r.text();
    let data: any = null;
    try { data = JSON.parse(raw); } catch {
      dbg(stageId, 'fallback', `Этап ${stageId}: ответ OpenAI не разобран (HTTP ${r.status}) — офлайн-шаблон`, { http: r.status, ms, reason: 'bad_json' }, 'rejected');
      return null;
    }
    if (!r.ok) {
      const detail = data?.error?.message ? String(data.error.message).slice(0, 160) : `HTTP ${r.status}`;
      dbg(stageId, 'fallback', `Этап ${stageId}: OpenAI вернул ошибку (HTTP ${r.status}: ${detail}) — офлайн-шаблон`, { http: r.status, ms, reason: detail }, 'rejected');
      return null;
    }
    let text = (typeof data.output_text === 'string' && data.output_text.trim()) ? data.output_text.trim() : '';
    if (!text) {
      const parts: string[] = [];
      for (const item of data.output ?? []) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) if (c.type === 'output_text' && c.text) parts.push(c.text);
        }
      }
      text = parts.join('\n').trim();
    }
    if (!text) {
      dbg(stageId, 'fallback', `Этап ${stageId}: OpenAI вернул пустой ответ — офлайн-шаблон`, { http: r.status, ms, reason: 'empty' }, 'rejected');
      return null;
    }
    dbg(stageId, 'openai_response', `Этап ${stageId}: ответ OpenAI получен (HTTP ${r.status}, ${ms} мс)`, { http: r.status, ms }, 'ok');
    return text;
  } catch (e) {
    const ms = Date.now() - t0;
    const aborted = (e as any)?.name === 'AbortError';
    const reason = aborted ? 'таймаут 30с' : (e instanceof Error ? e.message : String(e));
    dbg(stageId, 'fallback', `Этап ${stageId}: сбой запроса к OpenAI (${reason}, ${ms} мс) — офлайн-шаблон`, { ms, reason, timeout: aborted }, 'rejected');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function produceStageText(p: Project, stage: StageDef): Promise<{ text: string; source: 'gpt' | 'fallback' }> {
  const instructions = [
    `Ты — «${stage.agent}». Это этап ${stage.id} многоагентной системы автономной разработки химического продукта.`,
    `Твоя функция: ${stage.does}`,
    `Дай правдоподобный результат этого этапа на русском языке: 3–5 коротких пунктов, по делу, без преамбул и без markdown-заголовков.`,
    `Опирайся на формализованное ТЗ и итоги предыдущих этапов из контекста. Не выдумывай конкретные численные данные эксперимента, если их нет в контексте.`,
  ].join('\n');
  const gpt = await callOpenAI(instructions, contextSummary(p), stage.id);
  if (gpt) return { text: gpt, source: 'gpt' };
  return { text: stage.fallback(fallbackContext(p)), source: 'fallback' };
}

function recordOutput(p: Project, stage: StageDef, text: string, source: 'gpt' | 'fallback' | 'installation') {
  p.outputs.push({ id: stage.id, module: stage.module, agent: stage.agent, text, source, at: Date.now() });
}

export interface RunStageResult {
  id: number; module: string; agent: string; kind: string;
  text?: string; source?: string;
  requiresInstallation?: boolean; suggestedPlan?: SuggestedPlan;
  currentStage: number; total: number; status: ProjectStatus;
  error?: string;
}

export async function runStage(projectId: string, stageId: number): Promise<RunStageResult | { error: string }> {
  const p = projects.get(projectId);
  if (!p) return { error: 'Проект не найден' };
  if (!p.spec) return { error: 'Сначала завершите постановку задачи' };
  const stage = stageById.get(stageId);
  if (!stage) return { error: `Неизвестный этап ${stageId}` };
  if (stageId !== p.currentStage) {
    return { error: `Сейчас ожидается этап ${p.currentStage}, а не ${stageId}` };
  }

  if (stage.kind === 'installation') {
    const plan = deriveSuggestedPlan(p);
    p.suggestedPlan = plan;
    p.status = 'AWAIT_INSTALLATION';
    logEvent('info', 'agent', `Агент экспериментального контура: установка готова к запуску (этап 13)`, { params: { ...plan }, status: 'running' });
    return {
      id: stage.id, module: stage.module, agent: stage.agent, kind: stage.kind,
      requiresInstallation: true, suggestedPlan: plan,
      currentStage: p.currentStage, total: TOTAL_STAGES, status: p.status,
    };
  }

  logEvent('info', 'agent', `${stage.agent}: этап ${stage.id} — «${stage.module}»`, { status: 'running' });
  dbg(stage.id, 'start', `Этап ${stage.id} «${stage.module}» — старт`, { module: stage.module, agent: stage.agent });
  const t0 = Date.now();
  const out = await produceStageText(p, stage);
  const ms = Date.now() - t0;
  recordOutput(p, stage, out.text, out.source);
  p.currentStage += 1;
  if (p.currentStage > TOTAL_STAGES) p.status = 'FINISHED';
  logEvent('info', 'agent', `${stage.agent}: этап ${stage.id} завершён`, { status: 'ok' });
  dbg(stage.id, 'done', `Этап ${stage.id} завершён за ${ms} мс (источник: ${out.source === 'gpt' ? 'GPT' : 'эмуляция'})`, { ms, source: out.source }, 'ok');

  return {
    id: stage.id, module: stage.module, agent: stage.agent, kind: stage.kind,
    text: out.text, source: out.source,
    currentStage: p.currentStage, total: TOTAL_STAGES, status: p.status,
  };
}

function deriveSuggestedPlan(_p: Project): SuggestedPlan {
  return { flowA: 1.0, flowB: 2.0, reactorTemp: 70, preheatA: 40, preheatB: 40, samplingIntervalSec: 5 };
}

export function recordInstallationResult(projectId: string, exp: ExperimentSummary): RunStageResult | { error: string } {
  const p = projects.get(projectId);
  if (!p) return { error: 'Проект не найден' };
  if (p.currentStage !== 13) return { error: 'Этап установки сейчас не ожидается' };
  p.experiment = exp;
  const stage13 = stageById.get(13)!;
  const text =
    `Опыт выполнен на установке через MCP-контур.\n` +
    `Расходы A=${exp.flowA} / B=${exp.flowB} мл/мин, реактор ${exp.reactorTemp} °C, проб: ${exp.sampleCount}.\n` +
    `Относительная концентрация целевого вещества (посл./сред.): ${(exp.lastConc * 100).toFixed(1)}% / ${(exp.avgConc * 100).toFixed(1)}%.\n` +
    `Давление ${exp.pressureMin.toFixed(1)}–${exp.pressureMax.toFixed(1)} бар. Статус: ${exp.finalStatus}.`;
  recordOutput(p, stage13, text, 'installation');
  p.currentStage = 14;
  p.status = 'INSTALLATION_DONE';
  logEvent('report', 'agent', 'Результаты установки переданы в пайплайн (этап 13 завершён)', { status: 'ok' });
  return {
    id: 13, module: stage13.module, agent: stage13.agent, kind: stage13.kind,
    text, source: 'installation',
    currentStage: p.currentStage, total: TOTAL_STAGES, status: p.status,
  };
}

export function assembleReport(projectId: string): unknown | { error: string } {
  const p = projects.get(projectId);
  if (!p || !p.spec) return { error: 'Проект не найден или не завершён' };
  const stage16 = p.outputs.find((o) => o.id === 16);
  return {
    projectId: p.id,
    createdAt: new Date(p.createdAt).toISOString(),
    spec: p.spec,
    experiment: p.experiment,
    executiveSummary: stage16?.text ?? '(итоговый этап ещё не выполнен)',
    stages: p.outputs.map((o) => ({ id: o.id, module: o.module, agent: o.agent, source: o.source, text: o.text })),
    status: p.status,
  };
}

export function projectState(projectId: string): unknown | { error: string } {
  const p = projects.get(projectId);
  if (!p) return { error: 'Проект не найден' };
  return {
    id: p.id, status: p.status, currentStage: p.currentStage, total: TOTAL_STAGES,
    spec: p.spec, outputs: p.outputs, suggestedPlan: p.suggestedPlan, experiment: p.experiment,
  };
}

export function stagesMeta() {
  return STAGES.map((s) => ({ id: s.id, key: s.key, module: s.module, agent: s.agent, kind: s.kind, output: s.output }));
}
