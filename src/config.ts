export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface DshConfig {
  baseUrl: URL;
  requestTimeoutMs: number;
  streamConnectTimeoutMs: number;
  reconnectDelayMs: number;
  maxTextChars: number;
  maxItems: number;
  logLevel: LogLevel;
}

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:3080/',
  requestTimeoutMs: 30_000,
  streamConnectTimeoutMs: 10_000,
  reconnectDelayMs: 1_000,
  maxTextChars: 4_000,
  maxItems: 100,
  logLevel: 'info' as LogLevel,
};

function boundedInteger(name: string, value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function logLevel(value: string | undefined): LogLevel {
  if (value === undefined || value.trim() === '') return DEFAULTS.logLevel;
  if (['silent', 'error', 'warn', 'info', 'debug'].includes(value as LogLevel)) return value as LogLevel;
  throw new Error('DSH_MCP_LOG_LEVEL must be one of silent, error, warn, info, debug');
}

export function loadConfig(env: Record<string, string | undefined> = process.env): DshConfig {
  const rawBaseUrl = env.DSH_BASE_URL ?? DEFAULTS.baseUrl;
  const baseUrl = new URL(rawBaseUrl);
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error('DSH_BASE_URL must use http or https');
  }
  return {
    baseUrl: new URL(baseUrl.toString().endsWith('/') ? baseUrl.toString() : `${baseUrl.toString()}/`),
    requestTimeoutMs: boundedInteger('DSH_REQUEST_TIMEOUT_MS', env.DSH_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs, 100, 300_000),
    streamConnectTimeoutMs: boundedInteger('DSH_STREAM_CONNECT_TIMEOUT_MS', env.DSH_STREAM_CONNECT_TIMEOUT_MS, DEFAULTS.streamConnectTimeoutMs, 100, 120_000),
    reconnectDelayMs: boundedInteger('DSH_RECONNECT_DELAY_MS', env.DSH_RECONNECT_DELAY_MS, DEFAULTS.reconnectDelayMs, 50, 60_000),
    maxTextChars: boundedInteger('DSH_MCP_MAX_TEXT_CHARS', env.DSH_MCP_MAX_TEXT_CHARS, DEFAULTS.maxTextChars, 100, 100_000),
    maxItems: boundedInteger('DSH_MCP_MAX_ITEMS', env.DSH_MCP_MAX_ITEMS, DEFAULTS.maxItems, 1, 10_000),
    logLevel: logLevel(env.DSH_MCP_LOG_LEVEL),
  };
}
