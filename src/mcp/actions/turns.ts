import { z } from 'zod';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import type { DshEvent } from '../../dsh/event-client.js';
import type { SessionPromptPart } from '../../dsh/rpc-client.js';
import type { PendingQuestion } from '../../domain/pending-interactions.js';
import { classifyHistoryTurn } from '../../dsh/recovery.js';
import { isTerminalState, type TurnRecord, type TurnState } from '../../domain/turns.js';
import type { ActionRuntime } from './common.js';
import { projectToolResult, registerAction, requestSignal } from './common.js';

const sessionId = z.string().trim().min(1);
const turnRef = z.string().trim().min(1);

const contentPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1) }),
  z.object({ type: z.literal('image'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), data: z.string().min(1), name: z.string().trim().min(1).optional() }),
]);

export function registerTurnActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.send_message', { description: 'Submit text or admitted image content to one explicit session and return immediately with a stable turnRef.', inputSchema: z.object({ sessionId, message: z.string().min(1).optional(), content: z.array(contentPart).min(1).optional(), mode: z.enum(['send', 'queue', 'steer']).default('send'), clientTimeZone: z.string().trim().min(1).optional() }).refine((value) => value.message !== undefined || value.content !== undefined, 'message or content is required').refine((value) => value.message === undefined || value.content === undefined, 'message and content are mutually exclusive') }, async (args, ctx) => {
    return submitTurn(runtime, {
      sessionId: args.sessionId,
      content: normalizeContent(args.content, args.message),
      mode: args.mode,
      ...(args.clientTimeZone === undefined ? {} : { clientTimeZone: args.clientTimeZone }),
    }, requestSignal(ctx));
  });

  registerAction(server, 'dsh.session.wait_turn', { description: 'Wait for one explicit turnRef using DSH events and recovery evidence; no periodic status polling is performed.', inputSchema: z.object({ turnRef, timeoutMs: z.number().int().positive().max(300_000).optional() }) }, (args, ctx) => waitForTurn(runtime, args.turnRef, args.timeoutMs ?? 300_000, requestSignal(ctx)));
}

export async function waitForTurn(runtime: ActionRuntime, ref: string, timeoutMs: number, signal: AbortSignal): Promise<CallToolResult> {
  const existing = runtime.turns.get(ref);
  if (existing === undefined) return projectToolResult({ turnRef: ref, state: 'unknown', waitOutcome: 'unknown', reason: 'unknown turnRef', finalAnswer: null, pendingInteraction: null, evidence: 'incomplete' });
  if (isTerminalState(existing.state) || existing.state === 'pending-human-input') return projectToolResult(turnResult(runtime, existing, existing.state === 'pending-human-input' ? 'pending-human-input' : 'terminal'));
  return new Promise<CallToolResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = (): void => undefined;
    const finish = (value: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      resolve(projectToolResult(value));
    };
    timer = setTimeout(() => finish({ ...turnResult(runtime, runtime.turns.get(ref) ?? existing, 'timed-out'), waitOutcome: 'timed-out', evidence: 'incomplete' }), timeoutMs);
    unsubscribe = runtime.events.subscribeSession(existing.sessionId, (event) => {
      observeEvent(runtime, event);
      if (event.method === 'stream/error') {
        if (event.stream === 'mux') void recoverAfterDisconnect(runtime, ref, existing, signal).then((recovered) => {
          if (recovered !== null) finish(recovered);
          else finish({ ...turnResult(runtime, runtime.turns.get(ref) ?? existing, 'terminal'), state: 'transport-lost', waitOutcome: 'transport-lost', evidence: 'incomplete' });
        });
        return;
      }
      const current = runtime.turns.get(ref);
      if (current === undefined) return;
      if (isTerminalState(current.state)) finish(turnResult(runtime, current, 'terminal'));
      else if (current.state === 'pending-human-input') finish(turnResult(runtime, current, 'pending-human-input'));
    }, signal);
    if (signal.aborted) { unsubscribe(); if (timer !== undefined) clearTimeout(timer); reject(signal.reason ?? new DOMException('Operation aborted', 'AbortError')); }
    else signal.addEventListener('abort', () => { unsubscribe(); if (timer !== undefined) clearTimeout(timer); reject(signal.reason ?? new DOMException('Operation aborted', 'AbortError')); }, { once: true });
  });
}

