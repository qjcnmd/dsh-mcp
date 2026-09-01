export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface DshConfig {
  baseUrl: URL;
  authToken?: string | undefined;
  requestTimeoutMs: number;
  streamConnectTimeoutMs: number;
  logLevel: LogLevel;
}

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:3080/',
  requestTimeoutMs: 30_000,
  streamConnectTimeoutMs: 10_000,
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
  const configuredUrl = new URL(rawBaseUrl);
  const urlToken = configuredUrl.searchParams.get('token')?.trim();
  const envToken = env.DSH_AUTH_TOKEN?.trim();
  if (urlToken !== undefined && urlToken !== '' && envToken !== undefined && envToken !== '' && urlToken !== envToken) {
    throw new Error('DSH_AUTH_TOKEN conflicts with the token in DSH_BASE_URL');
  }
  if (configuredUrl.username !== '' || configuredUrl.password !== '') throw new Error('DSH_BASE_URL must not contain user info');
  const baseUrl = new URL('/', configuredUrl);
  baseUrl.search = '';
  baseUrl.hash = '';
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new Error('DSH_BASE_URL must use http or https');
  }
  return {
    baseUrl: new URL(baseUrl.toString().endsWith('/') ? baseUrl.toString() : `${baseUrl.toString()}/`),
    ...((envToken ?? urlToken) === undefined || (envToken ?? urlToken) === '' ? {} : { authToken: envToken ?? urlToken }),
    requestTimeoutMs: boundedInteger('DSH_REQUEST_TIMEOUT_MS', env.DSH_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs, 100, 300_000),
    streamConnectTimeoutMs: boundedInteger('DSH_STREAM_CONNECT_TIMEOUT_MS', env.DSH_STREAM_CONNECT_TIMEOUT_MS, DEFAULTS.streamConnectTimeoutMs, 100, 120_000),
    logLevel: logLevel(env.DSH_MCP_LOG_LEVEL),
  };
}
