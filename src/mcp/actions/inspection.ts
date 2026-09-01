import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { RuntimeSnapshot } from '../../domain/snapshots.js';
import type { ActionRuntime } from './common.js';
import { projectToolResult, registerAction, requestSignal } from './common.js';

const sessionId = z.string().trim().min(1);

export function registerInspectionActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.snapshot', {
    description: 'Return a bounded snapshot of one explicitly targeted DSH session.',
    inputSchema: z.object({ sessionId, recentEvents: z.number().int().positive().max(50).default(10) }),
  }, async (args, ctx) => {
    const signal = requestSignal(ctx);
    const [sessions, follow] = await Promise.all([
      runtime.rpc.session.list({}, signal),
      runtime.events.sessionSnapshot(args.sessionId, args.recentEvents, signal),
    ]);
    if (!sessions.ok) return projectToolResult({ target: { sessionId: args.sessionId }, accepted: false, effect: 'rejected', error: { code: sessions.error.dshCode, message: sessions.error.message } });
    const session = sessions.value.items.find((item) => item.sessionId === args.sessionId);
    if (session === undefined) return projectToolResult({ target: { sessionId: args.sessionId }, accepted: false, effect: 'rejected', error: { code: 'session-not-found', message: 'The requested session is not visible.' } });
    const activeTurn = runtime.turns.all().find((turn) => turn.sessionId === args.sessionId && !['completed', 'failed', 'cancelled', 'interrupted', 'transport-lost', 'unknown'].includes(turn.state)) ?? null;
    const title = readTitle(session, follow.projections.values);
    const running = session.running === true;
    const recentEvents = follow.records.slice(-args.recentEvents).map((record) => ({ type: readEventType(record.event), sessionId: args.sessionId, observedAt: new Date().toISOString() }));
    const snapshot: RuntimeSnapshot = {
      session: { sessionId: args.sessionId, workspaceId: null, status: running ? 'running' : 'idle', running, ...(title === undefined ? {} : { title }) },
      activeTurn,
      pendingInteractions: runtime.pending.list(args.sessionId),
      recentEvents,
      cursor: { stream: 'session/follow', position: String(follow.cursor), lastEventType: recentEvents.at(-1)?.type ?? null, updatedAt: new Date().toISOString() },
    };
    return projectToolResult({ target: { sessionId: args.sessionId }, accepted: true, effect: 'applied', snapshot, projections: follow.projections });
  });

  registerAction(server, 'dsh.session.context_stats', {
    description: 'Read bounded context, token, usage, and turn statistics for one session.',
    inputSchema: z.object({ sessionId }),
  }, async (args, ctx) => {
    const follow = await runtime.events.sessionSnapshot(args.sessionId, 20, requestSignal(ctx));
    const stats = Object.fromEntries(Object.entries(follow.projections.values).filter(([key]) => /context|token|usage|stat/i.test(key)));
    return projectToolResult({ target: { sessionId: args.sessionId }, accepted: true, effect: 'applied', stats, asOfSeq: follow.projections.asOfSeq });
  });
}

function readTitle(session: Record<string, unknown>, projections: Record<string, unknown>): string | undefined {
  if (typeof projections.title === 'string') return projections.title;
  const hints = isRecord(session.projections) && isRecord(session.projections.values) ? session.projections.values : undefined;
  return typeof hints?.title === 'string' ? hints.title : undefined;
}

function readEventType(event: Record<string, unknown>): string {
  return typeof event.type === 'string' ? event.type : 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
