import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { DshRpcClient } from '../../src/dsh/rpc-client.js';
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
});
