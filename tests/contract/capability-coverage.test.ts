import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { DshSessionSummary } from '../../src/dsh/rpc-client.js';
import { DshDomainError, DshMcpError } from '../../src/errors.js';
import { callMcpTool, followSnapshot, mcpRequest, testRuntime } from '../unit/fixtures.js';

const tools = ['list', 'create', 'models', 'select_model', 'send_message', 'wait_turn', 'cancel'].map((name) => 'dsh.session.' + name);

describe('minimal project tool surface', () => {
  it('preserves domain error details consistently and adds each tool’s target identifiers', async () => {
    const error = new DshDomainError('provider/unavailable', 'Provider unavailable', { provider: 'b-ai', retryable: true, sessionId: 'untrusted-target' });
    const runtime = testRuntime({
      rpc: { session: {
        modelCatalog: async () => ({ ok: false, error }),
        selectModel: async () => ({ ok: false, error }),
        prompt: async () => ({ ok: false, error }),
        cancel: async () => ({ ok: false, error }),
      } },
      events: { sessionSnapshot: async () => followSnapshot() },
    });
    for (const [name, args] of [
      ['models', {}],
      ['select_model', { sessionId: 'session', provider: 'b-ai', model: 'm' }],
      ['send_message', { sessionId: 'session', requestId: 'request', message: 'go' }],
      ['cancel', { sessionId: 'session' }],
    ] as const) {
      const result = await callMcpTool(runtime, 'dsh.session.' + name, args);
      expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'provider/unavailable', target: { provider: 'b-ai', retryable: 'true' } } } });
      if (name !== 'models') {
        expect(result.structuredContent).toMatchObject({ error: { target: { sessionId: 'session' } } });
      }
      if (name === 'send_message') {
        expect(result.structuredContent).toMatchObject({ error: { target: { requestId: 'request', turnRef: expect.any(String) } } });
      }
    }
  });

  it('exposes seven project tools with portable output schemas and model efforts', async () => {
    const result = await mcpRequest(testRuntime(), 'tools/list', {});
    const listed = result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> }; outputSchema: { oneOf: unknown[] }; annotations: unknown }>;
    expect(listed.map((tool) => tool.name)).toEqual(tools);
    for (const tool of listed) {
      expect(tool.outputSchema.oneOf).toHaveLength(2);
      expect(tool.annotations).toBeDefined();
    }
    const input = (name: string) => listed.find((tool) => tool.name === 'dsh.session.' + name)!.inputSchema.properties;
    expect(input('create').cwd).toMatchObject({ type: 'string' });
    expect(input('list').limit).toMatchObject({ default: 20, maximum: 50 });
    expect(input('select_model').reasoningEffort).toBeDefined();
    expect(input('send_message').mode).toBeUndefined();
    expect(input('send_message').content).toBeUndefined();
    expect(input('wait_turn').timeoutMs).toBeUndefined();
  });

  it('pages through the current project and explains unsupported presets', async () => {
    const sessions: DshSessionSummary[] = Array.from({ length: 105 }, (_, index) => ({
      sessionId: 'session-' + index, updatedAt: Math.floor(index / 2), running: false, blank: true,
      cwd: process.cwd(), projections: followSnapshot().projections,
    }));
    sessions.push(
      { sessionId: 'another-project', updatedAt: 999, running: false, blank: true, cwd: join(process.cwd(), '..') },
      { sessionId: 'child', parentSessionId: 'session-1', updatedAt: 998, running: true, blank: false, cwd: process.cwd() },
      { sessionId: 'standard', updatedAt: 997, running: false, blank: true, cwd: process.cwd(), projections: followSnapshot([], { projections: { asOfSeq: 0, values: { agentPreset: 'standard' } } }).projections },
    );
    const runtime = testRuntime({
      rpc: { session: { list: async () => ({ ok: true, value: { items: sessions } }) } },
      events: { archivedSessionIds: async () => ['session-0'] },
    });
    const result = await callMcpTool(runtime, 'dsh.session.list', { cwd: process.cwd() });
    type Page = { cwd: string; items: Array<{ sessionId: string; unsupportedReason: string | null }>; hasMore: boolean; nextCursor: string | null };
    const value = result.structuredContent as Page;
    expect(value.cwd).toBe(process.cwd());
    expect(value.items).toHaveLength(20);
    expect(value.items[0]).toMatchObject({ sessionId: 'standard', unsupportedReason: expect.stringContaining('minimal') });
    expect(value.items.slice(1).every((item) => item.unsupportedReason === null)).toBe(true);
    const all = [...value.items];
    let cursor = value.nextCursor;
    expect(value.hasMore).toBe(true);
    sessions.push({ sessionId: 'newer', updatedAt: 1000, running: false, blank: true, cwd: process.cwd(), projections: followSnapshot().projections });
    while (cursor !== null) {
      const page = (await callMcpTool(runtime, 'dsh.session.list', { cwd: process.cwd(), cursor, limit: 50 })).structuredContent as Page;
      all.push(...page.items);
      expect(page.hasMore).toBe(page.nextCursor !== null);
      cursor = page.nextCursor;
    }
    expect(all).toHaveLength(105);
    expect(new Set(all.map((item) => item.sessionId)).size).toBe(105);
    expect(all.some((item) => ['another-project', 'child', 'session-0', 'newer'].includes(item.sessionId))).toBe(false);
    expect(await callMcpTool(runtime, 'dsh.session.list', { cwd: process.cwd(), cursor: 'invalid' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid-cursor' } } });
    const otherDirectory = join(process.cwd(), '..');
    expect((await callMcpTool(runtime, 'dsh.session.list', { cwd: otherDirectory })).structuredContent).toMatchObject({ cwd: otherDirectory, items: [{ sessionId: 'another-project' }] });
    expect(await callMcpTool(runtime, 'dsh.session.list', { cwd: otherDirectory, cursor: value.nextCursor })).toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid-cursor' } } });
  });

  it('creates minimal through the native workspace and verifies membership and full access', async () => {
    const calls: unknown[] = [];
    const cwd = join(process.cwd(), '..');
    const workspace = { workspaceId: 'workspace-1', path: cwd, title: 'Project', sessionIds: ['new'] };
    const runtime = testRuntime({
      rpc: {
        workspace: { create: async (path) => { calls.push(['workspace', path]); return { ok: true, value: { workspace, created: false } }; } },
        session: { create: async (request) => { calls.push(request); return { ok: true, value: { sessionId: 'new' } }; } },
        setFullAccess: async (sessionId) => { calls.push(['permission', sessionId]); },
      },
      events: {
        sessionSnapshot: async (sessionId) => { calls.push(['verify', sessionId]); return followSnapshot(); },
        workspaceSnapshot: async () => ({ items: [workspace], archivedSessionIds: [] }),
      },
    });
    expect((await callMcpTool(runtime, 'dsh.session.create', { cwd })).structuredContent).toEqual({ sessionId: 'new', cwd, workspaceId: workspace.workspaceId });
    expect(calls).toEqual([['workspace', cwd], { workspaceId: workspace.workspaceId, agentPreset: 'minimal' }, ['permission', 'new'], ['verify', 'new']]);
    workspace.sessionIds = [];
    expect(await callMcpTool(runtime, 'dsh.session.create', { cwd })).toMatchObject({ isError: true, structuredContent: { error: { code: 'session-setup-failed', target: { sessionId: 'new', workspaceId: 'workspace-1' } } } });
    runtime.rpc.setFullAccess = async () => { throw new Error('permission unavailable'); };
    expect(await callMcpTool(runtime, 'dsh.session.create', { cwd })).toMatchObject({ isError: true, structuredContent: { error: { code: 'session-setup-failed', target: { sessionId: 'new' } } } });
  });

  it('does not create an ungrouped session when workspace registration fails', async () => {
    const runtime = testRuntime({ rpc: { workspace: { create: async () => ({ ok: false, error: new DshDomainError('workspace/invalid-path', 'Unavailable directory') }) } } });
    expect(await callMcpTool(runtime, 'dsh.session.create', { cwd: process.cwd() })).toMatchObject({ isError: true, structuredContent: { error: { code: 'workspace/invalid-path' } } });
  });

  it('requires an absolute workspace and rejects a file before creating a session', async () => {
    const runtime = testRuntime();
    for (const name of ['list', 'create']) {
      for (const args of [{}, { cwd: '.' }]) {
        expect(await callMcpTool(runtime, 'dsh.session.' + name, args)).toMatchObject({ isError: true });
      }
    }
    expect(await callMcpTool(runtime, 'dsh.session.create', { cwd: join(process.cwd(), 'package.json') })).toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid-directory' } } });
  });

  it('does not mutate an unsupported existing session', async () => {
    let writes = 0;
    const runtime = testRuntime({
      rpc: { session: {
        prompt: async () => { writes++; return { ok: true, value: { accepted: true } }; },
        cancel: async () => { writes++; return { ok: true, value: { accepted: true } }; },
        selectModel: async () => { writes++; return { ok: true, value: { selected: { provider: 'b-ai', model: 'm' } } }; },
      } },
      events: { sessionSnapshot: async () => { throw new DshMcpError('unsupported-session', 'Unsupported preset'); } },
    });
    for (const [name, args] of [
      ['send_message', { sessionId: 'other', message: 'go' }],
      ['cancel', { sessionId: 'other' }],
      ['select_model', { sessionId: 'other', provider: 'b-ai', model: 'm' }],
    ] as const) expect(await callMcpTool(runtime, 'dsh.session.' + name, args)).toMatchObject({ isError: true, structuredContent: { error: { code: 'unsupported-session' } } });
    expect(writes).toBe(0);
  });

  it('returns model efforts, defaults, provider failures and the effective session selection', async () => {
    const runtime = testRuntime({
      rpc: { session: {
        modelCatalog: async () => ({ ok: true, value: {
          default: { provider: 'b-ai', model: 'm', reasoningEffort: 'low' }, routableProviders: ['b-ai'],
          failures: [{ id: 'down', name: 'Unavailable provider', message: 'offline' }],
          groups: [{ id: 'b-ai', models: [{ id: 'm', name: 'Model', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } }] }],
        } }),
        selectModel: async (request) => ({ ok: true, value: { selected: request } }),
      } },
      events: { sessionSnapshot: async () => followSnapshot([], { projections: { asOfSeq: 0, values: { modelSelection: { next: { provider: 'b-ai', model: 'm', reasoningEffort: 'high' } } } } }) },
    });
    const catalog = await callMcpTool(runtime, 'dsh.session.models', {});
    expect(catalog.structuredContent).toMatchObject({ selectionSource: 'default', selection: { reasoningEffort: 'low' }, models: [{ reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }], failures: [{ message: 'offline' }] });
    const session = await callMcpTool(runtime, 'dsh.session.models', { sessionId: 'existing' });
    expect(session.structuredContent).toMatchObject({ selectionSource: 'session', selection: { reasoningEffort: 'high' } });
    expect((await callMcpTool(runtime, 'dsh.session.select_model', { sessionId: 'existing', provider: 'b-ai', model: 'm', reasoningEffort: 'low' })).structuredContent).toMatchObject({ selected: { reasoningEffort: 'low' } });
  });
});
