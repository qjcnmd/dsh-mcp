import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { DshRuntime } from './transport.js';
import { projectToolResult, truncateText } from './result-projection.js';
import { isTerminalState, type TurnRecord, type TurnState } from '../domain/turns.js';
import { UnsupportedCapabilityError } from '../errors.js';
import { classifyHistoryTurn } from '../dsh/recovery.js';

const outputSchema = z.record(z.string(), z.unknown());
const sessionId = z.string().trim().min(1);
const workspaceId = z.string().trim().min(1);
const turnRef = z.string().trim().min(1);

export function registerTools(server: McpServer, runtime: DshRuntime): void {
  const register = server.registerTool.bind(server) as any;
  const signal = (ctx: any): AbortSignal => ctx.mcpReq.signal;
  register('dsh.workspace.list', { description: 'List DSH workspaces with bounded session membership.', inputSchema: z.object({}), outputSchema }, async (_args: unknown, ctx: any) => projectToolResult(await readResult(runtime.rpc.workspace.list({}, signal(ctx)))));
  register('dsh.workspace.create', { description: 'Adopt a directory as a DSH workspace.', inputSchema: z.object({ path: z.string().trim().min(1) }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await mutateResult(runtime.rpc.workspace.create(args, signal(ctx)), { path: args.path })));
  register('dsh.workspace.rename', { description: 'Rename one explicitly targeted DSH workspace.', inputSchema: z.object({ workspaceId, title: z.string().trim().min(1) }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await mutateResult(runtime.rpc.workspace.rename(args, signal(ctx)), { workspaceId: args.workspaceId })));
  register('dsh.workspace.delete', { description: 'Delete one explicitly targeted DSH workspace.', inputSchema: z.object({ workspaceId }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await mutateResult(runtime.rpc.workspace.delete(args, signal(ctx)), { workspaceId: args.workspaceId })));
  register('dsh.workspace.reorder', { description: 'Move one workspace before another workspace.', inputSchema: z.object({ workspaceId, beforeWorkspaceId: workspaceId.optional() }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await mutateResult(runtime.rpc.workspace.insertBefore(clean(args), signal(ctx)), { workspaceId: args.workspaceId })));
  register('dsh.session.list', { description: 'List DSH sessions with bounded summaries.', inputSchema: z.object({ cursor: z.string().optional() }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await readResult(runtime.rpc.session.list(clean(args), signal(ctx)))));
  register('dsh.session.search', { description: 'Search DSH sessions by query.', inputSchema: z.object({ query: z.string().trim().min(1).max(500) }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await readResult(runtime.rpc.session.search(args, signal(ctx)))));
  register('dsh.session.create', { description: 'Create a DSH session in an explicit workspace or directory.', inputSchema: z.object({ workspaceId: workspaceId.optional(), cwd: z.string().trim().min(1).optional(), agentPreset: z.string().trim().min(1).optional() }).refine((value) => value.workspaceId !== undefined || value.cwd !== undefined, 'workspaceId or cwd is required').refine((value) => !(value.workspaceId !== undefined && value.cwd !== undefined), 'workspaceId and cwd are mutually exclusive'), outputSchema }, async (args: any, ctx: any) => projectToolResult(await mutateResult(runtime.rpc.session.create(clean(args), signal(ctx)), { workspaceId: args.workspaceId ?? null, cwd: args.cwd ?? null })));
  register('dsh.session.rename', { description: 'Rename one explicitly targeted DSH session.', inputSchema: z.object({ sessionId, title: z.string().trim().min(1) }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await mutateResult(runtime.rpc.session.rename(args, signal(ctx)), { sessionId: args.sessionId })));
  register('dsh.session.fork', { description: 'Fork one explicitly targeted DSH session.', inputSchema: z.object({ sessionId, atSeq: z.number().int().nonnegative().optional() }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await mutateResult(runtime.rpc.session.fork(clean(args), signal(ctx)), { sessionId: args.sessionId })));
  register('dsh.session.archive', { description: 'Archive one explicitly targeted DSH session.', inputSchema: z.object({ workspaceId, sessionId }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await mutateResult(runtime.rpc.workspace.archiveSession(args, signal(ctx)), { workspaceId: args.workspaceId, sessionId: args.sessionId })));
  register('dsh.session.reorder', { description: 'Move one session within an explicitly targeted workspace.', inputSchema: z.object({ workspaceId, sessionId, beforeSessionId: sessionId.optional() }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await mutateResult(runtime.rpc.workspace.insertSessionBefore(clean(args), signal(ctx)), { workspaceId: args.workspaceId, sessionId: args.sessionId })));
  register('dsh.session.history', { description: 'Read a bounded page of one DSH session history.', inputSchema: z.object({ sessionId, beforeSeq: z.number().int().nonnegative().optional(), maxMessages: z.number().int().positive().max(200).optional() }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await readResult(runtime.rpc.session.history(clean(args), signal(ctx)))));
  register('dsh.session.models', { description: 'Read the model catalog and current selection for one DSH session.', inputSchema: z.object({ sessionId }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await readResult(runtime.rpc.session.models(args, signal(ctx)))));
  register('dsh.session.select_model', { description: 'Select an available model and reasoning effort for one DSH session.', inputSchema: z.object({ sessionId, provider: z.string().trim().min(1), model: z.string().trim().min(1), reasoningEffort: z.string().trim().min(1).optional() }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await mutateResult(runtime.rpc.session.selectModel(clean(args), signal(ctx)), { sessionId: args.sessionId })));
  register('dsh.session.send_message', { description: 'Submit one text message to an explicitly targeted DSH session and return immediately with a turnRef.', inputSchema: z.object({ sessionId, message: z.string().min(1), mode: z.enum(['send', 'queue', 'steer']).default('send') }), outputSchema }, async (args: any, ctx: any) => {
    const mappedMode = args.mode === 'steer' ? 'steer' : 'queue';
    const result = await runtime.rpc.session.prompt({ sessionId: args.sessionId, mode: mappedMode, content: [{ type: 'text', text: args.message }] }, signal(ctx));
    if (!result.ok) return projectToolResult({ target: { sessionId: args.sessionId }, accepted: false, effect: 'rejected', error: { code: result.error.dshCode, message: result.error.message } });
    const record = runtime.turns.register({ sessionId: args.sessionId, sourceRef: `local-${crypto.randomUUID()}` });
    return projectToolResult({ target: { sessionId: args.sessionId }, accepted: true, effect: args.mode === 'steer' ? 'changed' : args.mode === 'queue' ? 'queued' : 'applied', turnRef: record.turnRef, state: record.state, reason: null });
  });
  register('dsh.session.cancel', { description: 'Cancel the explicitly targeted DSH session turn.', inputSchema: z.object({ sessionId }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await mutateResult(runtime.rpc.session.cancel(args, signal(ctx)), { sessionId: args.sessionId })));
  register('dsh.session.update_queue', { description: 'Edit, remove, or steer one explicitly targeted queued item.', inputSchema: z.object({ sessionId, itemId: z.string().trim().min(1), action: z.object({ kind: z.enum(['edit', 'remove', 'steer']), content: z.array(z.record(z.string(), z.unknown())).optional() }) }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await mutateResult(runtime.rpc.session.updateQueue(args, signal(ctx)), { sessionId: args.sessionId, itemId: args.itemId })));
  register('dsh.session.wait_turn', { description: 'Wait for one explicit turnRef using DSH event evidence, without periodic DSH status polling.', inputSchema: z.object({ turnRef, timeoutMs: z.number().int().positive().max(300_000).optional() }), outputSchema }, async (args: any, ctx: any) => projectToolResult(await waitForTurn(runtime, args.turnRef, args.timeoutMs ?? 300_000, signal(ctx))));
  for (const [name, label] of [['dsh.page.export', 'export'], ['dsh.page.feedback', 'feedback'], ['dsh.page.settings', 'settings'], ['dsh.page.copy', 'clipboard copy'], ['dsh.page.select_session', 'page selection']] as const) {
    register(name, { description: `Report the current support boundary for the ${label} homepage control.`, inputSchema: z.object({}), outputSchema }, async () => {
      const error = new UnsupportedCapabilityError(name);
      return { ...projectToolResult({ supported: false, support: 'unsupported', capability: name, reason: error.message }), isError: true };
    });
  }
}

async function readResult<T>(result: Promise<{ ok: true; value: T } | { ok: false; error: { dshCode: string; message: string } }>): Promise<Record<string, unknown>> {
  const value = await result;
  if (value.ok) return { accepted: true, effect: 'applied', result: value.value };
  return { accepted: false, effect: 'rejected', error: { code: value.error.dshCode, message: value.error.message } };
}

async function mutateResult<T>(result: Promise<{ ok: true; value: T } | { ok: false; error: { dshCode: string; message: string } }>, target: Record<string, unknown>): Promise<Record<string, unknown>> {
  const value = await result;
  if (value.ok) return { target, accepted: true, effect: 'applied', result: value.value };
  return { target, accepted: false, effect: 'rejected', error: { code: value.error.dshCode, message: value.error.message } };
}

async function waitForTurn(runtime: DshRuntime, ref: string, timeoutMs: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  const existing = runtime.turns.get(ref);
  if (existing === undefined) return { turnRef: ref, state: 'unknown', waitOutcome: 'transport-lost', reason: 'unknown turnRef', finalAnswer: null, pendingInteraction: null, evidence: 'incomplete' };
  if (isTerminalState(existing.state) || existing.state === 'pending-human-input') return turnResult(existing, existing.state === 'pending-human-input' ? 'pending-human-input' : 'terminal');
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let unsubscribe: () => void = () => undefined;
    const finish = (value: Record<string, unknown>) => { if (settled) return; settled = true; clearTimeout(timer); unsubscribe(); resolve(value); };
    timer = setTimeout(() => finish({ ...turnResult(runtime.turns.get(ref) ?? existing, 'timed-out'), waitOutcome: 'timed-out', evidence: 'incomplete' }), timeoutMs);
    unsubscribe = runtime.events.subscribe((event) => {
      runtime.cursors.record(event.stream, { type: event.method, position: String(event.order) });
      if (event.method === 'stream/error') {
        if (event.stream === 'mux') {
          void recoverAfterDisconnect(runtime, ref, existing, signal).then((recovered) => {
            if (recovered !== null) finish(recovered);
            else finish({ ...turnResult(runtime.turns.get(ref) ?? existing, 'terminal'), state: 'transport-lost', waitOutcome: 'transport-lost', evidence: 'incomplete' });
          });
        }
        return;
      }
      const current = runtime.turns.get(ref);
      if (current === undefined || !matchesTurn(event.payload, current, runtime)) return;
      const next = stateFromEvent(event.payload);
      if (next === null) return;
      const updated = runtime.turns.transition(ref, next);
      if (updated.state === 'pending-human-input') finish(turnResult(updated, 'pending-human-input'));
      else if (isTerminalState(updated.state)) finish(turnResult(updated, 'terminal'));
    }, signal);
    if (signal.aborted) { unsubscribe(); clearTimeout(timer); reject(signal.reason ?? new DOMException('Operation aborted', 'AbortError')); }
    else signal.addEventListener('abort', () => { unsubscribe(); clearTimeout(timer); reject(signal.reason ?? new DOMException('Operation aborted', 'AbortError')); }, { once: true });
  });
}

async function recoverAfterDisconnect(runtime: DshRuntime, ref: string, record: TurnRecord, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  if (signal.aborted) return null;
  const history = await runtime.rpc.session.history({ sessionId: record.sessionId, maxMessages: 200 }, signal).catch(() => null);
  if (history === null || !history.ok) return null;
  const projection = classifyHistoryTurn(history.value, ref, record.sessionId, record.sourceRef);
  if (projection === null) return null;
  const updated = runtime.turns.transition(ref, projection);
  return turnResult(updated, 'terminal');
}

function matchesTurn(payload: unknown, record: TurnRecord, runtime: DshRuntime): boolean {
  const outer = isRecord(payload) ? payload : {};
  const value = unwrapEvent(payload);
  if (!isRecord(value)) return false;
  const candidate = value.turnRef ?? value.turnId ?? (isRecord(value.event) ? value.event.turnRef : undefined);
  if (candidate === record.turnRef || candidate === record.sourceRef) return true;
  const session = typeof outer.sessionId === 'string' ? outer.sessionId : undefined;
  const innerType = typeof value.type === 'string' ? value.type : '';
  const data = isRecord(value.data) ? value.data : {};
  const dshTurn = data.turn ?? data.turnId;
  if (session === record.sessionId && innerType === 'turn/start' && dshTurn !== undefined && record.sourceRef.startsWith('local-')) {
    runtime.turns.bindSource(record.turnRef, `dsh-turn:${String(dshTurn)}`);
    return true;
  }
  return session === record.sessionId && record.sourceRef.startsWith('dsh-turn:') && String(dshTurn) === record.sourceRef.slice('dsh-turn:'.length);
}

function stateFromEvent(payload: unknown): Pick<TurnRecord, 'state' | 'reason' | 'finalAnswer' | 'pendingInteractionId' | 'evidence'> | null {
  const value = unwrapEvent(payload);
  if (!isRecord(value)) return null;
  const type = typeof value.type === 'string' ? value.type : '';
  const data = isRecord(value.data) ? value.data : isRecord(value.event) && isRecord(value.event.data) ? value.event.data : value;
  const state = normalizeState(data.state ?? data.status ?? inferTurnEndState(type, data));
  if (state === null) return null;
  return { state, reason: boundedReason(data.reason), finalAnswer: typeof data.finalAnswer === 'string' ? truncateText(data.finalAnswer) : null, pendingInteractionId: typeof data.pendingInteractionId === 'string' ? data.pendingInteractionId : null, evidence: 'event' };
}

function inferTurnEndState(type: string, data: Record<string, unknown>): TurnState | undefined {
  if (type === 'turn/start') return 'running';
  if (type !== 'turn/end') return undefined;
  const reason = isRecord(data.reason) && typeof data.reason.kind === 'string' ? data.reason.kind : '';
  if (reason === 'cancelled' || reason === 'canceled') return 'cancelled';
  if (reason === 'interrupted') return 'interrupted';
  if (reason === 'error' || reason === 'failed') return 'failed';
  return 'completed';
}

function boundedReason(value: unknown): string | null {
  if (typeof value === 'string') return truncateText(value);
  if (isRecord(value)) {
    const kind = typeof value.kind === 'string' ? value.kind : null;
    const message = typeof value.message === 'string' ? value.message : null;
    if (kind !== null && message !== null) return truncateText(`${kind}: ${message}`);
    if (kind !== null) return truncateText(kind);
  }
  return null;
}

function turnResult(record: TurnRecord, waitOutcome: 'terminal' | 'pending-human-input' | 'timed-out'): Record<string, unknown> {
  return { turnRef: record.turnRef, sessionId: record.sessionId, state: record.state, waitOutcome, reason: record.reason, finalAnswer: record.finalAnswer, pendingInteraction: record.pendingInteractionId === null ? null : { pendingInteractionId: record.pendingInteractionId }, evidence: record.evidence };
}

function normalizeState(value: unknown): TurnState | null {
  return value === 'accepted' || value === 'queued' || value === 'running' || value === 'pending-human-input' || value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'interrupted' || value === 'transport-lost' || value === 'unknown' ? value : null;
}

function unwrapEvent(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return value.type === 'session/event' && isRecord(value.event) ? value.event : value;
}

function clean<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
