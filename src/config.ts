import { randomBytes } from 'node:crypto';

function env(...names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}
function envOr(fallback: string, ...names: string[]): string {
  return env(...names) ?? fallback;
}

const authPassFromEnv = env('AUTH_PASSWORD', 'AUTH_PASS') !== undefined;
const internalTokenFromEnv = env('INTERNAL_TOKEN') !== undefined;

export const security = {
  usingDefaultPassword: !authPassFromEnv,
  usingEphemeralInternalToken: !internalTokenFromEnv,
};

export const config = {
  host: envOr('127.0.0.1', 'APP_HOST', 'HOST'),
  port: parseInt(envOr('8080', 'APP_PORT', 'PORT'), 10),

  publicUrl: envOr('http://localhost:8080', 'PUBLIC_URL'),

  auth: {
    user: envOr('demo', 'AUTH_USER'),
    pass: envOr('demo', 'AUTH_PASSWORD', 'AUTH_PASS'),
  },

  internalToken: env('INTERNAL_TOKEN') ?? randomBytes(32).toString('hex'),

  openaiApiKey: env('OPENAI_API_KEY'),
  openaiModel: envOr('gpt-5.5', 'OPENAI_MODEL'),
  mcpServerUrl: envOr('http://127.0.0.1:8090/mcp', 'MCP_SERVER_URL'),

  tickMs: parseInt(envOr('500', 'TICK_MS'), 10),
};
