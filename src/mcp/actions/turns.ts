import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { ACTIVE_TURN_STATES, TERMINAL_TURN_STATES, isTerminalState, type TerminalReason, type TurnRecord } from '../../domain/turns.js';
import { DshMcpError, isAbortError } from '../../errors.js';
import type { ProjectedToolResult } from '../result-projection.js';
import type { ActionRuntime } from './common.js';
import { idSchema as id, projectToolResult, reasonSchema, registerAction, requestSignal, toolError, toolExecutionError, type ToolErrorResult } from './common.js';

const waitOutputSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('completed'), turnRef: id, sessionId: id, hasFinalResponse: z.boolean() }),
  z.object({ state: z.enum(TERMINAL_TURN_STATES).exclude(['completed']), turnRef: id, sessionId: id, reason: reasonSchema, hasFinalResponse: z.boolean() }),
  z.object({ state: z.literal('timed_out'), turnRef: id, sessionId: id, observedState: z.enum(ACTIVE_TURN_STATES) }),
  z.object({ state: z.literal('transport_lost'), turnRef: id, sessionId: id, reason: reasonSchema }),
]);

type WaitOutput = z.infer<typeof waitOutputSchema>;
type WaitResult = ProjectedToolResult<WaitOutput> | ToolErrorResult;

export function registerTurnActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.send_message', {
    description: 'Send a message to the session without queuing and return a turnRef for waiting on the result.',
    inputSchema: z.object({
      sessionId: id,
      message: z.string().trim().min(1),
      requestId: id.describe('Deduplication ID for this message; generated if omitted. Reuse only when retrying the same message.').optional(),
    }).strict(),
    outputSchema: z.object({ sessionId: id, turnRef: id, requestId: id, accepted: z.literal(true) }),
  }, async (args, ctx) => {
    await runtime.events.sessionSnapshot(args.sessionId, 1, requestSignal(ctx));
    const requestId = args.requestId ?? crypto.randomUUID();
    const record = runtime.turns.register({ sessionId: args.sessionId, sourceRef: 'rpc:' + requestId });
    const release = runtime.turns.retain(record.turnRef);
    try {
      try {
        const response = await runtime.rpc.session.prompt({
          requestId, sessionId: args.sessionId, content: [{ type: 'text', text: args.message }],
        }, requestSignal(ctx));
        if (!response.ok) {
          runtime.turns.reject(record.turnRef, response.error.message);
          return toolError(response.error, { sessionId: args.sessionId, turnRef: record.turnRef, requestId });
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        return toolExecutionError('submission-unknown', 'DSH may have accepted this message. Wait on turnRef, or retry the same message with requestId. ' + (error instanceof Error ? error.message : String(error)), { sessionId: args.sessionId, turnRef: record.turnRef, requestId });
      }
      runtime.turns.accept(record.turnRef);
      return projectToolResult({ sessionId: args.sessionId, turnRef: record.turnRef, requestId, accepted: true }, 'Message accepted.');
    } finally {
      release();
    }
  });

  registerAction(server, 'dsh.session.wait_turn', {
    description: 'Wait for a turn to end using either turnRef or sessionId. Returns the complete final reply on success or the end reason otherwise. Returns early when the turn ends; a timeout does not stop DSH.',
    inputSchema: z.object({
      turnRef: id.describe('Turn handle returned by send_message or wait_turn.').optional(),
      sessionId: id.describe('Observe the latest started turn in this session unless turn is specified.').optional(),
      turn: z.number().int().nonnegative().describe('Exact DSH turn number to observe. Requires sessionId.').optional(),
      timeoutMs: z.number().int().positive().max(300_000).default(30_000),
    }).refine((value) => (value.turnRef === undefined) !== (value.sessionId === undefined), 'exactly one of turnRef or sessionId is required')
      .refine((value) => value.turn === undefined || value.sessionId !== undefined, 'turn requires sessionId'),
    outputSchema: waitOutputSchema,
  }, async (args, ctx) => {
    const signal = requestSignal(ctx);
    if (args.turnRef !== undefined) return waitForTurn(runtime, args.turnRef, args.timeoutMs, signal);
    const sessionId = args.sessionId!;
    const deadline = Date.now() + args.timeoutMs;
    let record: TurnRecord | undefined;
    if (args.turn !== undefined) record = runtime.turns.register({ sessionId, sourceRef: 'dsh-turn:' + args.turn });
    else {
      const timeout = AbortSignal.timeout(args.timeoutMs);
      try {
        await runtime.observations.inspect(sessionId, AbortSignal.any([signal, timeout]));
      } catch (error) {
        signal.throwIfAborted();
        if (timeout.aborted) return toolExecutionError('observation-timeout', 'The wait expired before the session turn could be identified. Retry with sessionId.', { sessionId });
        throw error;
      }
      record = runtime.turns.latest(sessionId);
    }
    if (record === undefined) return toolExecutionError('session-has-no-turn', 'This session has no started turn to observe.', { sessionId });
    return waitForTurn(runtime, record.turnRef, Math.max(0, deadline - Date.now()), signal);
  });

  registerAction(server, 'dsh.session.cancel', {
    description: 'Request cancellation of active DSH work. Use wait_turn to observe its final state.',
    inputSchema: z.object({ sessionId: id }),
    outputSchema: z.object({ sessionId: id, cancellationRequested: z.literal(true) }),
  }, async (args, ctx) => {
    const signal = requestSignal(ctx);
    await runtime.events.sessionSnapshot(args.sessionId, 1, signal);
    const result = await runtime.rpc.session.cancel({ sessionId: args.sessionId }, signal);
    if (!result.ok) return toolError(result.error, { sessionId: args.sessionId });
    return projectToolResult({ sessionId: args.sessionId, cancellationRequested: true }, 'Cancellation requested.');
  });
}

