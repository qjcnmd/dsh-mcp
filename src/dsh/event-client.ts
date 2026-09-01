import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { DshConfig } from '../config.js';
import { DshDomainError, DshProtocolError, DshTransportError } from '../errors.js';
import { DshAuthSession, type FetchLike } from './auth.js';
import { DshRpcClient, type RpcResult, type SessionHistoryRecord } from './rpc-client.js';

export type DshEventStream = 'mux' | 'host';

export interface DshEvent {
  stream: DshEventStream;
  rpcId: string;
  method: string;
  payload: unknown;
  order: number;
  receivedAt: string;
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

export interface WorkspaceBaseline {
  items: Array<Record<string, unknown>>;
  archivedSessionIds: string[];
}

type RemoteFrame =
  | { type: 'item'; streamId: string; value?: unknown }
  | { type: 'end'; streamId: string }
  | { type: 'error'; streamId: string; error: { code: string; message: string; details: Record<string, unknown> } };

interface RemoteInteractionRef {
  clientId: string;
  eventId: string;
  sessionId: string;
  event: 'approval/request' | 'user-questions/request';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  private readonly rpc: DshRpcClient;
  private readonly listeners = new Set<DshEventListener>();
  private readonly streamControllers = new Set<AbortController>();
  private readonly remoteSessionRefs = new Map<string, number>();
  private readonly remoteInteractions = new Map<string, RemoteInteractionRef>();
  private remoteController: AbortController | undefined;
  private remoteClientId: string | undefined;
  private order = 0;

  constructor(private readonly config: DshConfig, fetchOrAuth: FetchLike | DshAuthSession = globalThis.fetch) {
    this.auth = fetchOrAuth instanceof DshAuthSession ? fetchOrAuth : new DshAuthSession(config, fetchOrAuth);
    this.rpc = new DshRpcClient(config, this.auth);
  }

  async workspaceSnapshot(signal?: AbortSignal): Promise<WorkspaceBaseline> {
    const frame = await this.firstFrame('workspace/follow', { args: {} }, (value) => isRecord(value) && value.type === 'baseline', signal);
    if (!isRecord(frame) || !isRecord(frame.value) || !Array.isArray(frame.value.items) || !Array.isArray(frame.value.archivedSessionIds)) {
      throw new DshProtocolError('DSH returned an invalid workspace baseline');
    }
    return {
      items: frame.value.items.filter(isRecord),
      archivedSessionIds: frame.value.archivedSessionIds.filter((value): value is string => typeof value === 'string'),
    };
  }

  async sessionSnapshot(sessionId: string, maxMessages = 20, signal?: AbortSignal): Promise<SessionFollowSnapshot> {
    const frame = await this.firstFrame('session/follow', { args: { request: { address: { kind: 'session', sessionId }, maxMessages } } }, isSessionSnapshot, signal);
    if (!isSessionSnapshot(frame)) throw new DshProtocolError('DSH returned an invalid session snapshot', { sessionId });
    return frame;
  }

