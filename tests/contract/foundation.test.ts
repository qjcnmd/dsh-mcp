import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadConfig } from '../../src/config.js';
import { DshDomainError, DshProtocolError, DshTransportError } from '../../src/errors.js';
import { createMcpServer } from '../../src/mcp/transport.js';
import { DshEventClient } from '../../src/dsh/event-client.js';
import { DshRpcClient } from '../../src/dsh/rpc-client.js';
import { jsonResponse } from '../unit/fixtures.js';

const config = loadConfig({ DSH_BASE_URL: 'http://127.0.0.1:3080/' });

describe('foundation contracts', () => {
  it('loads bounded loopback defaults', () => {
    expect(config.baseUrl.toString()).toBe('http://127.0.0.1:3080/');
    expect(config.requestTimeoutMs).toBeGreaterThan(0);
  });

  it('separates DSH domain rejection from transport and protocol failures', async () => {
    const body = { type: 'server-response', rpcId: 'placeholder', result: { ok: false, error: { code: 'session-not-found', message: 'missing', details: { sessionId: 'session-test' } } } };
    const client = new DshRpcClient(config, async (_input, _init) => {
      const request = JSON.parse(String(_init?.body)) as { rpcId: string };
      return jsonResponse({ ...body, rpcId: request.rpcId });
    });
    const result = await client.call('session/list', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(DshDomainError);

    const malformed = new DshRpcClient(config, async () => jsonResponse({ nope: true }));
    await expect(malformed.call('session/list', {})).rejects.toBeInstanceOf(DshProtocolError);

    const transport = new DshRpcClient(config, async () => { throw new Error('offline'); });
    await expect(transport.call('session/list', {})).rejects.toBeInstanceOf(DshTransportError);
  });

  it('does not read DSH until a caller explicitly subscribes', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return jsonResponse({}); };
    const runtime = { config, rpc: new DshRpcClient(config, fetchImpl), events: new DshEventClient(config, fetchImpl) };
    const server = createMcpServer(runtime);
    expect(calls).toBe(0);
    await server.close();
  });

  it('serves initialize and tools/list over the SDK transport', async () => {
    const runtime = { config, rpc: new DshRpcClient(config, async () => jsonResponse({})), events: new DshEventClient(config, async () => jsonResponse({})) };
    const server = createMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const messages: unknown[] = [];
    clientTransport.onmessage = (message) => messages.push(message);
    await server.connect(serverTransport);
    await clientTransport.start();
    await clientTransport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages.some((message) => isResponseFor(message, 1))).toBe(true);
    await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await clientTransport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const list = messages.find((message) => isResponseFor(message, 2)) as { result?: { tools?: unknown[] } } | undefined;
    expect(Array.isArray(list?.result?.tools)).toBe(true);
    await clientTransport.close();
    await server.close();
  });
});

function isResponseFor(value: unknown, id: number): boolean {
  return typeof value === 'object' && value !== null && (value as { id?: unknown }).id === id;
}
