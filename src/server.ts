import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

import { config, security } from './config.js';
import { state, displayPhase } from './state.js';
import { getLog, onLog, logEvent } from './log.js';
import { runTool, listTools } from './tools.js';
import { startSimulation } from './simulation.js';
import { mountMcp } from './mcp.js';
import { runChat } from './chat.js';
import {
  startIntake, answerIntake, runStage, recordInstallationResult,
  assembleReport, projectState, stagesMeta, type ExperimentSummary,
} from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const sessions = new Set<string>();
const isValidToken = (t?: string) => !!t && (t === config.internalToken || sessions.has(t));
const sourceForToken = (t?: string): 'mcp' | 'user' => (t === config.internalToken ? 'mcp' : 'user');
function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7) : undefined;
}
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isValidToken(bearer(req))) return next();
  res.status(401).json({ ok: false, message: 'Не авторизовано' });
}

type AsyncH = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: AsyncH) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    logEvent('error', 'system', `Ошибка обработки запроса ${req.path}: ${msg}`, { status: 'rejected' });
    if (!res.headersSent) res.status(500).json({ ok: false, message: 'Внутренняя ошибка: ' + msg });
  });
};

const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (username === config.auth.user && password === config.auth.pass) {
    const token = randomBytes(24).toString('hex');
    sessions.add(token);
    logEvent('info', 'user', `Вход в систему: ${username}`, { status: 'ok' });
    return res.json({ ok: true, token });
  }
  return res.status(401).json({ ok: false, message: 'Неверный логин или пароль' });
});

app.get('/api/state', requireAuth, (_req, res) => {
  res.json({ ok: true, state, phase: displayPhase(state), log: getLog() });
});

app.get('/api/tools', requireAuth, (_req, res) => {
  res.json({ ok: true, tools: listTools().map((t) => ({ name: t.name, kind: t.kind, description: t.description, params: t.params })) });
});

app.post('/api/action/:name', requireAuth, (req, res) => {
  const result = runTool(req.params.name, req.body ?? {}, sourceForToken(bearer(req)));
  res.status(result.ok ? 200 : 400).json(result);
});

mountMcp(app, '/mcp');

app.post('/api/chat', requireAuth, wrap(async (req, res) => {
  const out = await runChat(req.body ?? {});
  res.status(out.ok ? 200 : 400).json(out);
}));

app.get('/api/pipeline/stages', requireAuth, (_req, res) => {
  res.json({ ok: true, stages: stagesMeta() });
});

app.post('/api/pipeline/intake/start', requireAuth, (req, res) => {
  const r = startIntake(req.body?.request);
  res.json({ ok: true, ...r });
});
app.post('/api/pipeline/intake/answer', requireAuth, wrap(async (req, res) => {
  const r = await answerIntake(req.body?.projectId, req.body?.answer ?? '');
  if ('error' in r) return res.status(400).json({ ok: false, message: r.error });
  res.json({ ok: true, ...r });
}));

app.post('/api/pipeline/stage', requireAuth, wrap(async (req, res) => {
  const r = await runStage(req.body?.projectId, Number(req.body?.stage));
  if ('error' in r) return res.status(400).json({ ok: false, message: r.error });
  res.json({ ok: true, ...r });
}));

app.post('/api/pipeline/installation-result', requireAuth, (req, res) => {
  const exp = req.body?.experiment as ExperimentSummary | undefined;
  if (!exp) return res.status(400).json({ ok: false, message: 'Нет данных эксперимента' });
  const r = recordInstallationResult(req.body?.projectId, exp);
  if ('error' in r) return res.status(400).json({ ok: false, message: r.error });
  res.json({ ok: true, ...r });
});

app.get('/api/pipeline/project/:id', requireAuth, (req, res) => {
  const r = projectState(req.params.id);
  if (r && typeof r === 'object' && 'error' in (r as any)) return res.status(404).json({ ok: false, message: (r as any).error });
  res.json({ ok: true, project: r });
});

app.get('/api/pipeline/report/:id', requireAuth, (req, res) => {
  const r = assembleReport(req.params.id);
  if (r && typeof r === 'object' && 'error' in (r as any)) return res.status(404).json({ ok: false, message: (r as any).error });
  res.json({ ok: true, report: r });
});

app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const send = (ws: WebSocket, obj: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const token = url.searchParams.get('token') ?? undefined;
  if (!isValidToken(token)) { send(ws, { type: 'error', message: 'Не авторизовано' }); ws.close(); return; }
  send(ws, { type: 'snapshot', state, phase: displayPhase(state), log: getLog() });
  const off = onLog((entry) => send(ws, { type: 'log', entry }));
  ws.on('close', off);
});

function broadcastState() {
  const msg = JSON.stringify({ type: 'state', state, phase: displayPhase(state) });
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

const stopSim = startSimulation(config.tickMs, broadcastState);

httpServer.listen(config.port, config.host, () => {
  logEvent('info', 'system', `Сервер приложения запущен на http://${config.host}:${config.port}`, { status: 'ok' });
  console.log(`[reactor-demo] http://${config.host}:${config.port} (tick=${config.tickMs}ms)`);

  if (security.usingDefaultPassword) {
    const msg = 'Используется демо-пароль по умолчанию. Для сетевого развёртывания задайте AUTH_PASSWORD.';
    console.warn(`[reactor-demo] ВНИМАНИЕ: ${msg}`);
    logEvent('warning', 'system', msg, { status: 'rejected' });
  }
  if (security.usingEphemeralInternalToken) {
    console.warn('[reactor-demo] INTERNAL_TOKEN не задан — сгенерирован случайный токен на время жизни процесса.');
  }
});

const shutdown = () => { stopSim(); httpServer.close(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
