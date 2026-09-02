import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { DshRpcClient } from '../../src/dsh/rpc-client.js';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { PendingInteractionStore } from '../../src/domain/pending-interactions.js';
import { TurnStore } from '../../src/domain/turns.js';
import { PageContextStore } from '../../src/domain/page-context.js';
import { createMcpServer } from '../../src/mcp/transport.js';
import { jsonResponse } from '../unit/fixtures.js';

const config = loadConfig({ DSH_BASE_URL: 'http://127.0.0.1:3080/' });

describe('current DSH RPC wire contract', () => {
  it('executes slash commands through commands/execute', async () => {
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

    const result = await client.commands.execute({ sessionId: 'session-test', line: '/compact now' });

    expect(result).toEqual({ ok: true, value: { commandId: 'command-1', result: { kind: 'success', text: 'done' } } });
    expect(url).toBe('http://127.0.0.1:3080/api/commands/execute');
    expect(body).toMatchObject({
      type: 'client-request',
      method: 'commands/execute',
      payload: { args: { agentId: 'session-test', line: '/compact now', images: [] } },
    });
  });

  it('uses one request identity for prompt admission and turn correlation', async () => {
    let body: Record<string, unknown> = {};
    const client = new DshRpcClient(config, async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } });
    });

    const response = await client.session.promptWithId({
      requestId: 'prompt-1',
      sessionId: 'session-test',
      mode: 'queue',
      content: [{ type: 'text', text: 'hello' }],
    });

    expect(response.result).toEqual({ ok: true, value: { accepted: true } });
    expect(body).toMatchObject({
      rpcId: response.rpcId,
      method: 'session/prompt',
      payload: { args: { request: { requestId: 'prompt-1', sessionId: 'session-test', mode: 'queue', content: [{ type: 'text', text: 'hello' }] } } },
    });
  });

  it('sends omitted mode as steer and preserves explicit queue', async () => {
    const modes: string[] = [];
    const runtime = {
      config,
      turns: new TurnStore(),
      pending: new PendingInteractionStore(),
      page: new PageContextStore(),
      rpc: { session: { promptWithId: async (request: { mode: string }) => { modes.push(request.mode); return { rpcId: crypto.randomUUID(), result: { ok: true, value: { accepted: true } } }; } } },
      events: {},
    } as never;
    const first = await callTool(runtime, { sessionId: 'session-test', message: 'first' });
    const second = await callTool(runtime, { sessionId: 'session-test', message: 'second', mode: 'queue' });

    expect(modes).toEqual(['steer', 'queue']);
    expect(first.structuredContent).toMatchObject({ accepted: true, mode: 'steer' });
    expect(second.structuredContent).toMatchObject({ accepted: true, mode: 'queue' });
  });

  it('returns the complete current session list without native continuation metadata', async () => {
    let body: Record<string, unknown> = {};
    const items = Array.from({ length: 25 }, (_, index) => ({ sessionId: `session-${index}`, updatedAt: index, running: false, blank: false }));
    const client = new DshRpcClient(config, async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { items } } });
    });

    const result = await client.session.list({ cursor: 'ignored-by-current-dsh' });
    expect(result).toEqual({ ok: true, value: { items } });
    expect(body).toMatchObject({ method: 'session/list', payload: { args: { _request: { cursor: 'ignored-by-current-dsh' } } } });
    expect(result.ok && Object.keys(result.value)).toEqual(['items']);
  });

  it('uses current wires for model selection, cancellation, and archive membership', async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new DshRpcClient(config, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const method = body.method;
      const value = method === 'session/selectModel' ? { selected: { provider: 'b-ai', model: 'qwen3.8-flash', reasoningEffort: 'high' } } : method === 'workspace/archiveSession' ? { archivedSessionIds: ['session-test'] } : { accepted: true };
      return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } });
    });
    await client.session.selectModel({ sessionId: 'session-test', provider: 'b-ai', model: 'qwen3.8-flash', reasoningEffort: 'high' });
    await client.session.cancel({ sessionId: 'session-test' });
    await client.workspace.archiveSession({ sessionId: 'session-test' });
    expect(bodies.map((body) => body.method)).toEqual(['session/selectModel', 'session/cancel', 'workspace/archiveSession']);
    expect(bodies[0]).toMatchObject({ payload: { args: { request: { sessionId: 'session-test', provider: 'b-ai', model: 'qwen3.8-flash', reasoningEffort: 'high' } } } });
    expect(bodies[1]).toMatchObject({ payload: { args: { request: { sessionId: 'session-test' } } } });
    expect(bodies[2]).toMatchObject({ payload: { args: { request: { sessionId: 'session-test' } } } });
  });

  it('returns tool errors for DSH command failures and unknown commands', async () => {
    let value: unknown = undefined;
    const runtime = {
      config,
      turns: new TurnStore(), pending: new PendingInteractionStore(), page: new PageContextStore(), events: {},
      rpc: { commands: { execute: async () => ({ ok: true, value }) } },
    } as never;
    const unknown = await callTool(runtime, { sessionId: 'session-test', command: '/missing' }, 'dsh.session.command');
    expect(unknown).toMatchObject({ isError: true, structuredContent: { error: { code: 'command-not-found' } } });
    value = { commandId: 'bad', result: { kind: 'error', text: 'failed command' } };
    const failed = await callTool(runtime, { sessionId: 'session-test', command: '/bad' }, 'dsh.session.command');
    expect(failed).toMatchObject({ isError: true, structuredContent: { error: { code: 'command-failed', message: 'failed command' } } });
    value = { commandId: 'ok', result: { kind: 'success', text: 'compacted' } };
    expect((await callTool(runtime, { sessionId: 'session-test' }, 'dsh.command.compact')).structuredContent).toEqual({ sessionId: 'session-test', compacted: true, message: 'compacted' });
  });
});

async function callTool(runtime: Parameters<typeof createMcpServer>[0], args: Record<string, unknown>, name = 'dsh.session.send_message'): Promise<Record<string, unknown>> {
  const server = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const messages: Record<string, unknown>[] = [];
  clientTransport.onmessage = (message) => messages.push(message as Record<string, unknown>);
  await server.connect(serverTransport);
  await clientTransport.start();
  await clientTransport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'wire', version: '1' } } });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await clientTransport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const response = messages.find((message) => message.id === 2);
  await clientTransport.close();
  await server.close();
  return response?.result as Record<string, unknown>;
}
