import type { DshConfig } from '../config.js';
import { DshDomainError, DshProtocolError, DshTransportError, isAbortError, toDshDomainError } from '../errors.js';
import { DshAuthSession, type FetchLike } from './auth.js';

export interface RpcSuccess<T> { ok: true; value: T; }
export interface RpcFailure { ok: false; error: DshDomainError; }
export type RpcResult<T> = RpcSuccess<T> | RpcFailure;

export interface SessionListValue { items: Array<Record<string, unknown>>; }
export interface SessionCreateValue { sessionId: string; agentPreset?: string; }
export interface SessionHistoryRecord { type: 'event' | 'chunks'; event: Record<string, unknown>; }
export interface SessionPageValue { records: SessionHistoryRecord[]; hasMore: boolean; }
export interface ModelSelection { provider: string; model: string; reasoningEffort?: string; }
export interface SessionModelsValue {
  default: ModelSelection;
  routableProviders: string[];
  groups: Array<Record<string, unknown>>;
  failures: Array<Record<string, unknown>>;
}
export interface WorkspaceArchiveValue { archivedSessionIds: string[]; }
export interface CommandExecution {
  commandId: string;
  result:
    | { kind: 'success'; text?: string; sourceEventSeq?: number }
    | { kind: 'error'; text: string };
}

export type SessionPromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string };

export interface SessionPromptPayload {
  requestId: string;
  sessionId: string;
  mode: 'queue' | 'steer';
  content: SessionPromptPart[];
  clientTimeZone?: string;
}

export interface RemoteEventResult {
  clientId: string;
  eventId: string;
  outcome:
    | { kind: 'next' }
    | { kind: 'result'; value?: unknown }
    | { kind: 'rejected'; error: { name: string; message: string; code?: string; details?: unknown } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export class DshRpcClient {
  private readonly auth: DshAuthSession;

  constructor(private readonly config: DshConfig, fetchOrAuth: FetchLike | DshAuthSession = globalThis.fetch) {
    this.auth = fetchOrAuth instanceof DshAuthSession ? fetchOrAuth : new DshAuthSession(config, fetchOrAuth);
  }

  async callWithId<T>(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ rpcId: string; result: RpcResult<T> }> {
    const rpcId = crypto.randomUUID();
    const body = { type: 'client-request', rpcId, method: endpoint, payload: { args } };
    let response: Response;
    try {
      response = await this.auth.fetch(new URL(`/api/${endpoint}`, this.config.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: withTimeout(signal, this.config.requestTimeoutMs),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new DshTransportError(error instanceof Error ? error.message : 'DSH request failed', null, { endpoint });
    }
    if (!response.ok) {
      const message = response.status === 401
        ? 'DSH authentication is required; configure DSH_AUTH_TOKEN or include the launch token in DSH_BASE_URL'
        : `DSH returned HTTP ${response.status}`;
      throw new DshTransportError(message, response.status, { endpoint });
    }
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch (error) {
      throw new DshProtocolError('DSH returned invalid JSON', { endpoint, cause: error instanceof Error ? error.message : String(error) });
    }
    if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !isRecord(envelope.result) || typeof envelope.result.ok !== 'boolean') {
      throw new DshProtocolError('DSH returned an invalid RPC envelope', { endpoint });
    }
    if (envelope.result.ok === false) {
      const error = envelope.result.error;
      if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
        throw new DshProtocolError('DSH returned an invalid domain error', { endpoint });
      }
      return {
        rpcId,
        result: {
          ok: false,
          error: toDshDomainError({ code: error.code, message: error.message, details: isRecord(error.details) ? error.details : {} }),
        },
      };
    }
    return { rpcId, result: { ok: true, value: envelope.result.value as T } };
  }

  async call<T>(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<RpcResult<T>> {
    return (await this.callWithId<T>(endpoint, args, signal)).result;
  }

  session = {
    list: (request: { cursor?: string } = {}, signal?: AbortSignal) => this.call<SessionListValue>('session/list', { _request: request }, signal),
    create: (request: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string }, signal?: AbortSignal) => this.call<SessionCreateValue>('session/create', { request }, signal),
    page: (request: { sessionId: string; throughSeq: number; beforeSeq?: number; maxMessages?: number }, signal?: AbortSignal) => this.call<SessionPageValue>('session/page', {
      request: {
        address: { kind: 'session', sessionId: request.sessionId },
        throughSeq: request.throughSeq,
        ...(request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq }),
        ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
      },
    }, signal),
    modelCatalog: (signal?: AbortSignal) => this.call<SessionModelsValue>('session/modelCatalog', {}, signal),
    selectModel: (request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }, signal?: AbortSignal) => this.call<{ selected: ModelSelection }>('session/selectModel', { request }, signal),
    promptWithId: (request: SessionPromptPayload, signal?: AbortSignal) => this.callWithId<{ accepted: true }>('session/prompt', { request }, signal),
    cancel: (request: { sessionId: string }, signal?: AbortSignal) => this.call<{ accepted: true }>('session/cancel', { request }, signal),
  };

  workspace = {
    archiveSession: (request: { sessionId: string }, signal?: AbortSignal) => this.call<WorkspaceArchiveValue>('workspace/archiveSession', { request }, signal),
  };

  agentPresets = {
    select: (request: { sessionId: string; agentPreset: string }, signal?: AbortSignal) => this.call<string>('agentPresets/select', { agentId: request.sessionId, agentPreset: request.agentPreset }, signal),
  };

  commands = {
    execute: (request: { sessionId: string; line: string }, signal?: AbortSignal) => this.call<CommandExecution | undefined>('commands/execute', {
      agentId: request.sessionId,
      line: request.line,
      images: [],
    }, signal),
  };

  remoteEvents = {
    result: (result: RemoteEventResult, signal?: AbortSignal) => this.call<undefined>('$events/result', result as unknown as Record<string, unknown>, signal),
  };
}
