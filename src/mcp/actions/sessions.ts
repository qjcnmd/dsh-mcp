import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { sessionPage } from '../../domain/collections.js';
import { terminalFromReason, visibleAssistantText } from '../../dsh/recovery.js';
import { DshMcpError } from '../../errors.js';
import type { ActionRuntime } from './common.js';
import { projectToolResult, registerAction, requestSignal, toolExecutionError } from './common.js';

const sessionId = z.string().trim().min(1);
const workspaceId = z.string().trim().min(1);
const modelSelection = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().nullable() });
const sessionSummary = z.object({ sessionId, workspaceId: workspaceId.nullable(), workspaceTitle: z.string().nullable(), title: z.string().nullable(), cwd: z.string().nullable(), status: z.enum(['running', 'idle']), blank: z.boolean(), updatedAt: z.number(), model: modelSelection.nullable(), agentPreset: z.string().nullable() });
const reason = z.object({ kind: z.string(), code: z.string().nullable(), message: z.string().nullable() });
const historyTurn = z.object({ turn: z.number().int().nonnegative(), state: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown']), startedAt: z.number().nullable(), endedAt: z.number().nullable(), userMessages: z.array(z.object({ text: z.string().nullable(), imageCount: z.number().int().nonnegative() })), finalResponse: z.string().nullable(), finalResponseComplete: z.boolean(), reason: reason.nullable() });

export function registerSessionActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.list', {
    description: 'List compact unarchived DSH session summaries with AND-composed filters.',
    inputSchema: z.object({ workspaceId: workspaceId.optional(), status: z.enum(['running', 'idle']).optional(), query: z.string().optional(), limit: z.number().int().min(1).max(100).default(20), cursor: z.string().min(1).optional() }),
    outputSchema: z.object({ items: z.array(sessionSummary), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
  }, async (args, ctx) => {
    const signal = requestSignal(ctx);
    const [sessions, workspaces] = await Promise.all([runtime.rpc.session.list({}, signal), runtime.events.workspaceSnapshot(signal)]);
    if (!sessions.ok) return toolExecutionError(sessions.error.dshCode, sessions.error.message);
    const page = sessionPage(sessions.value.items, workspaces, args);
    return projectToolResult(page, `${page.items.length} session(s); more: ${page.hasMore}.`);
  });

  registerAction(server, 'dsh.session.create', {
    description: 'Create a DSH session in an explicit workspace or directory.',
    inputSchema: z.object({
      workspaceId: workspaceId.optional(),
      cwd: z.string().trim().min(1).optional(),
      sessionId: sessionId.optional(),
      agentPreset: z.string().trim().min(1).optional(),
    }).refine((value) => value.workspaceId !== undefined || value.cwd !== undefined, 'workspaceId or cwd is required')
      .refine((value) => !(value.workspaceId !== undefined && value.cwd !== undefined), 'workspaceId and cwd are mutually exclusive'),
    outputSchema: z.object({ sessionId, agentPreset: z.string().nullable() }),
  }, async (args, ctx) => {
    const result = await runtime.rpc.session.create({ ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }), ...(args.cwd === undefined ? {} : { cwd: args.cwd }), ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }), ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }) }, requestSignal(ctx));
    if (!result.ok) return toolExecutionError(result.error.dshCode, result.error.message, { workspaceId: args.workspaceId ?? '', cwd: args.cwd ?? '' });
    return projectToolResult({ sessionId: result.value.sessionId, agentPreset: result.value.agentPreset ?? args.agentPreset ?? null }, `Created session ${result.value.sessionId}.`);
  });

  registerAction(server, 'dsh.session.history', {
    description: 'Read one to five projected turns from a stable, newest-first DSH history view.',
    inputSchema: z.object({ sessionId, cursor: z.string().min(1).optional(), limit: z.number().int().min(1).max(5).default(1) }),
    outputSchema: z.object({ sessionId, turns: z.array(historyTurn), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
  }, async (args, ctx) => {
    const result = await readHistory(runtime, args.sessionId, args.limit, args.cursor, requestSignal(ctx));
    return projectToolResult(result, `${result.turns.length} turn(s); more: ${result.hasMore}.`);
  });

}

export function registerPresetAction(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.agent_preset.select', {
    description: 'Select a preset for one explicitly targeted blank session.',
    inputSchema: z.object({ sessionId, agentPreset: z.string().trim().min(1) }),
    outputSchema: z.object({ sessionId, agentPreset: z.string() }),
  }, async (args, ctx) => {
    const result = await runtime.rpc.agentPresets.select(args, requestSignal(ctx));
    if (!result.ok) return toolExecutionError(result.error.dshCode, result.error.message, { sessionId: args.sessionId });
    return projectToolResult({ sessionId: args.sessionId, agentPreset: result.value }, `Selected preset ${result.value}.`);
  });
}

interface ProjectedHistoryTurn {
  turn: number;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
  startedAt: number | null;
  endedAt: number | null;
  userMessages: Array<{ text: string | null; imageCount: number }>;
  finalResponse: string | null;
  finalResponseComplete: boolean;
  reason: { kind: string; code: string | null; message: string | null } | null;
  startSeq: number;
}

