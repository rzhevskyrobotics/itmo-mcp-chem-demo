import { config } from './config.js';
import { logEvent } from './log.js';

export interface ChatReq {
  message?: string;
  previous_response_id?: string | null;
}
export interface ChatResp {
  ok: boolean;
  text?: string;
  response_id?: string;
  tool_calls?: { name: string; ok: boolean }[];
  message?: string;
}

const INSTRUCTIONS = [
  'Ты — ассистент-оператор проточной химической установки. Управляешь ею ТОЛЬКО через',
  'предоставленные MCP-инструменты (get_system_status, get_telemetry, validate_synthesis_plan,',
  'prepare_synthesis, start_synthesis, stop_synthesis, set_pump_flows, set_temperature_zones,',
  'start_sampling, start_nmr_initial_calibration, generate_experiment_report, emergency_stop, reset_demo).',
  'Правила:',
  '— Перед запуском синтеза проверяй параметры через validate_synthesis_plan; не выходи за допустимые диапазоны.',
  '— На просьбу «провести синтез» подготовь и запусти план (prepare_synthesis → start_synthesis).',
  '— Не выдумывай показания: для статуса/телеметрии вызывай инструменты чтения.',
  '— emergency_stop — только при явной угрозе или прямой просьбе. reset_demo — только по явной команде.',
  '— Отвечай кратко и по-русски, числа — с единицами измерения.',
].join('\n');

interface OpenAIOutputItem {
  type?: string;
  role?: string;
  name?: string;
  error?: unknown;
  content?: { type?: string; text?: string }[];
}
interface OpenAIResponse {
  id?: string;
  output_text?: string;
  output?: OpenAIOutputItem[];
  error?: { message?: string };
}

function extractText(data: OpenAIResponse): string {
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const parts: string[] = [];
  for (const item of data.output ?? []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const c of item.content) if (c.type === 'output_text' && c.text) parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

function extractToolCalls(data: OpenAIResponse): { name: string; ok: boolean }[] {
  const calls: { name: string; ok: boolean }[] = [];
  for (const item of data.output ?? []) {
    if (item.type === 'mcp_call') calls.push({ name: item.name ?? 'tool', ok: !item.error });
  }
  return calls;
}

export async function runChat(body: ChatReq): Promise<ChatResp> {
  const message = (body?.message ?? '').trim();
  if (!message) return { ok: false, message: 'Пустой запрос' };
  if (!config.openaiApiKey) {
    return { ok: false, message: 'OPENAI_API_KEY не задан на сервере (см. .env).' };
  }

  const serverUrl = `${config.publicUrl.replace(/\/+$/, '')}/mcp`;
  const connectorToken = process.env.MCP_CONNECTOR_TOKEN;

  const mcpTool: Record<string, unknown> = {
    type: 'mcp',
    server_label: 'reactor',
    server_url: serverUrl,
    require_approval: 'never',
  };
  if (connectorToken) mcpTool.headers = { Authorization: `Bearer ${connectorToken}` };

  const payload: Record<string, unknown> = {
    model: config.openaiModel,
    instructions: INSTRUCTIONS,
    input: message,
    tools: [mcpTool],
  };
  if (body.previous_response_id) payload.previous_response_id = body.previous_response_id;

  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const raw = await r.text();
    let data: OpenAIResponse | null = null;
    try { data = JSON.parse(raw) as OpenAIResponse; } catch { data = null; }
    if (!r.ok) {
      const msg = data?.error?.message ?? (raw ? raw.slice(0, 300) : `HTTP ${r.status}`);
      logEvent('error', 'agent', `Ошибка OpenAI (HTTP ${r.status}): ${msg}`, { status: 'error' });
      return { ok: false, message: msg };
    }
    if (!data) {
      return { ok: false, message: `Некорректный ответ OpenAI: ${raw.slice(0, 200)}` };
    }
    const text = extractText(data);
    const tool_calls = extractToolCalls(data);
    if (tool_calls.length) {
      logEvent('info', 'agent', `Агент выполнил инструментов: ${tool_calls.map((t) => t.name).join(', ')}`, { status: 'ok' });
    }
    return { ok: true, text: text || '(агент не вернул текста)', response_id: data.id, tool_calls };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logEvent('error', 'agent', `Сбой запроса к OpenAI: ${msg}`, { status: 'error' });
    return { ok: false, message: msg };
  }
}