  subscribeSession(sessionId: string, listener: DshEventListener, signal?: AbortSignal): () => void {
    const controller = new AbortController();
    this.streamControllers.add(controller);
    const forward: DshEventListener = (event) => {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      if (payload?.sessionId === sessionId) listener(event);
    };
    this.listeners.add(forward);
    this.retainRemoteEvents(sessionId);
    void this.runLogicalStream(
      'session/follow',
      { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 20 } } },
      (value) => this.emitSessionFollow(value, sessionId),
      controller.signal,
    ).catch((error) => {
      if (!controller.signal.aborted) this.emitStreamError('mux', 'session/follow', error, sessionId);
    });

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      this.streamControllers.delete(controller);
      this.listeners.delete(forward);
      this.releaseRemoteEvents(sessionId);
    };
    if (signal !== undefined) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
    return stop;
  }

  async respondRemoteInteraction(eventId: string, value: unknown, signal?: AbortSignal): Promise<RpcResult<undefined>> {
    const ref = this.remoteInteractions.get(eventId);
    if (ref === undefined) {
      return { ok: false, error: new DshDomainError('pending-interaction-not-found', 'The pending interaction is no longer available.', { eventId }) };
    }
    const result = await this.rpc.remoteEvents.result({ clientId: ref.clientId, eventId: ref.eventId, outcome: { kind: 'result', value } }, signal);
    if (result.ok) {
      this.remoteInteractions.delete(eventId);
      this.maybeStopRemoteEvents();
    }
    return result;
  }

  async stop(): Promise<void> {
    for (const controller of [...this.streamControllers]) controller.abort();
    this.streamControllers.clear();
    this.remoteController?.abort();
    this.remoteController = undefined;
    this.remoteClientId = undefined;
    this.remoteSessionRefs.clear();
    this.remoteInteractions.clear();
    this.listeners.clear();
  }

  private async firstFrame(endpoint: string, payload: Record<string, unknown>, accepts: (value: unknown) => boolean, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const combined = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]);
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      void this.runLogicalStream(endpoint, payload, (value) => {
        if (settled || !accepts(value)) return;
        settled = true;
        resolve(value);
        controller.abort();
      }, combined).then(() => {
        if (!settled) reject(new DshProtocolError(`DSH ${endpoint} ended before its opening baseline`));
      }, (error: unknown) => {
        if (!settled) reject(error);
      });
    });
  }

  private retainRemoteEvents(sessionId: string): void {
    this.remoteSessionRefs.set(sessionId, (this.remoteSessionRefs.get(sessionId) ?? 0) + 1);
    if (this.remoteController !== undefined) return;
    const controller = new AbortController();
    this.remoteController = controller;
    void this.runLogicalStream('$events', { args: {} }, (value) => this.handleRemoteEvent(value), controller.signal).catch((error) => {
      if (!controller.signal.aborted) this.emitStreamError('host', '$events', error);
    }).finally(() => {
      if (this.remoteController === controller) {
        this.remoteController = undefined;
        this.remoteClientId = undefined;
      }
    });
  }

  private releaseRemoteEvents(sessionId: string): void {
    const count = this.remoteSessionRefs.get(sessionId) ?? 0;
    if (count <= 1) this.remoteSessionRefs.delete(sessionId);
    else this.remoteSessionRefs.set(sessionId, count - 1);
    this.maybeStopRemoteEvents();
  }

  private maybeStopRemoteEvents(): void {
    if (this.remoteSessionRefs.size !== 0 || this.remoteInteractions.size !== 0) return;
    this.remoteController?.abort();
    this.remoteController = undefined;
  }

  private handleRemoteEvent(value: unknown): void {
    if (!isRecord(value)) return;
    if (value.type === 'ready' && typeof value.clientId === 'string') {
      this.remoteClientId = value.clientId;
      return;
    }
    if (value.type === 'cancel' && typeof value.eventId === 'string') {
      const ref = this.remoteInteractions.get(value.eventId);
      this.remoteInteractions.delete(value.eventId);
      if (ref !== undefined) this.emit({ stream: 'host', rpcId: value.eventId, method: 'remote/cancel', payload: { sessionId: ref.sessionId }, order: this.nextOrder(), receivedAt: new Date().toISOString() });
      this.maybeStopRemoteEvents();
      return;
    }
    if (value.type !== 'waterfall'
      || typeof value.eventId !== 'string'
      || typeof value.agentId !== 'string'
      || (value.event !== 'approval/request' && value.event !== 'user-questions/request')
      || !isRecord(value.request)) return;
    const clientId = this.remoteClientId;
    if (clientId === undefined) return;
    const ref: RemoteInteractionRef = { clientId, eventId: value.eventId, sessionId: value.agentId, event: value.event };
    if (!this.remoteSessionRefs.has(ref.sessionId)) {
      void this.rpc.remoteEvents.result({ clientId: ref.clientId, eventId: ref.eventId, outcome: { kind: 'next' } }).catch(() => undefined);
      return;
    }
    this.remoteInteractions.set(ref.eventId, ref);
    this.emit({
      stream: 'host',
      rpcId: ref.eventId,
      method: ref.event,
      payload: { type: 'remote/invocation', sessionId: ref.sessionId, clientId: ref.clientId, eventId: ref.eventId, request: value.request },
      order: this.nextOrder(),
      receivedAt: new Date().toISOString(),
    });
  }

  private emitSessionFollow(value: unknown, sessionId: string): void {
    if (isSessionSnapshot(value)) {
      for (const record of value.records) this.emitHistoryRecord(record, sessionId);
      this.emit({ stream: 'mux', rpcId: '', method: 'session/snapshot', payload: { ...value, sessionId }, order: this.nextOrder(), receivedAt: new Date().toISOString() });
      return;
    }
    this.emitHistoryRecord(value, sessionId);
  }

  private emitHistoryRecord(value: unknown, sessionId: string): void {
    if (!isRecord(value) || value.type !== 'event' || !isRecord(value.event)) return;
    this.emit({ stream: 'mux', rpcId: '', method: 'session/follow', payload: { type: 'session/event', sessionId, event: value.event }, order: this.nextOrder(), receivedAt: new Date().toISOString() });
  }

  private emitStreamError(stream: DshEventStream, endpoint: string, error: unknown, sessionId?: string): void {
    this.emit({
      stream,
      rpcId: '',
      method: 'stream/error',
      payload: { endpoint, ...(sessionId === undefined ? {} : { sessionId }), message: error instanceof Error ? error.message : String(error) },
      order: this.nextOrder(),
      receivedAt: new Date().toISOString(),
    });
  }

  private emit(event: DshEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private nextOrder(): number {
    return ++this.order;
  }

  private async runLogicalStream(endpoint: string, payload: Record<string, unknown>, onItem: (value: unknown) => void, signal: AbortSignal): Promise<void> {
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
          socket.terminate();
          reject(new DshTransportError('DSH Remote stream connection timed out', null, { endpoint }));
        }, this.config.streamConnectTimeoutMs);
        const opened = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
        const failed = (error: Error) => { if (!settled) { settled = true; cleanup(); reject(new DshTransportError(error.message, null, { endpoint })); } };
        const aborted = () => { if (!settled) { settled = true; cleanup(); socket.terminate(); reject(signal.reason ?? new DOMException('Operation aborted', 'AbortError')); } };
        const cleanup = () => {
          clearTimeout(timer);
          socket.off('open', opened);
          socket.off('error', failed);
          signal.removeEventListener('abort', aborted);
        };
        socket.once('open', opened);
        socket.once('error', failed);
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
            finish(() => reject(new DshTransportError(`DSH Remote stream ${frame.error.code}: ${frame.error.message}`, null, { endpoint, details: frame.error.details })));
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
    } finally {
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    }
  }
}
