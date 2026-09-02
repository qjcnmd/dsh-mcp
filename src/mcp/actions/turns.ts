import { z } from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { DshEvent } from '../../dsh/event-client.js';
import type { SessionPromptPart } from '../../dsh/rpc-client.js';
import { publicPendingInteraction, type PendingQuestion } from '../../domain/pending-interactions.js';
import { classifyHistoryTurn, terminalFromReason, visibleAssistantText } from '../../dsh/recovery.js';
import { isTerminalState, type TerminalReason, type TurnRecord } from '../../domain/turns.js';
import type { ActionRuntime } from './common.js';
import { idSchema as id, pendingInteractionSchema as pendingSchema, projectToolResult, reasonSchema, registerAction, requestSignal, toolExecutionError } from './common.js';

const contentPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1) }),
  z.object({ type: z.literal('image'), mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), data: z.string().min(1), name: id.optional() }),
]);
const waitOutputSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('completed'), turnRef: id, sessionId: id, hasFinalResponse: z.boolean() }),
  z.object({ state: z.enum(['failed', 'cancelled', 'interrupted']), turnRef: id, sessionId: id, reason: reasonSchema, hasFinalResponse: z.boolean() }),
  z.object({ state: z.literal('input_required'), turnRef: id, sessionId: id, pendingInteraction: pendingSchema }),
  z.object({ state: z.literal('timed_out'), turnRef: id, sessionId: id, observedState: z.enum(['accepted', 'queued', 'running']) }),
  z.object({ state: z.enum(['transport_lost', 'unknown']), turnRef: id, sessionId: id, reason: reasonSchema }),
]);

export function registerTurnActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.send_message', {
    description: 'Submit text or admitted image content to one explicit session and return immediately with a process-local turnRef.',
    inputSchema: z.object({ sessionId: id, message: z.string().min(1).optional(), content: z.array(contentPart).min(1).optional(), mode: z.enum(['steer', 'queue']).default('steer'), clientTimeZone: id.optional() })
      .refine((value) => (value.message === undefined) !== (value.content === undefined), 'exactly one of message or content is required'),
    outputSchema: z.object({ sessionId: id, turnRef: id, accepted: z.literal(true), mode: z.enum(['steer', 'queue']) }),
  }, async (args, ctx) => submitTurn(runtime, {
    sessionId: args.sessionId,
    content: normalizeContent(args.content, args.message),
    mode: args.mode,
    ...(args.clientTimeZone === undefined ? {} : { clientTimeZone: args.clientTimeZone }),
  }, requestSignal(ctx)));

  registerAction(server, 'dsh.session.wait_turn', {
    description: 'Wait for one turnRef using DSH events; one recovery read is used only if the event stream fails.',
    inputSchema: z.object({ turnRef: id, timeoutMs: z.number().int().positive().max(300_000).optional() }),
    outputSchema: waitOutputSchema,
  }, (args, ctx) => waitForTurn(runtime, args.turnRef, args.timeoutMs ?? 300_000, requestSignal(ctx)));
}

