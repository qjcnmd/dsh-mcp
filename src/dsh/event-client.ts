import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { DshConfig } from '../config.js';
import { DshDomainError, DshProtocolError, DshTransportError } from '../errors.js';
import { DshAuthSession, type FetchLike } from './auth.js';
import type { SessionHistoryRecord } from './rpc-client.js';
import { assertSupportedSession } from './session-scope.js';
import { isRecord } from '../value-guards.js';

export interface DshEvent {
  method: string;
  payload: unknown;
}

export type DshEventListener = (event: DshEvent) => void;

export interface SessionFollowSnapshot {
  type: 'snapshot';
  header: Record<string, unknown>;
  cursor: number;
  records: SessionHistoryRecord[];
  hasMore: boolean;
  projections: { asOfSeq: number; values: Record<string, unknown> };
}

type RemoteFrame =
  | { type: 'item'; streamId: string; value?: unknown }
  | { type: 'end'; streamId: string }
  | { type: 'error'; streamId: string; error: { code: string; message: string; details: Record<string, unknown> } };

function decodeRawData(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function parseFrame(data: RawData): RemoteFrame {
  let value: unknown;
  try {
    value = JSON.parse(decodeRawData(data));
  } catch (error) {
    throw new DshProtocolError('DSH returned invalid Remote stream JSON', { cause: error instanceof Error ? error.message : String(error) });
  }
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.streamId !== 'string' || value.streamId === '') {
    throw new DshProtocolError('DSH returned an invalid Remote stream frame');
  }
  if (value.type === 'end') return { type: 'end', streamId: value.streamId };
  if (value.type === 'item') return { type: 'item', streamId: value.streamId, ...(Object.hasOwn(value, 'value') ? { value: value.value } : {}) };
  if (value.type === 'error' && isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string' && isRecord(value.error.details)) {
    return { type: 'error', streamId: value.streamId, error: { code: value.error.code, message: value.error.message, details: value.error.details } };
  }
  throw new DshProtocolError('DSH returned an invalid Remote stream frame');
}

function isSessionSnapshot(value: unknown): value is SessionFollowSnapshot {
  return isRecord(value)
    && value.type === 'snapshot'
    && isRecord(value.header)
    && typeof value.cursor === 'number'
    && Array.isArray(value.records)
    && typeof value.hasMore === 'boolean'
    && isRecord(value.projections)
    && typeof value.projections.asOfSeq === 'number'
    && isRecord(value.projections.values);
}

export class DshEventClient {
  private readonly auth: DshAuthSession;

  constructor(private readonly config: DshConfig, fetchOrAuth: FetchLike | DshAuthSession = globalThis.fetch) {
    this.auth = fetchOrAuth instanceof DshAuthSession ? fetchOrAuth : new DshAuthSession(config, fetchOrAuth);
  }

  async archivedSessionIds(signal?: AbortSignal): Promise<string[]> {
    const frame = await this.firstFrame('workspace/follow', { args: {} }, 'baseline', signal);
    if (!isRecord(frame) || !isRecord(frame.value) || !Array.isArray(frame.value.archivedSessionIds) || !frame.value.archivedSessionIds.every((id) => typeof id === 'string')) {
      throw new DshProtocolError('DSH returned invalid archived session IDs');
    }
    return frame.value.archivedSessionIds;
  }

  async sessionSnapshot(sessionId: string, maxMessages = 20, signal?: AbortSignal): Promise<SessionFollowSnapshot> {
    const frame = await this.firstFrame('session/follow', { args: { request: { address: { kind: 'session', sessionId }, maxMessages } } }, 'snapshot', signal);
    if (!isSessionSnapshot(frame)) throw new DshProtocolError('DSH returned an invalid session snapshot', { sessionId });
    assertSupportedSession(frame);
    return frame;
  }

