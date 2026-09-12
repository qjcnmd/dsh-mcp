import { callMcpTool, testRuntime, followSnapshot } from '../unit/fixtures.js';
import { DshDomainError, DshTransportError } from '../../src/errors.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { DshRpcClient } from '../../src/dsh/rpc-client.js';
import { TurnStore } from '../../src/domain/turns.js';
import { jsonResponse } from '../unit/fixtures.js';

const config = loadConfig({ DSH_BASE_URL: 'http://127.0.0.1:3080/' });

describe('current DSH RPC wire contract', () => {
  it('resolves a native workspace before creating its session', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new DshRpcClient(config, async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } });
    });
    await client.workspace.create('C:/project');
    await client.session.create({ workspaceId: 'project', agentPreset: 'minimal' });
    expect(bodies).toMatchObject([
      { method: 'workspace/create', payload: { args: { request: { path: 'C:/project' } } } },
      { method: 'session/create', payload: { args: { request: { workspaceId: 'project', agentPreset: 'minimal' } } } },
    ]);
  });
  it('sets full access through the native permission command', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    const client = new DshRpcClient(config, async (input, init) => {
      url = String(input);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { commandId: 'command-1', result: { kind: 'success', text: 'done' } } },
      });
    });

    await client.setFullAccess('session-test');

    expect(url).toBe('http://127.0.0.1:3080/api/commands/execute');
    expect(body).toMatchObject({
      type: 'client-request',
      method: 'commands/execute',
      payload: { args: { agentId: 'session-test', line: '/permission danger-full-access', submittedAttachments: [] } },
    });
  });

  it('uses one request identity for prompt admission and turn correlation', async () => {
    let body: Record<string, unknown> = {};
    const client = new DshRpcClient(config, async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } });
    });

    const response = await client.session.prompt({
      requestId: 'prompt-1',
      sessionId: 'session-test',
      content: [{ type: 'text', text: 'hello' }],
    });

    expect(response).toEqual({ ok: true, value: { accepted: true } });
    expect(body).toMatchObject({
      rpcId: expect.any(String),
      method: 'session/prompt',
      payload: { args: { request: { requestId: 'prompt-1', sessionId: 'session-test', mode: 'steer', content: [{ type: 'text', text: 'hello' }] } } },
    });
  });

  it('accepts task text and shared paths and rejects removed queue and attachment inputs', async () => {
    const messages: unknown[] = [];
    const runtime = testRuntime({
      turns: new TurnStore(),
      rpc: { session: { prompt: async (request) => { messages.push(request.content); return { ok: true, value: { accepted: true } }; } } },
      events: { sessionSnapshot: async () => followSnapshot() },
    });
    const message = 'Review ./src/example.ts and report the result.';
    const first = await callTool(runtime, { sessionId: 'session-test', message });
    expect(first.structuredContent).toMatchObject({ accepted: true });
    for (const args of [
      { message: 'second', mode: 'queue' },
      { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
    ]) expect(await callTool(runtime, { sessionId: 'session-test', ...args })).toMatchObject({ isError: true });
    expect(messages).toEqual([[{ type: 'text', text: message }]]);
  });

  it('returns the complete current session list without native continuation metadata', async () => {
    let body: Record<string, unknown> = {};
    const items = Array.from({ length: 25 }, (_, index) => ({ sessionId: `session-${index}`, updatedAt: index, running: false, blank: false }));
    const client = new DshRpcClient(config, async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { items } } });
    });

    const result = await client.session.list();
    expect(result).toEqual({ ok: true, value: { items } });
    expect(body).toMatchObject({ method: 'session/list', payload: { args: { _request: {} } } });
    expect(result.ok && Object.keys(result.value)).toEqual(['items']);
  });

  it('uses current wires for model selection, cancellation, and reasoning effort', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new DshRpcClient(config, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const method = body.method;
      const value = method === 'session/selectModel' ? { selected: { provider: 'b-ai', model: 'qwen3.8-flash', reasoningEffort: 'high' } } : { accepted: true };
      return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
    });
    await client.session.selectModel({ sessionId: 'session-test', provider: 'b-ai', model: 'qwen3.8-flash', reasoningEffort: 'high' });
    await client.session.cancel({ sessionId: 'session-test' });
    expect(bodies.map((body) => body.method)).toEqual(['session/selectModel', 'session/cancel']);
    expect(bodies[0]).toMatchObject({ payload: { args: { request: { sessionId: 'session-test', provider: 'b-ai', model: 'qwen3.8-flash', reasoningEffort: 'high' } } } });
    expect(bodies[1]).toMatchObject({ payload: { args: { request: { sessionId: 'session-test' } } } });
  });

  it.each(['uncertain', 'rejected'])('retains a stable retry identity for a %s submission', async (failure) => {
    let calls = 0;
    const runtime = testRuntime({ events: { sessionSnapshot: async () => followSnapshot() }, rpc: { session: { prompt: async () => {
      if (calls++ === 0) {
        if (failure === 'uncertain') throw new DshTransportError('Response lost');
        return { ok: false, error: new DshDomainError('model-unavailable', 'Select a model first') };
      }
      return { ok: true, value: { accepted: true } };
    } } } });
    const args = { sessionId: 'retry', requestId: 'stable-request', message: 'Hello' };
    const first = await callTool(runtime, args);
    const target = (first.structuredContent as { error: { target: { turnRef: string; requestId: string } } }).error.target;
    expect(target.requestId).toBe(args.requestId);
    expect(new TurnStore().restore(target.turnRef)).toMatchObject({ sessionId: 'retry', sourceRef: 'rpc:stable-request' });
    const retried = await callTool(runtime, args);
    expect(retried.structuredContent).toMatchObject({ turnRef: target.turnRef, requestId: args.requestId, accepted: true });
    expect(runtime.turns.get(target.turnRef)?.state).toBe('accepted');
  });

  it.each(['accepted', 'rejected'])('retains an in-flight submission under cache pressure until it is %s', async (outcome) => {
    let started: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let finish: () => void;
    const runtime = testRuntime({
      events: { sessionSnapshot: async () => followSnapshot() },
      rpc: { session: { prompt: () => new Promise((resolve) => {
        finish = () => resolve(outcome === 'accepted'
          ? { ok: true, value: { accepted: true } }
          : { ok: false, error: new DshDomainError('model-unavailable', 'Select a model first') });
        started();
      }) } },
    });
    const sending = callTool(runtime, { sessionId: 'in-flight', requestId: 'request', message: 'Hello' });
    await entered;
    for (let index = 0; index < 300; index++) runtime.turns.register({ sessionId: 'other', sourceRef: 'rpc:' + index });
    finish!();
    const result = await sending;
    expect(result.structuredContent).toMatchObject(outcome === 'accepted'
      ? { accepted: true, requestId: 'request' }
      : { error: { code: 'model-unavailable', target: { sessionId: 'in-flight', requestId: 'request' } } });
  });
});

function callTool(runtime: Parameters<typeof callMcpTool>[0], args: Record<string, unknown>, name = 'dsh.session.send_message') {
  return callMcpTool(runtime, name, args);
}
