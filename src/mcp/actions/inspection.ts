import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { publicPendingInteraction } from '../../domain/pending-interactions.js';
import { sessionSummary } from '../../domain/collections.js';
import { isTerminalState, TURN_STATES } from '../../domain/turns.js';
import type { RuntimeSnapshot } from '../../domain/snapshots.js';
import type { ActionRuntime } from './common.js';
import { projectToolResult, registerAction, requestSignal, toolExecutionError } from './common.js';

const id = z.string().trim().min(1);
const model = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().nullable() });
const summary = z.object({ sessionId: id, workspaceId: id.nullable(), workspaceTitle: z.string().nullable(), title: z.string().nullable(), cwd: z.string().nullable(), status: z.enum(['running', 'idle']), blank: z.boolean(), updatedAt: z.number(), model: model.nullable(), agentPreset: z.string().nullable() });
const reason = z.object({ kind: z.string(), code: z.string().nullable(), message: z.string().nullable() });
const question = z.object({ id, question: z.string(), detail: z.string().optional(), header: z.string().optional(), options: z.array(z.object({ label: z.string(), description: z.string().optional() })), multiSelect: z.boolean() });
const pending = z.discriminatedUnion('kind', [z.object({ kind: z.literal('approval'), pendingInteractionId: id, sessionId: id, prompt: z.string(), options: z.array(z.object({ outcome: z.enum(['allowed-once', 'rejected']), label: z.string() })) }), z.object({ kind: z.literal('question'), pendingInteractionId: id, sessionId: id, questions: z.array(question) })]);

export function registerInspectionActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.snapshot', {
    description: 'Return content-free state metadata for one explicit DSH session.',
    inputSchema: z.object({ sessionId: id, recentEvents: z.number().int().min(1).max(50).default(10) }),
    outputSchema: z.object({ session: summary, activeTurn: z.object({ turnRef: id, state: z.enum(TURN_STATES), reason: reason.nullable(), observedAt: z.string() }).nullable(), pendingInteractions: z.array(pending), recentEvents: z.array(z.object({ seq: z.number().int(), type: z.string(), time: z.number().nullable(), turn: z.number().int().nullable() })), cursor: z.number().int() }),
  }, async (args, ctx) => {
    const signal = requestSignal(ctx);
    const [sessions, workspaces, follow] = await Promise.all([runtime.rpc.session.list({}, signal), runtime.events.workspaceSnapshot(signal), runtime.events.sessionSnapshot(args.sessionId, args.recentEvents, signal)]);
    if (!sessions.ok) return toolExecutionError(sessions.error.dshCode, sessions.error.message, { sessionId: args.sessionId });
    const raw = sessions.value.items.find((item) => item.sessionId === args.sessionId);
    if (raw === undefined) return toolExecutionError('session-not-found', 'The requested session is not visible.', { sessionId: args.sessionId });
    const workspace = workspaces.items.find((item) => item.sessionIds.includes(args.sessionId));
    const active = runtime.turns.all().find((turn) => turn.sessionId === args.sessionId && !isTerminalState(turn.state));
    const recentEvents = follow.records.filter((record) => record.type === 'event').slice(-args.recentEvents).flatMap((record) => {
      const event = record.event;
      if (typeof event.seq !== 'number' || typeof event.type !== 'string') return [];
      const data = isRecord(event.data) ? event.data : {};
      return [{ seq: event.seq, type: event.type, time: typeof event.time === 'number' ? event.time : null, turn: typeof data.turn === 'number' ? data.turn : null }];
    });
    const snapshot: RuntimeSnapshot = {
      session: sessionSummary(raw, workspace),
      activeTurn: active === undefined ? null : { turnRef: active.turnRef, state: active.state, reason: active.reason, observedAt: active.observedAt },
      pendingInteractions: runtime.pending.list(args.sessionId).map(publicPendingInteraction),
      recentEvents,
      cursor: follow.cursor,
    };
    return projectToolResult(snapshot, `Session ${args.sessionId}: ${snapshot.session.status}; ${recentEvents.length} recent event(s).`);
  });

  registerAction(server, 'dsh.session.context_stats', {
    description: 'Read normalized context capacity and pressure for one explicit DSH session.',
    inputSchema: z.object({ sessionId: id }),
    outputSchema: z.object({ sessionId: id, contextWindow: z.number().nullable(), usedTokens: z.number().nullable(), remainingTokens: z.number().nullable(), usagePercent: z.number().nullable(), asOfSeq: z.number().int() }),
  }, async (args, ctx) => {
    const follow = await runtime.events.sessionSnapshot(args.sessionId, 1, requestSignal(ctx));
    const pressure = isRecord(follow.projections.values.contextPressure) ? follow.projections.values.contextPressure : {};
    const contextWindow = numberOrNull(pressure.contextWindow);
    const usedTokens = numberOrNull(pressure.pressureTokens);
    const remainingTokens = contextWindow === null || usedTokens === null ? null : Math.max(0, contextWindow - usedTokens);
    const usagePercent = contextWindow === null || usedTokens === null || contextWindow === 0 ? null : usedTokens / contextWindow * 100;
    const result = { sessionId: args.sessionId, contextWindow, usedTokens, remainingTokens, usagePercent, asOfSeq: follow.projections.asOfSeq };
    return projectToolResult(result, contextWindow === null ? 'Context statistics are unavailable.' : `Context usage: ${usagePercent?.toFixed(1)}%.`);
  });
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