  subscribeSession(sessionId: string, listener: DshEventListener, signal?: AbortSignal): () => void {
    const controller = new AbortController();
    const openingTimer = setTimeout(() => fail(new DshTransportError('DSH session observation opening timed out')), this.config.requestTimeoutMs);
    const stop = () => {
      clearTimeout(openingTimer);
      controller.abort();
      signal?.removeEventListener('abort', stop);
    };
    const fail = (error: unknown) => {
      if (controller.signal.aborted) return;
      stop();
      listener({ method: 'stream/error', payload: error });
    };
    void this.runLogicalStream('session/follow', { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 20 } } }, (value) => {
      if (isRecord(value) && value.type === 'snapshot') {
        if (!isSessionSnapshot(value)) throw new DshProtocolError('DSH returned an invalid session snapshot', { sessionId });
        assertSupportedSession(value);
        clearTimeout(openingTimer);
        listener({ method: 'session/snapshot', payload: { sessionId, snapshot: value } });
      } else if (isRecord(value) && value.type === 'event' && isRecord(value.event)) {
        listener({ method: 'session/follow', payload: { sessionId, event: value.event } });
      }
    }, controller.signal).then(() => {
      if (!controller.signal.aborted) fail(new DshTransportError('DSH session observation ended unexpectedly'));
    }, fail);
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    return stop;
  }

  private async firstFrame(endpoint: string, payload: Record<string, unknown>, frameType: 'baseline' | 'snapshot', signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const combined = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]);
    const timer = setTimeout(() => controller.abort(new DshTransportError(`DSH ${endpoint} opening baseline timed out`, null, { endpoint })), this.config.requestTimeoutMs);
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      void this.runLogicalStream(endpoint, payload, (value) => {
        if (settled || !isRecord(value) || value.type !== frameType) return;
        settled = true;
        resolve(value);
        controller.abort();
      }, combined).then(() => {
        if (!settled) reject(combined.aborted ? combined.reason : new DshProtocolError(`DSH ${endpoint} ended before its opening baseline`));
      }, (error: unknown) => {
        if (!settled) reject(error);
      });
    }).finally(() => { clearTimeout(timer); controller.abort(); });
  }

  private async runLogicalStream(endpoint: string, payload: Record<string, unknown>, onItem: (value: unknown) => void, signal: AbortSignal, refreshed = false): Promise<void> {
    signal.throwIfAborted();
    const cookie = await this.auth.cookieHeader(signal);
    signal.throwIfAborted();
    const url = new URL('/api/remote.mux', this.config.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const streamId = crypto.randomUUID();
    const socket = new WebSocket(url, { headers: cookie === undefined ? {} : { cookie } });
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          disposeSocket(socket);
          reject(new DshTransportError('DSH Remote stream connection timed out', null, { endpoint }));
        }, this.config.streamConnectTimeoutMs);
        const opened = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
        const failed = (error: Error) => { if (!settled) { settled = true; cleanup(); reject(new DshTransportError(error.message, null, { endpoint })); } };
        const aborted = () => { if (!settled) { settled = true; cleanup(); disposeSocket(socket); reject(signal.reason ?? new DOMException('Operation aborted', 'AbortError')); } };
        const cleanup = () => {
          clearTimeout(timer);
          socket.off('open', opened);
          socket.off('error', failed);
          signal.removeEventListener('abort', aborted);
        };
        socket.once('open', opened);
        socket.once('error', failed);
        socket.once('unexpected-response', (_request, response) => {
          response.resume();
          if (settled) return;
          settled = true;
          cleanup();
          reject(new DshTransportError('DSH WebSocket authentication failed', response.statusCode ?? null, { endpoint }));
        });
        signal.addEventListener('abort', aborted, { once: true });
      });
      signal.throwIfAborted();
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }));
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          action();
        };
        const onMessage = (data: RawData) => {
          try {
            const frame = parseFrame(data);
            if (frame.streamId !== streamId) return;
            if (frame.type === 'item') { onItem(frame.value); return; }
            if (frame.type === 'end') { finish(resolve); return; }
            finish(() => reject(new DshDomainError(frame.error.code, frame.error.message, { endpoint, ...frame.error.details })));
          } catch (error) {
            finish(() => reject(error));
          }
        };
        const onError = (error: Error) => finish(() => reject(new DshTransportError(error.message, null, { endpoint })));
        const onClose = () => finish(() => signal.aborted ? resolve() : reject(new DshTransportError('DSH Remote stream closed before completion', null, { endpoint })));
        const onAbort = () => finish(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId }));
          resolve();
        });
        const cleanup = () => {
          socket.off('message', onMessage);
          socket.off('error', onError);
          socket.off('close', onClose);
          signal.removeEventListener('abort', onAbort);
        };
        socket.on('message', onMessage);
        socket.once('error', onError);
        socket.once('close', onClose);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    } catch (error) {
      if (!refreshed && error instanceof DshTransportError && error.status === 401) {
        disposeSocket(socket);
        await this.auth.refreshCookie(signal);
        return this.runLogicalStream(endpoint, payload, onItem, signal, true);
      }
      throw error;
    } finally {
      disposeSocket(socket);
    }
  }
}

function disposeSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.once('error', () => undefined); // ws reports the intentional handshake cancellation asynchronously.
    if (socket.readyState === WebSocket.OPEN) socket.close();
    else socket.terminate();
  }
}