async function submitTurn(runtime: ActionRuntime, input: { sessionId: string; content: SessionPromptPart[]; mode: 'send' | 'queue' | 'steer'; clientTimeZone?: string }, signal: AbortSignal): Promise<CallToolResult> {
  const requestId = crypto.randomUUID();
  const pending = runtime.turns.register({ sessionId: input.sessionId, sourceRef: `rpc:${requestId}` });
  const response = await runtime.rpc.session.promptWithId({
    requestId,
    sessionId: input.sessionId,
    mode: input.mode === 'steer' ? 'steer' : 'queue',
    content: input.content,
    ...(input.clientTimeZone === undefined ? {} : { clientTimeZone: input.clientTimeZone }),
  }, signal);
  if (!response.result.ok) {
    runtime.turns.reject(pending.turnRef, response.result.error.message);
    return projectToolResult({ target: { sessionId: input.sessionId }, accepted: false, effect: 'rejected', error: { code: response.result.error.dshCode, message: response.result.error.message } });
  }
  return projectToolResult({
    target: { sessionId: input.sessionId },
    accepted: true,
    effect: input.mode === 'steer' ? 'changed' : input.mode === 'queue' ? 'queued' : 'applied',
    turnRef: pending.turnRef,
    state: pending.state,
    reason: null,
  });
}

export function observeEvent(runtime: ActionRuntime, event: DshEvent): void {
  const frame = unwrapEvent(event.payload);
  if (!isRecord(frame)) return;
  const frameSessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined;
  const request = isRecord(frame.request) ? frame.request : undefined;
  if (event.method === 'approval/request' && frameSessionId !== undefined && request !== undefined) {
    const toolName = typeof request.toolName === 'string' ? request.toolName : 'tool';
    const reason = typeof request.reason === 'string' ? `${toolName}: ${request.reason}` : `DSH requests approval for ${toolName}`;
    const turn = findTurnForSession(runtime, frameSessionId);
    runtime.pending.upsert({ pendingInteractionId: event.rpcId, sessionId: frameSessionId, turnRef: turn?.turnRef ?? null, kind: 'approval', prompt: reason, options: [{ label: 'allowed-once' }, { label: 'rejected' }], expiresAt: null });
    if (turn !== undefined) runtime.turns.transition(turn.turnRef, { state: 'pending-human-input', reason: 'approval requested', finalAnswer: turn.finalAnswer, pendingInteractionId: event.rpcId, evidence: 'event' });
    return;
  }
  if (event.method === 'user-questions/request' && frameSessionId !== undefined && request !== undefined) {
    const questions = parseQuestions(request.questions);
    runtime.pending.upsert({ pendingInteractionId: event.rpcId, sessionId: frameSessionId, turnRef: findTurnForSession(runtime, frameSessionId)?.turnRef ?? null, kind: 'question', prompt: questions.map((question) => question.question).join('\n') || 'DSH is waiting for an answer', options: [], questions, expiresAt: null });
    const turn = findTurnForSession(runtime, frameSessionId);
    if (turn !== undefined) runtime.turns.transition(turn.turnRef, { state: 'pending-human-input', reason: 'question requested', finalAnswer: turn.finalAnswer, pendingInteractionId: event.rpcId, evidence: 'event' });
    return;
  }
  if (event.method === 'remote/cancel') {
    runtime.turns.resolveInteraction(event.rpcId);
    runtime.pending.remove(event.rpcId);
    return;
  }
  const turn = findMatchingTurn(runtime, event);
  if (turn === undefined) return;
  const next = stateFromEvent(frame, event.rpcId, turn.finalAnswer);
  if (next === null) return;
  runtime.turns.transition(turn.turnRef, next);
}

async function recoverAfterDisconnect(runtime: ActionRuntime, ref: string, record: TurnRecord, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  if (signal.aborted) return null;
  const snapshot = await runtime.events.sessionSnapshot(record.sessionId, 200, signal).catch(() => null);
  if (snapshot === null) return null;
  const projection = classifyHistoryTurn({ records: snapshot.records, hasMore: snapshot.hasMore }, ref, record.sessionId, record.sourceRef);
  if (projection === null) return null;
  const updated = runtime.turns.transition(ref, projection);
  return turnResult(runtime, updated, 'terminal');
}

function findMatchingTurn(runtime: ActionRuntime, event: DshEvent): TurnRecord | undefined {
  const frame = unwrapEvent(event.payload);
  if (!isRecord(frame)) return undefined;
  const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined;
  if (sessionId === undefined) return undefined;
  const eventValue = frame.type === 'session/event' && isRecord(frame.event) ? frame.event : frame;
  const eventData = isRecord(eventValue.data) ? eventValue.data : {};
  const type = typeof eventValue.type === 'string' ? eventValue.type : '';
  if (type === 'turn/start' && typeof eventData.turn === 'number') {
    runtime.turns.observeDshTurnStart(sessionId, eventData.turn);
    return undefined;
  }
  if (type === 'user/message' && isRecord(eventData.source) && typeof eventData.source.rpcId === 'string') {
    return runtime.turns.bindRequestToOpenTurn(sessionId, eventData.source.rpcId);
  }
  if (typeof eventData.turn === 'number') return runtime.turns.findByDshTurn(sessionId, eventData.turn);
  return undefined;
}

function findTurnForSession(runtime: ActionRuntime, sessionId: string): TurnRecord | undefined {
  return runtime.turns.all().find((record) => record.sessionId === sessionId && !isTerminalState(record.state));
}