export async function waitForTurn(runtime: ActionRuntime, ref: string, timeoutMs: number, signal: AbortSignal): Promise<CallToolResult> {
  const existing = runtime.turns.get(ref);
  if (existing === undefined) return toolExecutionError('turn-ref-not-found', 'The turnRef is unknown or expired.', { turnRef: ref });
  if (isTerminalState(existing.state) || existing.state === 'pending-human-input') return waitResult(runtime, existing);

  return new Promise<CallToolResult>((resolve, reject) => {
    let settled = false;
    let recovering = false;
    let unsubscribe = (): void => undefined;
    const abort = () => finish(undefined, signal.reason ?? new DOMException('Operation aborted', 'AbortError'));
    const finish = (value?: CallToolResult, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener('abort', abort);
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => {
      const current = runtime.turns.get(ref) ?? existing;
      finish(waitResult(runtime, current, 'timed_out'));
    }, timeoutMs);

    unsubscribe = runtime.events.subscribeSession(existing.sessionId, (event) => {
      observeEvent(runtime, event);
      if (event.method === 'stream/error' && event.stream === 'mux' && !recovering) {
        recovering = true;
        void recoverAfterDisconnect(runtime, ref, existing, signal).then((recovered) => {
          if (recovered !== null) finish(waitResult(runtime, recovered));
          else {
            const lost = runtime.turns.transition(ref, { state: 'transport-lost', reason: { kind: 'transport-lost', code: null, message: readMessage(event.payload) }, finalAnswer: runtime.turns.get(ref)?.finalAnswer ?? null, pendingInteractionId: null });
            finish(waitResult(runtime, lost));
          }
        });
        return;
      }
      const current = runtime.turns.get(ref);
      if (current !== undefined && (isTerminalState(current.state) || current.state === 'pending-human-input')) finish(waitResult(runtime, current));
    }, signal);

    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

async function submitTurn(runtime: ActionRuntime, input: { sessionId: string; content: SessionPromptPart[]; mode: 'queue' | 'steer'; clientTimeZone?: string }, signal: AbortSignal): Promise<CallToolResult> {
  const requestId = crypto.randomUUID();
  const record = runtime.turns.register({ sessionId: input.sessionId, sourceRef: `rpc:${requestId}` });
  const response = await runtime.rpc.session.prompt({ requestId, ...input }, signal);
  if (!response.ok) {
    runtime.turns.reject(record.turnRef, response.error.message);
    return toolExecutionError(response.error.dshCode, response.error.message, { sessionId: input.sessionId });
  }
  if (input.mode === 'queue') runtime.turns.transition(record.turnRef, { state: 'queued', reason: null, finalAnswer: null, pendingInteractionId: null });
  return projectToolResult({ sessionId: input.sessionId, turnRef: record.turnRef, accepted: true, mode: input.mode }, `Message accepted in ${input.mode} mode.`);
}

export function observeEvent(runtime: ActionRuntime, event: DshEvent): void {
  const frame = unwrapEvent(event.payload);
  if (!isRecord(frame)) return;
  const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined;
  const request = isRecord(frame.request) ? frame.request : undefined;
  if ((event.method === 'approval/request' || event.method === 'user-questions/request') && sessionId !== undefined && request !== undefined) {
    observeInteraction(runtime, event, sessionId, request);
    return;
  }
  if (event.method === 'remote/cancel') {
    runtime.turns.resolveInteraction(event.rpcId);
    runtime.pending.remove(event.rpcId);
    return;
  }

  for (const turn of findMatchingTurns(runtime, frame)) {
    const next = stateFromEvent(frame, turn.finalAnswer);
    if (next !== null) runtime.turns.transition(turn.turnRef, next);
  }
}

async function recoverAfterDisconnect(runtime: ActionRuntime, ref: string, record: TurnRecord, signal: AbortSignal): Promise<TurnRecord | null> {
  if (signal.aborted) return null;
  const snapshot = await runtime.events.sessionSnapshot(record.sessionId, 200, signal).catch(() => null);
  if (snapshot === null) return null;
  const projection = classifyHistoryTurn({ records: snapshot.records, hasMore: snapshot.hasMore }, ref, record.sessionId, record.sourceRef);
  return projection === null ? null : runtime.turns.transition(ref, projection);
}

function findMatchingTurns(runtime: ActionRuntime, frame: Record<string, unknown>): TurnRecord[] {
  const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined;
  if (sessionId === undefined) return [];
  const data = isRecord(frame.data) ? frame.data : {};
  if (frame.type === 'turn/start' && typeof data.turn === 'number') {
    runtime.turns.observeDshTurnStart(sessionId, data.turn);
    return [];
  }
  if (frame.type === 'user/message' && isRecord(data.source) && typeof data.source.rpcId === 'string') {
    const record = runtime.turns.bindRequestToOpenTurn(sessionId, data.source.rpcId);
    return record === undefined ? [] : [record];
  }
  return typeof data.turn === 'number' ? runtime.turns.findByDshTurn(sessionId, data.turn) : [];
}

function stateFromEvent(event: Record<string, unknown>, previousAnswer: string | null): Pick<TurnRecord, 'state' | 'reason' | 'finalAnswer' | 'pendingInteractionId'> | null {
  const data = isRecord(event.data) ? event.data : {};
  if (event.type === 'turn/end') return { ...terminalFromReason(data.reason), finalAnswer: previousAnswer, pendingInteractionId: null };
  if (event.type === 'turn/start' || event.type === 'user/message') return { state: 'running', reason: null, finalAnswer: previousAnswer, pendingInteractionId: null };
  if (event.type === 'assistant/message') return { state: 'running', reason: null, finalAnswer: visibleAssistantText(event) ?? previousAnswer, pendingInteractionId: null };
  return null;
}

function observeInteraction(runtime: ActionRuntime, event: DshEvent, sessionId: string, request: Record<string, unknown>): void {
  const turn = runtime.turns.all().find((record) => record.sessionId === sessionId && !isTerminalState(record.state));
  const questions = event.method === 'user-questions/request' ? parseQuestions(request.questions) : undefined;
  const toolName = typeof request.toolName === 'string' ? request.toolName : 'tool';
  const prompt = questions?.map((question) => question.question).join('\n') || (typeof request.reason === 'string' ? `${toolName}: ${request.reason}` : `DSH requests approval for ${toolName}`);
  runtime.pending.upsert({ pendingInteractionId: event.rpcId, sessionId, turnRef: turn?.turnRef ?? null, kind: questions === undefined ? 'approval' : 'question', prompt, options: questions === undefined ? [{ label: 'allowed-once' }, { label: 'rejected' }] : [], ...(questions === undefined ? {} : { questions }) });
  if (turn !== undefined) runtime.turns.transition(turn.turnRef, { state: 'pending-human-input', reason: null, finalAnswer: turn.finalAnswer, pendingInteractionId: event.rpcId });
}

function waitResult(runtime: ActionRuntime, record: TurnRecord, outcome?: 'timed_out'): CallToolResult {
  let metadata: Record<string, unknown>;
  if (outcome === 'timed_out') {
    metadata = { state: 'timed_out', turnRef: record.turnRef, sessionId: record.sessionId, observedState: record.state };
  } else if (record.state === 'pending-human-input') {
    const pending = record.pendingInteractionId === null ? undefined : runtime.pending.get(record.pendingInteractionId);
    metadata = pending === undefined
      ? { state: 'unknown', turnRef: record.turnRef, sessionId: record.sessionId, reason: { kind: 'interaction-missing', code: null, message: 'The pending interaction is unavailable.' } }
      : { state: 'input_required', turnRef: record.turnRef, sessionId: record.sessionId, pendingInteraction: publicPendingInteraction(pending) };
  } else if (record.state === 'completed') {
    metadata = { state: 'completed', turnRef: record.turnRef, sessionId: record.sessionId, hasFinalResponse: record.finalAnswer !== null };
  } else if (record.state === 'failed' || record.state === 'cancelled' || record.state === 'interrupted') {
    metadata = { state: record.state, turnRef: record.turnRef, sessionId: record.sessionId, reason: ensuredReason(record.reason, record.state), hasFinalResponse: record.finalAnswer !== null };
  } else if (record.state === 'transport-lost') {
    metadata = { state: 'transport_lost', turnRef: record.turnRef, sessionId: record.sessionId, reason: ensuredReason(record.reason, 'transport-lost') };
  } else {
    metadata = { state: 'unknown', turnRef: record.turnRef, sessionId: record.sessionId, reason: ensuredReason(record.reason, 'unknown') };
  }
  return { structuredContent: metadata, content: [{ type: 'text', text: record.finalAnswer ?? waitSummary(metadata) }] };
}

function ensuredReason(value: TerminalReason | null, kind: string): TerminalReason {
  return value ?? { kind, code: null, message: null };
}

function waitSummary(value: Record<string, unknown>): string {
  if (value.state === 'input_required' && isRecord(value.pendingInteraction)) return value.pendingInteraction.kind === 'approval' ? 'DSH requires approval.' : 'DSH requires an answer.';
  return `DSH turn ${String(value.state).replace('_', ' ')}.`;
}

function parseQuestions(value: unknown): PendingQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((question) => {
    if (!isRecord(question) || typeof question.id !== 'string' || typeof question.question !== 'string') return [];
    return [{ id: question.id, question: question.question, ...(typeof question.detail === 'string' ? { detail: question.detail } : {}), ...(typeof question.header === 'string' ? { header: question.header } : {}), options: Array.isArray(question.options) ? question.options.filter(isRecord).flatMap((option) => typeof option.label === 'string' ? [{ label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) }] : []) : [], multiSelect: question.multiSelect === true }];
  });
}

function normalizeContent(content: Array<{ type: 'text'; text: string } | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string | undefined }> | undefined, message: string | undefined): SessionPromptPart[] {
  return content?.map((part) => part.type === 'text' ? part : { type: 'image', mediaType: part.mediaType, data: part.data, ...(part.name === undefined ? {} : { name: part.name }) }) ?? [{ type: 'text', text: message ?? '' }];
}

function unwrapEvent(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return value.type === 'session/event' && isRecord(value.event) ? { ...value.event, sessionId: value.sessionId } : value;
}

function readMessage(value: unknown): string | null {
  return isRecord(value) && typeof value.message === 'string' ? value.message : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
