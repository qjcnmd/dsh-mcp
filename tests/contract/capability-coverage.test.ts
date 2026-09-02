import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadConfig } from '../../src/config.js';
import { createMcpServer, createRuntime } from '../../src/mcp/transport.js';
import { PendingInteractionStore } from '../../src/domain/pending-interactions.js';
import { TurnStore } from '../../src/domain/turns.js';

const EXPECTED_TOOLS = [
  'dsh.workspace.list',
  'dsh.session.archive',
  'dsh.session.list',
  'dsh.session.create',
  'dsh.session.history',
  'dsh.session.models',
  'dsh.session.select_model',
  'dsh.session.send_message',
  'dsh.session.wait_turn',
  'dsh.session.cancel',
  'dsh.session.respond_approval',
  'dsh.session.answer_question',
  'dsh.session.command',
  'dsh.command.compact',
  'dsh.session.snapshot',
  'dsh.session.context_stats',
  'dsh.agent_preset.select',
  'dsh.page.select_session',
  'dsh.page.get_context',
] as const;

describe('public tool surface', () => {
  it('exposes exactly the selected compact tool set', async () => {
    expect((await listTools()).map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
  });

  it('declares dedicated input and output shapes for every tool', async () => {
    const inputs = [
      ['query', 'limit', 'cursor'], ['sessionId'], ['workspaceId', 'status', 'query', 'limit', 'cursor'], ['workspaceId', 'cwd', 'sessionId', 'agentPreset'], ['sessionId', 'cursor', 'limit'], ['sessionId'], ['sessionId', 'provider', 'model', 'reasoningEffort'], ['sessionId', 'message', 'content', 'mode', 'clientTimeZone'], ['turnRef', 'timeoutMs'], ['sessionId'], ['sessionId', 'pendingInteractionId', 'outcome'], ['sessionId', 'pendingInteractionId', 'answers'], ['sessionId', 'command'], ['sessionId'], ['sessionId', 'recentEvents'], ['sessionId'], ['sessionId', 'agentPreset'], ['sessionId'], [],
    ];
    const outputs = [
      ['items', 'hasMore', 'nextCursor'], ['sessionId', 'archived'], ['items', 'hasMore', 'nextCursor'], ['sessionId', 'agentPreset'], ['sessionId', 'turns', 'hasMore', 'nextCursor'], ['sessionId', 'selection', 'models'], ['sessionId', 'selected'], ['sessionId', 'turnRef', 'accepted', 'mode'], [], ['sessionId', 'cancellationRequested'], ['sessionId', 'pendingInteractionId', 'outcome', 'accepted'], ['sessionId', 'pendingInteractionId', 'accepted'], ['sessionId', 'command', 'status', 'message'], ['sessionId', 'compacted', 'message'], ['session', 'activeTurn', 'pendingInteractions', 'recentEvents', 'cursor'], ['sessionId', 'contextWindow', 'usedTokens', 'remainingTokens', 'usagePercent', 'asOfSeq'], ['sessionId', 'agentPreset'], ['selectedSessionId'], ['selectedSessionId', 'session', 'workspace'],
    ];
    const tools = await listTools();
    for (const [index, tool] of tools.entries()) {
      expect(Object.keys((tool.inputSchema as Record<string, unknown>).properties as object ?? {}), String(tool.name)).toEqual(inputs[index]);
      expect(tool.outputSchema, String(tool.name)).toBeDefined();
      const branches = (tool.outputSchema as { oneOf: Array<Record<string, unknown>> }).oneOf;
      expect(branches).toHaveLength(2);
      expect(Object.keys((branches[0]!.properties as object | undefined) ?? {}), String(tool.name)).toEqual(outputs[index]);
      expect(Object.keys((branches[1]!.properties as object | undefined) ?? {})).toEqual(['error']);
    }
    const wait = ((tools[8]!.outputSchema as { oneOf: Array<{ oneOf?: unknown }> }).oneOf[0] as { oneOf: Array<{ properties: { state: { const?: string; enum?: string[] } } }> });
    expect(wait.oneOf.flatMap((branch) => branch.properties.state.const ?? branch.properties.state.enum ?? [])).toEqual(['completed', 'failed', 'cancelled', 'interrupted', 'input_required', 'timed_out', 'transport_lost', 'unknown']);
    const workspaceLimit = (((tools[0]!.inputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).limit);
    const historyLimit = (((tools[4]!.inputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).limit);
    expect(workspaceLimit).toMatchObject({ default: 20, minimum: 1, maximum: 100 });
    expect(historyLimit).toMatchObject({ default: 1, minimum: 1, maximum: 5 });
  });

  it('declares only steer and queue with steer as the send default', async () => {
    const send = (await listTools()).find((tool) => tool.name === 'dsh.session.send_message');
    const mode = ((send?.inputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).mode;
    expect(mode.enum).toEqual(['steer', 'queue']);
    expect(mode.default).toBe('steer');
  });

  it('pages and filters at least 100 session summaries without hidden truncation', async () => {
    const workspaces = {
      items: [
        { workspaceId: 'w-a', title: 'Alpha', path: 'C:\\alpha', sessionIds: Array.from({ length: 51 }, (_, i) => `s-${String(i).padStart(3, '0')}`), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
        { workspaceId: 'w-b', title: 'Beta', path: 'C:\\beta', sessionIds: Array.from({ length: 50 }, (_, i) => `s-${String(i + 51).padStart(3, '0')}`), createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z' },
      ],
      archivedSessionIds: ['s-100'],
    };
    const sessions = Array.from({ length: 101 }, (_, i) => ({ sessionId: `s-${String(i).padStart(3, '0')}`, updatedAt: Math.floor(i / 2), running: i % 2 === 0, blank: false, cwd: i === 88 ? 'C:\\needle-folder' : `C:\\work\\${i}`, projections: { asOfSeq: i, values: { title: i === 88 ? 'Needle title' : `Session ${i}`, agentPreset: 'simple', modelSelection: { next: { provider: 'b-ai', model: 'qwen3.8-flash', reasoningEffort: 'high' }, lastUsed: null } } } }));
    const runtime = collectionRuntime(sessions, workspaces);

    const all = await callTool(runtime, 'dsh.session.list', { limit: 100 });
    expect((all.structuredContent as { items: unknown[] }).items).toHaveLength(100);
    expect(all.structuredContent).toMatchObject({ hasMore: false, nextCursor: null });
    expect(JSON.stringify(all.structuredContent)).not.toContain('s-100');

    const first = await callTool(runtime, 'dsh.session.list', { limit: 20 });
    const cursor = (first.structuredContent as { nextCursor: string }).nextCursor;
    const second = await callTool(runtime, 'dsh.session.list', { limit: 20, cursor });
    const firstIds = (first.structuredContent as { items: Array<{ sessionId: string }> }).items.map((item) => item.sessionId);
    const secondIds = (second.structuredContent as { items: Array<{ sessionId: string }> }).items.map((item) => item.sessionId);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(40);
    expect(firstIds.slice(0, 2)).toEqual(['s-098', 's-099']);

    const filtered = await callTool(runtime, 'dsh.session.list', { workspaceId: 'w-b', status: 'running', query: 'needle', limit: 20 });
    expect(filtered.structuredContent).toMatchObject({ items: [{ sessionId: 's-088', workspaceTitle: 'Beta', status: 'running' }], hasMore: false });

    const wrongFilter = await callTool(runtime, 'dsh.session.list', { query: 'changed', cursor });
    expect(wrongFilter).toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid-cursor' } } });
    sessions[99]!.updatedAt += 10;
    const stale = await callTool(runtime, 'dsh.session.list', { limit: 20, cursor });
    expect(stale).toMatchObject({ isError: true, structuredContent: { error: { code: 'stale-cursor' } } });
  });

  it('returns compact workspace pages in DSH registry order', async () => {
    const workspaces = { items: [
      { workspaceId: 'w-z', title: 'Zeta', path: 'C:\\zeta', sessionIds: ['active', 'archived'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      { workspaceId: 'w-a', title: 'Alpha', path: 'C:\\alpha', sessionIds: [], createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z' },
    ], archivedSessionIds: ['archived'] };
    const runtime = collectionRuntime([], workspaces);
    const result = await callTool(runtime, 'dsh.workspace.list', { limit: 1 });
    expect(result.structuredContent).toMatchObject({ items: [{ workspaceId: 'w-z', sessionCount: 1 }], hasMore: true });
    expect(JSON.stringify(result.structuredContent)).not.toContain('sessionIds');
  });

  it('returns exact configuration receipts without activating a cold session', async () => {
    let activated = 0;
    const turns = new TurnStore();
    const active = turns.register({ sessionId: 'session-test', sourceRef: 'rpc:test' });
    turns.transition(active.turnRef, { state: 'running', reason: null, finalAnswer: null, pendingInteractionId: null });
    const runtime = {
      turns,
      pending: new PendingInteractionStore(),
      selectedSessionId: null,
      rpc: {
        session: {
          list: async () => ({ ok: true, value: { items: [{ sessionId: 'session-test', updatedAt: 1, running: false, blank: true, projections: { asOfSeq: 1, values: { modelSelection: { lastUsed: null, next: { provider: 'b-ai', model: 'qwen3.8-flash', reasoningEffort: 'high' } } } } }] } }),
          modelCatalog: async () => ({ ok: true, value: { default: { provider: 'b-ai', model: 'default' }, routableProviders: ['b-ai'], failures: [], groups: [{ id: 'b-ai', name: 'B.AI', models: [{ id: 'qwen3.8-flash', name: 'Qwen 3.8 Flash', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] } }),
          selectModel: async () => ({ ok: true, value: { selected: { provider: 'b-ai', model: 'qwen3.8-flash', reasoningEffort: 'high' } } }),
          create: async () => ({ ok: true, value: { sessionId: 'created', agentPreset: 'simple' } }),
          cancel: async () => ({ ok: true, value: { accepted: true } }),
        },
        workspace: { archiveSession: async () => ({ ok: true, value: { archivedSessionIds: ['session-test'] } }) },
        agentPresets: { select: async () => ({ ok: true, value: 'simple' }) },
      },
      events: { subscribeSession: () => { activated += 1; return () => undefined; }, sessionSnapshot: async () => { activated += 1; throw new Error('not expected'); } },
    } as never;

    expect((await callTool(runtime, 'dsh.session.models', { sessionId: 'session-test' })).structuredContent).toEqual({ sessionId: 'session-test', selection: { provider: 'b-ai', model: 'qwen3.8-flash', reasoningEffort: 'high' }, models: [{ provider: 'b-ai', model: 'qwen3.8-flash', label: 'Qwen 3.8 Flash', reasoningEfforts: ['high'] }] });
    expect(activated).toBe(0);
    expect((await callTool(runtime, 'dsh.session.select_model', { sessionId: 'session-test', provider: 'b-ai', model: 'qwen3.8-flash', reasoningEffort: 'high' })).structuredContent).toEqual({ sessionId: 'session-test', selected: { provider: 'b-ai', model: 'qwen3.8-flash', reasoningEffort: 'high' } });
    expect((await callTool(runtime, 'dsh.session.create', { cwd: 'C:\\temp', agentPreset: 'simple' })).structuredContent).toEqual({ sessionId: 'created', agentPreset: 'simple' });
    expect((await callTool(runtime, 'dsh.agent_preset.select', { sessionId: 'session-test', agentPreset: 'simple' })).structuredContent).toEqual({ sessionId: 'session-test', agentPreset: 'simple' });
    expect((await callTool(runtime, 'dsh.session.cancel', { sessionId: 'session-test' })).structuredContent).toEqual({ sessionId: 'session-test', cancellationRequested: true });
    expect((await callTool(runtime, 'dsh.session.archive', { sessionId: 'session-test' })).structuredContent).toEqual({ sessionId: 'session-test', archived: true });
    expect(turns.get(active.turnRef)?.state).toBe('running');
  });

  it('returns content-free snapshots, normalized context statistics, and compact selected context', async () => {
    const turns = new TurnStore();
    const active = turns.register({ sessionId: 'session-test', sourceRef: 'rpc:test' });
    turns.transition(active.turnRef, { state: 'running', reason: null, finalAnswer: 'must not leak', pendingInteractionId: null });
    const workspaces = { items: [{ workspaceId: 'w', title: 'Workspace', path: 'C:\\work', sessionIds: ['session-test'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }], archivedSessionIds: [] };
    const rawSession = { sessionId: 'session-test', updatedAt: 10, running: true, blank: false, cwd: 'C:\\work', projections: { asOfSeq: 9, values: { title: 'Session', agentPreset: 'simple', contextPressure: { pressureTokens: 25, contextWindow: 100 } } } };
    const runtime = {
      turns, pending: new PendingInteractionStore(), selectedSessionId: null,
      rpc: { session: { list: async () => ({ ok: true, value: { items: [rawSession] } }) } },
      events: { workspaceSnapshot: async () => workspaces, sessionSnapshot: async () => ({ cursor: 9, hasMore: false, header: {}, records: [{ type: 'event', event: { seq: 8, time: 80, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, message: { content: [{ type: 'text', text: 'conversation must not leak' }] } } } }], projections: { asOfSeq: 9, values: rawSession.projections.values } }) },
    } as never;

    const snapshot = await callTool(runtime, 'dsh.session.snapshot', { sessionId: 'session-test', recentEvents: 5 });
    expect(snapshot.structuredContent).toMatchObject({ session: { sessionId: 'session-test', workspaceId: 'w', title: 'Session', status: 'running' }, activeTurn: { turnRef: active.turnRef, state: 'running' }, recentEvents: [{ seq: 8, type: 'assistant/message', time: 80, turn: 2 }], cursor: 9 });
    expect(JSON.stringify(snapshot.structuredContent)).not.toContain('must not leak');
    expect((await callTool(runtime, 'dsh.session.context_stats', { sessionId: 'session-test' })).structuredContent).toEqual({ sessionId: 'session-test', contextWindow: 100, usedTokens: 25, remainingTokens: 75, usagePercent: 25, asOfSeq: 9 });
    expect((await callTool(runtime, 'dsh.page.get_context', {})).structuredContent).toEqual({ selectedSessionId: null, session: null, workspace: null });
    expect((await callTool(runtime, 'dsh.page.select_session', { sessionId: 'session-test' })).structuredContent).toEqual({ selectedSessionId: 'session-test' });
    const context = await callTool(runtime, 'dsh.page.get_context', {});
    expect(context.structuredContent).toMatchObject({ selectedSessionId: 'session-test', session: { sessionId: 'session-test', title: 'Session' }, workspace: { workspaceId: 'w', sessionCount: 1 } });
    expect(JSON.stringify(context.structuredContent)).not.toContain('sessionIds');
  });

  it('responds to exact pending interaction identities once', async () => {
    const turns = new TurnStore();
    const pending = new PendingInteractionStore();
    const approvalTurn = turns.register({ sessionId: 'session-test', sourceRef: 'rpc:approval' });
    turns.transition(approvalTurn.turnRef, { state: 'pending-human-input', reason: null, finalAnswer: null, pendingInteractionId: 'approval' });
    pending.upsert({ pendingInteractionId: 'approval', sessionId: 'session-test', turnRef: approvalTurn.turnRef, kind: 'approval', prompt: 'Allow shell?', options: [{ label: 'allowed-once' }, { label: 'rejected' }] });
    const values: unknown[] = [];
    const runtime = {
      turns, pending, selectedSessionId: null, rpc: {},
      events: { respondRemoteInteraction: async (_id: string, value: unknown) => { values.push(value); return { ok: true, value: undefined }; } },
    } as never;
    expect((await callTool(runtime, 'dsh.session.respond_approval', { sessionId: 'other', pendingInteractionId: 'approval', outcome: 'allowed-once' }))).toMatchObject({ isError: true, structuredContent: { error: { code: 'pending-interaction-mismatch' } } });
    const approval = await callTool(runtime, 'dsh.session.respond_approval', { sessionId: 'session-test', pendingInteractionId: 'approval', outcome: 'allowed-once' });
    expect(approval.structuredContent).toEqual({ sessionId: 'session-test', pendingInteractionId: 'approval', outcome: 'allowed-once', accepted: true });
    expect(turns.get(approvalTurn.turnRef)?.state).toBe('running');
    expect((await callTool(runtime, 'dsh.session.respond_approval', { sessionId: 'session-test', pendingInteractionId: 'approval', outcome: 'rejected' }))).toMatchObject({ isError: true, structuredContent: { error: { code: 'pending-interaction-not-found' } } });

    const questionTurn = turns.register({ sessionId: 'session-test', sourceRef: 'rpc:question' });
    turns.transition(questionTurn.turnRef, { state: 'pending-human-input', reason: null, finalAnswer: null, pendingInteractionId: 'question' });
    pending.upsert({ pendingInteractionId: 'question', sessionId: 'session-test', turnRef: questionTurn.turnRef, kind: 'question', prompt: 'Choose', options: [], questions: [{ id: 'q', question: 'Choose', options: [{ label: 'yes' }], multiSelect: false }] });
    const answer = await callTool(runtime, 'dsh.session.answer_question', { sessionId: 'session-test', pendingInteractionId: 'question', answers: [{ id: 'q', selected: ['yes'] }] });
    expect(answer.structuredContent).toEqual({ sessionId: 'session-test', pendingInteractionId: 'question', accepted: true });
    expect(values).toEqual(['allowed-once', { answers: [{ id: 'q', selected: ['yes'] }] }]);
  });
});

async function listTools(): Promise<Array<Record<string, unknown>>> {
  const server = createMcpServer(createRuntime(loadConfig({ DSH_BASE_URL: 'http://127.0.0.1:3080/' })));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const messages: unknown[] = [];
  clientTransport.onmessage = (message) => messages.push(message);
  await server.connect(serverTransport);
  await clientTransport.start();
  await clientTransport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'coverage', version: '1' } } });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await clientTransport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const response = messages.find((message) => isRecord(message) && message.id === 2);
  await clientTransport.close();
  await server.close();
  const tools = isRecord(response) && isRecord(response.result) && Array.isArray(response.result.tools) ? response.result.tools : [];
  return tools.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectionRuntime(sessions: unknown[], workspaces: unknown) {
  return {
    rpc: { session: { list: async () => ({ ok: true, value: { items: sessions } }) } },
    events: { workspaceSnapshot: async () => workspaces },
    turns: new TurnStore(),
    pending: new PendingInteractionStore(),
    selectedSessionId: null,
  } as never;
}

async function callTool(runtime: Parameters<typeof createMcpServer>[0], name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const messages: Record<string, unknown>[] = [];
  clientTransport.onmessage = (message) => messages.push(message as Record<string, unknown>);
  await server.connect(serverTransport);
  await clientTransport.start();
  await clientTransport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'coverage', version: '1' } } });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await clientTransport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = messages.find((message) => message.id === 2)?.result as Record<string, unknown>;
  await clientTransport.close();
  await server.close();
  return result;
}
