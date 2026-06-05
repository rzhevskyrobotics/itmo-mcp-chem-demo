import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { listTools, runTool, type Tool, type ToolParam } from './tools.js';
import { logEvent } from './log.js';

function zodFor(p: ToolParam): ZodTypeAny {
  let t: ZodTypeAny;
  if (p.type === 'number') {
    let n = z.number();
    if (typeof p.min === 'number') n = n.min(p.min);
    if (typeof p.max === 'number') n = n.max(p.max);
    t = n;
  } else if (p.type === 'boolean') {
    t = z.boolean();
  } else {
    t = z.string();
  }
  t = t.describe(p.description);
  return p.required ? t : t.optional();
}

function shapeFor(tool: Tool): ZodRawShape {
  const shape: ZodRawShape = {};
  for (const p of tool.params) shape[p.name] = zodFor(p);
  return shape;
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'reactor-demo', version: '0.3.0' });

  for (const tool of listTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: `[${tool.kind}] ${tool.description}`,
        inputSchema: shapeFor(tool),
      },
      async (args: Record<string, unknown>) => {
        const r = runTool(tool.name, args ?? {}, 'mcp');
        const text = JSON.stringify({ ok: r.ok, message: r.message, data: r.data ?? null });
        const result: {
          content: { type: 'text'; text: string }[];
          isError: boolean;
          structuredContent?: Record<string, unknown>;
        } = { content: [{ type: 'text', text }], isError: !r.ok };
        if (r.data && typeof r.data === 'object') {
          result.structuredContent = r.data as Record<string, unknown>;
        }
        return result;
      },
    );
  }

  return server;
}

function authorized(req: Request): boolean {
  const expected = process.env.MCP_CONNECTOR_TOKEN;
  if (!expected) return true;
  const h = req.headers.authorization;
  return !!h && h.startsWith('Bearer ') && h.slice(7) === expected;
}

const rpcError = (res: Response, code: number, message: string, status = 200) =>
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });

export function mountMcp(app: Express, path = '/mcp'): void {

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post(path, async (req: Request, res: Response) => {
    if (!authorized(req)) return rpcError(res, -32001, 'Unauthorized', 401);
    try {
      const sid = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sid && transports[sid]) {
        transport = transports[sid];
      } else if (!sid && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { transports[id] = transport; },
        });
        transport.onclose = () => {
          if (transport.sessionId) delete transports[transport.sessionId];
        };
        const server = buildServer();
        await server.connect(transport);
      } else {
        return rpcError(res, -32000, 'Не инициализирована сессия MCP', 400);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logEvent('error', 'mcp', `Ошибка MCP-запроса: ${msg}`, { status: 'error' });
      if (!res.headersSent) rpcError(res, -32603, 'Internal error', 500);
    }
  });

  const bySession = async (req: Request, res: Response) => {
    if (!authorized(req)) return rpcError(res, -32001, 'Unauthorized', 401);
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (!sid || !transports[sid]) return rpcError(res, -32000, 'Нет валидной сессии MCP', 400);
    await transports[sid].handleRequest(req, res);
  };
  app.get(path, bySession);
  app.delete(path, bySession);

  logEvent('info', 'system', `MCP-сервер смонтирован на ${path} (Streamable HTTP)`, { status: 'ok' });
}