function stateFromEvent(frame: Record<string, unknown>, pendingId: string, previousAnswer: string | null): Pick<TurnRecord, 'state' | 'reason' | 'finalAnswer' | 'pendingInteractionId' | 'evidence'> | null {
  const eventValue = frame.type === 'session/event' && isRecord(frame.event) ? frame.event : frame;
  const type = typeof eventValue.type === 'string' ? eventValue.type : '';
  const data = isRecord(eventValue.data) ? eventValue.data : eventValue;
  const answer = extractAssistantText(eventValue) ?? previousAnswer;
  const state = normalizeState(data.state ?? data.status ?? inferTurnState(type, data));
  if (state === null) return answer === previousAnswer ? null : { state: 'running', reason: null, finalAnswer: answer, pendingInteractionId: null, evidence: 'event' };
  return { state, reason: boundedReason(data.reason ?? data.error), finalAnswer: answer, pendingInteractionId: state === 'pending-human-input' ? pendingId : null, evidence: 'event' };
}

function inferTurnState(type: string, data: Record<string, unknown>): TurnState | undefined {
  if (type === 'turn/start') return 'running';
  if (type === 'user/message') return 'running';
  if (type === 'assistant/message') return 'running';
  if (type !== 'turn/end') return undefined;
  const reason = isRecord(data.reason) && typeof data.reason.kind === 'string' ? data.reason.kind : '';
  if (reason === 'aborted') return isRecord(data.reason) && isRecord(data.reason.reason) && data.reason.reason.kind === 'user' ? 'cancelled' : 'interrupted';
  if (reason === 'interrupted') return 'interrupted';
  if (reason === 'error' || reason === 'blocked' || reason === 'max-tokens') return 'failed';
  return 'completed';
}

function extractAssistantText(value: Record<string, unknown>): string | null {
  if (value.type !== 'assistant/message' || !isRecord(value.data) || !isRecord(value.data.message) || !Array.isArray(value.data.message.content)) return null;
  const text = value.data.message.content.filter(isRecord).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text as string).join('');
  return text === '' ? null : truncate(text);
}

function turnResult(runtime: ActionRuntime, record: TurnRecord, waitOutcome: 'terminal' | 'pending-human-input' | 'timed-out'): Record<string, unknown> {
  return { turnRef: record.turnRef, sessionId: record.sessionId, state: record.state, waitOutcome, reason: record.reason, finalAnswer: record.finalAnswer, pendingInteraction: record.pendingInteractionId === null ? null : runtime.pending.get(record.pendingInteractionId) ?? { pendingInteractionId: record.pendingInteractionId }, evidence: record.evidence };
}

function parseQuestions(value: unknown): PendingQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((question) => {
    if (!isRecord(question) || typeof question.id !== 'string' || typeof question.question !== 'string') return [];
    const intent = isRecord(question.intent) && question.intent.kind === 'plan-review' && typeof question.intent.approve === 'string'
      ? { kind: 'plan-review' as const, approve: question.intent.approve }
      : undefined;
    return [{
      id: question.id,
      question: question.question,
      ...(typeof question.detail === 'string' ? { detail: question.detail } : {}),
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      options: Array.isArray(question.options) ? question.options.filter(isRecord).flatMap((option) => typeof option.label === 'string' ? [{ label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) }] : []) : [],
      multiSelect: question.multiSelect === true,
      ...(intent === undefined ? {} : { intent }),
    }];
  });
}

function normalizeState(value: unknown): TurnState | null {
  return value === 'accepted' || value === 'queued' || value === 'running' || value === 'pending-human-input' || value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'interrupted' || value === 'transport-lost' || value === 'unknown' ? value : null;
}

function boundedReason(value: unknown): string | null {
  if (typeof value === 'string') return truncate(value);
  if (isRecord(value)) {
    const kind = typeof value.kind === 'string' ? value.kind : null;
    const message = typeof value.message === 'string'
      ? value.message
      : typeof value.error === 'string'
        ? value.error
        : isRecord(value.error) && typeof value.error.message === 'string'
          ? value.error.message
          : null;
    if (kind !== null && message !== null) return truncate(`${kind}: ${message}`);
    if (kind !== null) return truncate(kind);
  }
  return null;
}

function truncate(value: string): string {
  return value.length <= 4_000 ? value : `${value.slice(0, 3_999)}…`;
}

function unwrapEvent(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return value.type === 'session/event' && isRecord(value.event) ? { ...value.event, sessionId: value.sessionId } : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeContent(content: Array<{ type: 'text'; text: string } | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string | undefined }> | undefined, message: string | undefined): SessionPromptPart[] {
  if (content !== undefined) return content.map((part) => part.type === 'text' ? part : { type: 'image', mediaType: part.mediaType, data: part.data, ...(part.name === undefined ? {} : { name: part.name }) });
  return [{ type: 'text', text: message ?? '' }];
}
