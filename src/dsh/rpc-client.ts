import { DshDomainError, DshProtocolError, DshTransportError, isAbortError, toDshDomainError, type DshRpcErrorBody } from '../errors.js';
import type { DshConfig } from '../config.js';

export interface RpcSuccess<T> {
  ok: true;
  value: T;
}
export interface RpcFailure {
  ok: false;
  error: DshDomainError;
}
export type RpcResult<T> = RpcSuccess<T> | RpcFailure;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SessionListValue { items: Array<Record<string, unknown>>; }
export interface SessionSearchValue { items: Array<{ sessionId: string; snippet: string }>; hasMore: boolean; }
export interface SessionCreateValue { sessionId: string; agentPreset?: string; }
export interface SessionHistoryValue { events: Array<Record<string, unknown>>; hasMore: boolean; projections?: Record<string, unknown>; }
export interface ModelSelection { provider: string; model: string; reasoningEffort?: string; }
export interface SessionModelsValue { current: ModelSelection; routable: boolean; groups: Array<Record<string, unknown>>; failures: Array<Record<string, unknown>>; }
export interface WorkspaceListValue { items: Array<Record<string, unknown>>; archivedSessionIds: string[]; }
export interface WorkspaceCreateValue { workspace: Record<string, unknown>; created: boolean; }

export interface SessionPromptContentPart {
  type: 'text';
  text: string;
}

export interface SessionPromptImagePart {
  type: 'image';
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
  name?: string;
}

export interface SessionPromptPayload {
  sessionId: string;
  mode: 'queue' | 'steer';
  content: Array<SessionPromptContentPart | SessionPromptImagePart>;
  clientTimeZone?: string;
}