export async function waitForTurn(runtime: ActionRuntime, ref: string, timeoutMs: number, signal: AbortSignal): Promise<WaitResult> {
  signal.throwIfAborted();
  const existing = runtime.turns.restore(ref);
  if (existing === undefined) return toolExecutionError('turn-ref-not-found', 'The turnRef is invalid or belongs to an older MCP format.', { turnRef: ref });
  if (isTerminalState(existing.state)) return waitResult(existing);
  const releaseTurn = runtime.turns.retain(ref);

  return new Promise<WaitResult>((resolve, reject) => {
    let release = (): void => undefined;
    let settled = false;
    const finish = (value?: WaitResult, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release();
      releaseTurn();
      signal.removeEventListener('abort', abort);
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(undefined, signal.reason);
    const changed = () => {
      const current = runtime.turns.get(ref)!;
      if (isTerminalState(current.state)) finish(waitResult(current));
      else {
        const error = runtime.observations.error(existing.sessionId);
        if (error instanceof DshMcpError && error.code !== 'transport-lost') finish(toolError(error, { sessionId: existing.sessionId, turnRef: ref }));
        else if (error !== undefined) finish(projectToolResult<WaitOutput>({ state: 'transport_lost', turnRef: ref, sessionId: existing.sessionId, reason: { kind: 'transport-lost', code: null, message: error.message } }, 'Observation interrupted; retry this turnRef to recover.'));
      }
    };
    const timer = setTimeout(() => {
      const current = runtime.turns.get(ref)!;
      finish(waitResult(current));
    }, timeoutMs);
    try {
      release = runtime.observations.watch(existing.sessionId, changed, existing.sourceRef);
    } catch (error) {
      finish(undefined, error);
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function waitResult(record: TurnRecord): ProjectedToolResult<WaitOutput> {
  let metadata: WaitOutput;
  const { state } = record;
  if (state === 'completed') {
    metadata = { state: 'completed', turnRef: record.turnRef, sessionId: record.sessionId, hasFinalResponse: record.finalAnswer !== null };
  } else if (isTerminalState(state)) {
    metadata = { state, turnRef: record.turnRef, sessionId: record.sessionId, reason: ensuredReason(record.reason, state), hasFinalResponse: false };
  } else {
    metadata = { state: 'timed_out', turnRef: record.turnRef, sessionId: record.sessionId, observedState: state };
  }
  const summary = 'DSH turn ' + String(metadata.state).replaceAll('_', ' ') + '.';
  const result = projectToolResult(metadata, summary);
  if (record.state === 'completed' && record.finalAnswer !== null) result.content.push({ type: 'text', text: record.finalAnswer });
  return result;
}

function ensuredReason(value: TerminalReason | null, kind: string): TerminalReason { return value ?? { kind, code: null, message: null }; }
