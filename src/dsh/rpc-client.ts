import type { DshConfig } from '../config.js';
import { DshDomainError, DshMcpError, DshProtocolError, DshTransportError } from '../errors.js';
import { DshAuthSession, type FetchLike } from './auth.js';
import { isRecord } from '../value-guards.js';

export interface RpcSuccess<T> { ok: true; value: T; }
export interface RpcFailure { ok: false; error: DshDomainError; }
export type RpcResult<T> = RpcSuccess<T> | RpcFailure;

export interface DshSessionSummary {
  sessionId: string;
  parentSessionId?: string;
  origin?: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  projections?: { asOfSeq: number; values: Record<string, unknown> };
}
export interface SessionListValue { items: DshSessionSummary[]; }
export interface SessionCreateValue { sessionId: string; agentPreset?: string; }
export interface WorkspaceView { workspaceId: string; path: string; title: string; sessionIds: string[]; }
export interface WorkspaceBaseline { items: WorkspaceView[]; archivedSessionIds: string[]; }
export interface SessionHistoryRecord { type: 'event'; event: Record<string, unknown>; }
export interface SessionPageValue { records: SessionHistoryRecord[]; hasMore: boolean; }
export interface ModelSelection { provider: string; model: string; reasoningEffort?: string; }
export interface SessionModelsValue {
  default: ModelSelection;
  routableProviders: string[];
  groups: Array<Record<string, unknown>>;
  failures: Array<{ id: string; name: string; message: string }>;
}
export interface CommandExecution {
  result: { kind: 'success'; text?: string } | { kind: 'error'; text: string };
}

export interface SessionPromptPayload {
  requestId: string;
  sessionId: string;
  content: Array<{ type: 'text'; text: string }>;
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

  async call<T>(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<RpcResult<T>> {
    const rpcId = crypto.randomUUID();
    const body = { type: 'client-request', rpcId, method: endpoint, payload: { args } };
    const requestSignal = withTimeout(signal, this.config.requestTimeoutMs);
    let envelope: unknown;
    try {
      const response = await this.auth.fetch(new URL(`/api/${endpoint}`, this.config.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: requestSignal,
      });
      if (!response.ok) {
        const message = response.status === 401
          ? 'DSH authentication is required; configure DSH_AUTH_TOKEN or include the launch token in DSH_BASE_URL'
          : `DSH returned HTTP ${response.status}`;
        throw new DshTransportError(message, response.status, { endpoint });
      }
      try {
        envelope = await response.json();
      } catch (error) {
        if (error instanceof SyntaxError) throw new DshProtocolError('DSH returned invalid JSON', { endpoint, cause: error.message });
        throw error;
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (requestSignal.aborted) throw new DshTransportError('DSH request timed out', null, { endpoint });
      if (error instanceof DshMcpError) throw error;
      throw new DshTransportError(error instanceof Error ? error.message : 'DSH request failed', null, { endpoint });
    }
    if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !isRecord(envelope.result) || typeof envelope.result.ok !== 'boolean') {
      throw new DshProtocolError('DSH returned an invalid RPC envelope', { endpoint });
    }
    if (envelope.result.ok === false) {
      const error = envelope.result.error;
      if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
        throw new DshProtocolError('DSH returned an invalid domain error', { endpoint });
      }
      return { ok: false, error: new DshDomainError(error.code, error.message, isRecord(error.details) ? error.details : {}) };
    }
    return { ok: true, value: envelope.result.value as T };
  }

  session = {
    list: (signal?: AbortSignal) => this.call<SessionListValue>('session/list', { _request: {} }, signal),
    create: (request: { workspaceId: string; sessionId?: string; agentPreset: 'minimal' }, signal?: AbortSignal) => this.call<SessionCreateValue>('session/create', { request }, signal),
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
    prompt: (request: SessionPromptPayload, signal?: AbortSignal) => this.call<{ accepted: true }>('session/prompt', { request: { ...request, mode: 'steer' } }, signal),
    cancel: (request: { sessionId: string }, signal?: AbortSignal) => this.call<{ accepted: true }>('session/cancel', { request }, signal),
  };

  workspace = {
    create: (path: string, signal?: AbortSignal) => this.call<{ workspace: WorkspaceView; created: boolean }>('workspace/create', { request: { path } }, signal),
  };

  async setFullAccess(sessionId: string, signal?: AbortSignal): Promise<void> {
    const result = await this.call<CommandExecution>('commands/execute', {
      agentId: sessionId, line: '/permission danger-full-access', submittedAttachments: [],
    }, signal);
    if (!result.ok) throw result.error;
    if (result.value.result.kind === 'error') throw new DshDomainError('permission-configuration-failed', result.value.result.text, { sessionId });
  }

}