export interface DshClientResponse {
  type: 'client-response';
  rpcId: string;
  result: { ok: true; value?: unknown } | { ok: false; error: DshRpcErrorBody };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function signalForTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export class DshRpcClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly config: DshConfig, fetchImpl: FetchLike = globalThis.fetch) {
    this.fetchImpl = fetchImpl;
  }

  async call<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<T>> {
    const rpcId = crypto.randomUUID();
    const body = { type: 'client-request', rpcId, method, payload };
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(`/api/${method}`, this.config.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: signalForTimeout(signal, this.config.requestTimeoutMs),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new DshTransportError(error instanceof Error ? error.message : 'DSH request failed', null, { method });
    }
    if (!response.ok) throw new DshTransportError(`DSH returned HTTP ${response.status}`, response.status, { method });
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch (error) {
      throw new DshProtocolError('DSH returned invalid JSON', { method, cause: error instanceof Error ? error.message : String(error) });
    }
    if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !isRecord(envelope.result) || typeof envelope.result.ok !== 'boolean') {
      throw new DshProtocolError('DSH returned an invalid RPC envelope', { method });
    }
    if (envelope.result.ok === false) {
      const error = envelope.result.error;
      if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') throw new DshProtocolError('DSH returned an invalid domain error', { method });
      return { ok: false, error: toDshDomainError({ code: error.code, message: error.message, details: isRecord(error.details) ? error.details : {} }) };
    }
    return { ok: true, value: envelope.result.value as T };
  }

  session = {
    list: (payload: { cursor?: string } = {}, signal?: AbortSignal) => this.call<SessionListValue>('session.list', payload, signal),
    search: (payload: { query: string }, signal?: AbortSignal) => this.call<SessionSearchValue>('session.search', payload, signal),
    create: (payload: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string }, signal?: AbortSignal) => this.call<SessionCreateValue>('session.create', payload, signal),
    history: (payload: { sessionId: string; beforeSeq?: number; maxMessages?: number }, signal?: AbortSignal) => this.call<SessionHistoryValue>('session.history', payload, signal),
    models: (payload: { sessionId: string }, signal?: AbortSignal) => this.call<SessionModelsValue>('session.models', payload, signal),
    selectModel: (payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string }, signal?: AbortSignal) => this.call<{ selected: ModelSelection }>('session.selectModel', payload, signal),
    rename: (payload: { sessionId: string; title: string }, signal?: AbortSignal) => this.call<{ title: string; seq: number }>('session.rename', payload, signal),
    fork: (payload: { sessionId: string; atSeq?: number }, signal?: AbortSignal) => this.call<{ sessionId: string }>('session.fork', payload, signal),
    prompt: (payload: SessionPromptPayload, signal?: AbortSignal) => this.call<{ accepted: true; command?: { kind: 'success'; text?: string } }>('session.prompt', payload, signal),
    updateQueue: (payload: { sessionId: string; itemId: string; action: Record<string, unknown> }, signal?: AbortSignal) => this.call<{ accepted: true }>('session.updateQueue', payload, signal),
    cancel: (payload: { sessionId: string }, signal?: AbortSignal) => this.call<{ accepted: true }>('session.cancel', payload, signal),
  };

  workspace = {
    list: (payload: Record<string, never> = {}, signal?: AbortSignal) => this.call<WorkspaceListValue>('workspace.list', payload, signal),
    create: (payload: { path: string }, signal?: AbortSignal) => this.call<WorkspaceCreateValue>('workspace.create', payload, signal),
    rename: (payload: { workspaceId: string; title: string }, signal?: AbortSignal) => this.call<{ workspace: Record<string, unknown> }>('workspace.rename', payload, signal),
    delete: (payload: { workspaceId: string }, signal?: AbortSignal) => this.call<{ deleted: true }>('workspace.delete', payload, signal),
    insertBefore: (payload: { workspaceId: string; beforeWorkspaceId?: string }, signal?: AbortSignal) => this.call<{ workspaceIds: string[] }>('workspace.insertBefore', payload, signal),
    insertSessionBefore: (payload: { workspaceId: string; sessionId: string; beforeSessionId?: string }, signal?: AbortSignal) => this.call<{ sessionIds: string[] }>('workspace.insertSessionBefore', payload, signal),
    archiveSession: (payload: { workspaceId: string; sessionId: string }, signal?: AbortSignal) => this.call<Record<string, unknown>>('workspace.archiveSession', payload, signal),
  };

  host = {
    describe: (payload: Record<string, unknown> = {}, signal?: AbortSignal) => this.call<Record<string, unknown>>('host.describe', payload, signal),
    listDirectory: (payload: Record<string, unknown>, signal?: AbortSignal) => this.call<Record<string, unknown>>('host.listDirectory', payload, signal),
    openPath: (payload: Record<string, unknown>, signal?: AbortSignal) => this.call<Record<string, unknown>>('host.openPath', payload, signal),
  };

  goals = {
    create: (payload: Record<string, unknown>, signal?: AbortSignal) => this.call<Record<string, unknown>>('goal.create', payload, signal),
    edit: (payload: Record<string, unknown>, signal?: AbortSignal) => this.call<Record<string, unknown>>('goal.edit', payload, signal),
    pause: (payload: Record<string, unknown>, signal?: AbortSignal) => this.call<Record<string, unknown>>('goal.pause', payload, signal),
    resume: (payload: Record<string, unknown>, signal?: AbortSignal) => this.call<Record<string, unknown>>('goal.resume', payload, signal),
    complete: (payload: Record<string, unknown>, signal?: AbortSignal) => this.call<Record<string, unknown>>('goal.complete', payload, signal),
    clear: (payload: Record<string, unknown>, signal?: AbortSignal) => this.call<Record<string, unknown>>('goal.clear', payload, signal),
  };

  async respond(message: DshClientResponse, signal?: AbortSignal): Promise<{ accepted: boolean; reason?: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL('/api/respond', this.config.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(message),
        signal: signalForTimeout(signal, this.config.requestTimeoutMs),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new DshTransportError(error instanceof Error ? error.message : 'DSH response failed', null, { endpoint: '/api/respond' });
    }
    if (!response.ok) throw new DshTransportError(`DSH returned HTTP ${response.status}`, response.status, { endpoint: '/api/respond' });
    const value: unknown = await response.json().catch(() => undefined);
    if (!isRecord(value) || typeof value.accepted !== 'boolean') throw new DshProtocolError('DSH returned an invalid response receipt');
    return { accepted: value.accepted, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) };
  }
}
