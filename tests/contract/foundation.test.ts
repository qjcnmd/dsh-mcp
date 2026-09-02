import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadConfig } from '../../src/config.js';
import { DshAuthSession } from '../../src/dsh/auth.js';
import { DshDomainError, DshProtocolError, DshTransportError } from '../../src/errors.js';
import { toolExecutionError } from '../../src/mcp/actions/common.js';
import { projectToolResult } from '../../src/mcp/result-projection.js';
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

  it('preserves structured values, emits concise text, and strips credential fields', () => {
    const longText = 'x'.repeat(5_000);
    const result = projectToolResult({
      items: Array.from({ length: 25 }, (_, index) => ({ index })),
      longText,
      nested: { ok: true, token: 'secret-token', cookie: 'session-cookie' },
    }, 'Projected result.');

    expect(result.structuredContent).toEqual({
      items: Array.from({ length: 25 }, (_, index) => ({ index })),
      longText,
      nested: { ok: true },
    });
    expect(result.content[0].text.length).toBeLessThan(500);
  });

  it('constructs one stable tool execution error', () => {
    expect(toolExecutionError('session-not-found', 'Missing session.', { sessionId: 'missing' })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Missing session.' }],
      structuredContent: {
        error: { code: 'session-not-found', message: 'Missing session.', target: { sessionId: 'missing' } },
      },
    });
  });

  it('rejects conflicting token sources before connecting', () => {
    expect(() => loadConfig({
      DSH_BASE_URL: 'http://127.0.0.1:3080/?token=url-token',
      DSH_AUTH_TOKEN: 'environment-token',
    })).toThrow('conflicts');
  });

  it('exchanges a launch token and refreshes one rejected cookie once', async () => {
    const calls: Array<{ url: string; cookie: string | null }> = [];
    let exchange = 0;
    let request = 0;
    const auth = new DshAuthSession(loadConfig({
      DSH_BASE_URL: 'http://127.0.0.1:3080/',
      DSH_AUTH_TOKEN: 'launch-token',
    }), async (input, init) => {
      const url = String(input);
      const cookie = new Headers(init?.headers).get('cookie');
      calls.push({ url, cookie });
      if (new URL(url).pathname === '/') {
        exchange += 1;
        return new Response(null, { status: 303, headers: { 'set-cookie': `dsh=session-${exchange}; Path=/` } });
      }
      request += 1;
      return new Response(null, { status: request === 1 ? 401 : 200 });
    });

    const response = await auth.fetch('http://127.0.0.1:3080/api/session/list');

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.cookie)).toEqual([null, 'dsh=session-1', null, 'dsh=session-2']);
    expect(calls.filter((call) => call.url.includes('token=launch-token'))).toHaveLength(2);
  });

  it.runIf(process.platform === 'win32')('discovers only the latest same-origin launcher token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-auth-'));
    const launcher = join(root, 'DeepSeekHarnessLauncher');
    const previousLocalAppData = process.env.LOCALAPPDATA;
    const previousFetch = globalThis.fetch;
    await mkdir(launcher);
    await writeFile(join(launcher, 'dsh-web.log'), [
      'dsh web: http://127.0.0.1:3080/?token=correct-token',
      'dsh web: http://localhost:3080/?token=wrong-origin',
    ].join('\n'));
    process.env.LOCALAPPDATA = root;
    let exchangeUrl = '';
    globalThis.fetch = (async (input) => {
      exchangeUrl = String(input);
      return new Response(null, { status: 303, headers: { 'set-cookie': 'dsh=discovered; Path=/' } });
    }) as typeof fetch;
    try {
      const auth = new DshAuthSession(loadConfig({ DSH_BASE_URL: 'http://127.0.0.1:3080/' }));
      expect(await auth.cookieHeader()).toBe('dsh=discovered');
      expect(exchangeUrl).toContain('token=correct-token');
      expect(exchangeUrl).not.toContain('wrong-origin');
    } finally {
      globalThis.fetch = previousFetch;
      if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousLocalAppData;
      await rm(root, { recursive: true, force: true });
    }
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