async function readHistory(runtime: ActionRuntime, targetSessionId: string, limit: number, cursorValue: string | undefined, signal: AbortSignal) {
  const cursor = cursorValue === undefined ? null : decodeHistoryCursor(cursorValue, targetSessionId);
  const pageSize = Math.max(20, (limit + 1) * 2);
  let records;
  let throughSeq: number;
  let hasMore: boolean;
  let beforeSeq: number | undefined;
  if (cursor === null) {
    const snapshot = await runtime.events.sessionSnapshot(targetSessionId, pageSize, signal);
    records = [...snapshot.records];
    throughSeq = snapshot.cursor;
    hasMore = snapshot.hasMore;
  } else {
    const first = await runtime.rpc.session.page({ sessionId: targetSessionId, throughSeq: cursor.throughSeq, beforeSeq: cursor.beforeSeq, maxMessages: pageSize }, signal);
    if (!first.ok) throw first.error;
    records = [...first.value.records];
    throughSeq = cursor.throughSeq;
    hasMore = first.value.hasMore;
    beforeSeq = cursor.beforeSeq;
  }

  let projected = projectHistory(records);
  while (projected.length <= limit && hasMore) {
    const nextBefore = minimumSeq(records);
    if (nextBefore === null || (beforeSeq !== undefined && nextBefore >= beforeSeq)) throw new DshMcpError('protocol-error', 'DSH history did not advance to an older page.', { sessionId: targetSessionId });
    const next = await runtime.rpc.session.page({ sessionId: targetSessionId, throughSeq, beforeSeq: nextBefore, maxMessages: pageSize }, signal);
    if (!next.ok) throw next.error;
    records = [...next.value.records, ...records];
    hasMore = next.value.hasMore;
    beforeSeq = nextBefore;
    projected = projectHistory(records);
  }

  const newest = [...projected].reverse();
  const turns = newest.slice(0, limit);
  const moreTurns = newest.length > limit;
  const nextCursor = moreTurns && turns.length !== 0 ? encodeHistoryCursor(targetSessionId, throughSeq, turns.at(-1)!.startSeq) : null;
  return { sessionId: targetSessionId, turns: turns.map(({ startSeq: _startSeq, ...turn }) => turn), hasMore: moreTurns, nextCursor };
}

function projectHistory(records: Array<{ type: 'event' | 'chunks'; event: Record<string, unknown> }>): ProjectedHistoryTurn[] {
  const turns = new Map<number, ProjectedHistoryTurn>();
  let currentTurn: number | undefined;
  for (const record of records) {
    if (record.type !== 'event') continue;
    const event = record.event;
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === 'turn/start' && typeof data.turn === 'number') {
      currentTurn = data.turn;
      turns.set(data.turn, { turn: data.turn, state: 'running', startedAt: numberOrNull(event.time), endedAt: null, userMessages: [], finalResponse: null, finalResponseComplete: false, reason: null, startSeq: typeof event.seq === 'number' ? event.seq : -1 });
      continue;
    }
    const turnNumber = typeof data.turn === 'number' ? data.turn : currentTurn;
    const turn = turnNumber === undefined ? undefined : turns.get(turnNumber);
    if (turn === undefined) continue;
    if (event.type === 'user/message' && event.surfaceOp === 'append' && isRecord(data.source) && data.source.kind === 'user' && Array.isArray(data.content)) {
      const parts = data.content.filter(isRecord);
      const text = parts.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text as string).join('');
      turn.userMessages.push({ text: text === '' ? null : text, imageCount: parts.filter((part) => part.type === 'image').length });
    } else if (event.type === 'assistant/message') {
      turn.finalResponse = visibleAssistantText(event) ?? turn.finalResponse;
    } else if (event.type === 'turn/end') {
      const terminal = terminalFromReason(data.reason);
      turn.state = terminal.state;
      turn.reason = terminal.reason;
      turn.endedAt = numberOrNull(event.time);
      turn.finalResponseComplete = terminal.state === 'completed' && turn.finalResponse !== null;
      if (currentTurn === turnNumber) currentTurn = undefined;
    }
  }
  return [...turns.values()].sort((a, b) => a.startSeq - b.startSeq);
}

function decodeHistoryCursor(value: string, targetSessionId: string): { throughSeq: number; beforeSeq: number } {
  let cursor: unknown;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw invalidHistoryCursor(targetSessionId); }
  if (!isRecord(cursor) || cursor.version !== 1 || cursor.sessionId !== targetSessionId || !Number.isSafeInteger(cursor.throughSeq) || !Number.isSafeInteger(cursor.beforeSeq) || (cursor.beforeSeq as number) < 0) throw invalidHistoryCursor(targetSessionId);
  return { throughSeq: cursor.throughSeq as number, beforeSeq: cursor.beforeSeq as number };
}

function encodeHistoryCursor(targetSessionId: string, throughSeq: number, beforeSeq: number): string {
  return Buffer.from(JSON.stringify({ version: 1, sessionId: targetSessionId, throughSeq, beforeSeq })).toString('base64url');
}

function invalidHistoryCursor(targetSessionId: string): DshMcpError {
  return new DshMcpError('invalid-cursor', 'The history cursor does not belong to this session.', { sessionId: targetSessionId });
}

function minimumSeq(records: Array<{ event: Record<string, unknown> }>): number | null {
  const seqs = records.map((record) => record.event.seq).filter((seq): seq is number => typeof seq === 'number');
  return seqs.length === 0 ? null : Math.min(...seqs);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
