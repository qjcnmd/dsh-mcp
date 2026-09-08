import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig } from '../../src/config.js';
import { DshEventClient } from '../../src/dsh/event-client.js';
import { createRuntime } from '../../src/mcp/transport.js';
import { waitForTurn } from '../../src/mcp/actions/turns.js';
import { callMcpTool, jsonResponse } from './fixtures.js';

async function fixture() {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Missing test port');
  const streams = new Map<string, { socket: WebSocket; send: (value: unknown) => void }>();
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'open') return;
    const send = (value: unknown) => socket.send(JSON.stringify({ type: 'item', streamId: message.streamId, value }));
    streams.set(message.endpoint, { socket, send });
    if (message.endpoint === '$events') send({ type: 'ready', clientId: 'client' });
  }));
  const config = loadConfig({ DSH_BASE_URL: `http://127.0.0.1:${address.port}`, DSH_REQUEST_TIMEOUT_MS: '100' });
  const runtime = createRuntime(config);
  runtime.events = new DshEventClient(config, async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return jsonResponse({ type: 'server-response', rpcId: request.rpcId, result: { ok: true } });
  });
  const record = runtime.turns.register({ sessionId: 'session', sourceRef: 'dsh-turn:1' });
  const wait = () => waitForTurn(runtime, record.turnRef, 2_000, new AbortController().signal);
  const stream = async (endpoint: string) => {
    await vi.waitFor(() => expect(streams.has(endpoint)).toBe(true));
    return streams.get(endpoint)!;
  };
  return { runtime, record, wait, stream, close: async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

describe('event lifecycle across tool calls', () => {
  it.each(['cancel', 'respond'] as const)('releases an approval after %s and resumes the same turn', async (action) => {
    const f = await fixture();
    try {
      const waiting = f.wait();
      const remote = await f.stream('$events');
      remote.send({ type: 'waterfall', event: 'approval/request', eventId: 'approval', agentId: 'session', request: { toolName: 'shell' } });
      expect((await waiting).structuredContent).toMatchObject({ state: 'input_required' });
      if (action === 'cancel') remote.send({ type: 'cancel', eventId: 'approval' });
      else expect(await callMcpTool(f.runtime, 'dsh.session.respond_approval', { sessionId: 'session', pendingInteractionId: 'approval', outcome: 'allowed-once' })).toMatchObject({ structuredContent: { accepted: true } });
      await vi.waitFor(() => expect(f.runtime.pending.get('approval')).toBeUndefined());
      expect(f.runtime.turns.get(f.record.turnRef)?.state).toBe('running');
      await vi.waitFor(() => expect(remote.socket.readyState).toBe(3));
      const resumed = f.wait();
      await vi.waitFor(async () => expect((await f.stream('$events')).socket).not.toBe(remote.socket));
      const follow = await f.stream('session/follow');
      follow.send({ type: 'event', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
      expect((await resumed).structuredContent).toMatchObject({ state: 'completed' });
    } finally { await f.close(); }
  });

  it.each([false, true])('reports shared channel loss with pending input=%s', async (pending) => {
    const f = await fixture();
    try {
      const waiting = f.wait();
      const remote = await f.stream('$events');
      if (pending) {
        remote.send({ type: 'waterfall', event: 'user-questions/request', eventId: 'question', agentId: 'session', request: { questions: [{ id: 'q', question: 'Continue?' }] } });
        expect((await waiting).structuredContent).toMatchObject({ state: 'input_required' });
      }
      remote.socket.close();
      if (pending) await vi.waitFor(() => expect(f.runtime.pending.list()).toEqual([]));
      expect((await (pending ? f.wait() : waiting)).structuredContent).toMatchObject({ state: 'transport_lost' });
    } finally { await f.close(); }
  });

  it('bounds opening snapshots and preserves explicit cancellation', async () => {
    const f = await fixture();
    try {
      await expect(f.runtime.events.workspaceSnapshot()).rejects.toMatchObject({ code: 'transport-error', message: expect.stringContaining('timed out') });
      const controller = new AbortController();
      const snapshot = f.runtime.events.sessionSnapshot('session', 20, controller.signal);
      const rejection = expect(snapshot).rejects.toMatchObject({ name: 'AbortError' });
      await f.stream('session/follow');
      controller.abort();
      await rejection;
    } finally { await f.close(); }
  });

  it('keeps turn observation alive beyond the snapshot deadline', async () => {
    const f = await fixture();
    try {
      const waiting = f.wait();
      const follow = await f.stream('session/follow');
      await new Promise((resolve) => setTimeout(resolve, 150));
      follow.send({ type: 'event', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
      expect((await waiting).structuredContent).toMatchObject({ state: 'completed' });
    } finally { await f.close(); }
  });
});
