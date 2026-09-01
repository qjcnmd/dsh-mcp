import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { DshConfig } from '../config.js';
import { DshTransportError, isAbortError } from '../errors.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Keeps the authority-bound DSH browser cookie in memory for HTTP and WebSocket calls. */
export class DshAuthSession {
  private cookie: string | undefined;
  private exchange: Promise<string> | undefined;
  private discoveredToken: string | undefined;
  private readonly discoverLauncherAuth: boolean;

  constructor(private readonly config: DshConfig, private readonly fetchImpl: FetchLike = globalThis.fetch) {
    this.discoverLauncherAuth = fetchImpl === globalThis.fetch;
  }

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookie = await this.cookieHeader(init.signal ?? undefined);
    if (cookie !== undefined) headers.set('cookie', cookie);
    let response = await this.fetchImpl(input, { ...init, headers });
    if (response.status !== 401) return response;
    this.cookie = undefined;
    this.discoveredToken = undefined;
    const refreshed = await this.cookieHeader(init.signal ?? undefined);
    if (refreshed === undefined) return response;
    const retryHeaders = new Headers(init.headers);
    retryHeaders.set('cookie', refreshed);
    response = await this.fetchImpl(input, { ...init, headers: retryHeaders });
    return response;
  }

  async cookieHeader(signal?: AbortSignal): Promise<string | undefined> {
    if (this.cookie !== undefined) return this.cookie;
    const token = this.config.authToken ?? this.discoveredToken ?? (this.discoverLauncherAuth ? await discoverLauncherToken(this.config) : undefined);
    if (token === undefined) return undefined;
    if (this.config.authToken === undefined) this.discoveredToken = token;
    this.exchange ??= this.exchangeToken(token, signal).finally(() => { this.exchange = undefined; });
    return this.exchange;
  }

  private async exchangeToken(token: string, signal?: AbortSignal): Promise<string> {
    const url = new URL('/', this.config.baseUrl);
    url.searchParams.set('token', token);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { method: 'GET', redirect: 'manual', ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new DshTransportError(error instanceof Error ? error.message : 'DSH authentication failed', null, { endpoint: '/' });
    }
    const setCookie = response.headers.get('set-cookie');
    if (response.status !== 303 || setCookie === null) {
      throw new DshTransportError('DSH authentication token was rejected', response.status, { endpoint: '/' });
    }
    const cookie = setCookie.split(';', 1)[0]?.trim();
    if (cookie === undefined || cookie === '' || !cookie.includes('=')) {
      throw new DshTransportError('DSH returned an invalid authentication cookie', response.status, { endpoint: '/' });
    }
    this.cookie = cookie;
    return cookie;
  }
}

const LAUNCHER_LOG_TAIL_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

async function discoverLauncherToken(config: DshConfig): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData === '') return undefined;
  const path = join(localAppData, 'DeepSeekHarnessLauncher', 'dsh-web.log');
  let file;
  try {
    file = await open(path, 'r');
    const { size } = await file.stat();
    const length = Math.min(size, LAUNCHER_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return latestTokenForOrigin(buffer.toString('utf8'), config.baseUrl.origin);
  } catch (error) {
    if (isRecordWithCode(error) && error.code === 'ENOENT') return undefined;
    return undefined;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function latestTokenForOrigin(logTail: string, origin: string): string | undefined {
  const lines = logTail.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const rawUrl = lines[index]?.startsWith('dsh web: ') === true ? lines[index]!.slice('dsh web: '.length).split(/\s/, 1)[0] : undefined;
    if (rawUrl === undefined) continue;
    try {
      const url = new URL(rawUrl);
      const tokens = url.searchParams.getAll('token');
      if (url.origin === origin && url.pathname === '/' && url.hash === '' && tokens.length === 1 && TOKEN_PATTERN.test(tokens[0]!)) return tokens[0];
    } catch {
      continue;
    }
  }
  return undefined;
}

function isRecordWithCode(value: unknown): value is { code: string } {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string';
}
