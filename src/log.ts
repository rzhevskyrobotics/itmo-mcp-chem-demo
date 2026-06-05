export type LogType = 'command' | 'response' | 'check' | 'warning' | 'error' | 'telemetry' | 'report' | 'info';

export type LogSource = 'user' | 'agent' | 'mcp' | 'adapter' | 'emulator' | 'nmr' | 'system';

export type LogStatus = 'ok' | 'rejected' | 'running' | 'error';

export interface LogEntry {
  id: number;
  t: number;
  type: LogType;
  source: LogSource;
  message: string;
  params?: Record<string, unknown>;
  status?: LogStatus;
}

const MAX = 500;
const buffer: LogEntry[] = [];
let seq = 0;

type Listener = (entry: LogEntry) => void;
const listeners = new Set<Listener>();

export function logEvent(
  type: LogType,
  source: LogSource,
  message: string,
  opts: { params?: Record<string, unknown>; status?: LogStatus } = {}
): LogEntry {
  const entry: LogEntry = { id: ++seq, t: Date.now(), type, source, message, ...opts };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();
  for (const l of listeners) {
    try { l(entry); } catch {  }
  }
  return entry;
}

export function getLog(): LogEntry[] {
  return buffer.slice();
}

export function clearLog(): void {
  buffer.length = 0;
}

export function onLog(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
