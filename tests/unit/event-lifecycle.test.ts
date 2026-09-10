import { once } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig } from '../../src/config.js';
import { createRuntime } from '../../src/mcp/transport.js';
import { waitForTurn } from '../../src/mcp/actions/turns.js';
import { followSnapshot } from './fixtures.js';

async function fixture({ baseline = true, snapshot = followSnapshot([{ type: 'event', event: { seq: 0, type: 'turn/start', data: { turn: 1 } } }]) } = {}) {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('Missing test port');
  const streams: Array<{ socket: WebSocket; send: (value: unknown) => void }> = [];
  const endpoints: string[] = [];
  server.on('connection', (socket) => socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'open') return;
    endpoints.push(message.endpoint);
    const send = (value: unknown) => socket.send(JSON.stringify({ type: 'item', streamId: message.streamId, value }));
    streams.push({ socket, send });
    if (message.endpoint === 'session/follow' && baseline) send(snapshot);
  }));
  const runtime = createRuntime(loadConfig({ DSH_BASE_URL: `http://127.0.0.1:${address.port}`, DSH_REQUEST_TIMEOUT_MS: '100' }));
  const record = runtime.turns.register({ sessionId: 'session-test', sourceRef: 'dsh-turn:1' });
  const wait = () => waitForTurn(runtime, record.turnRef, 2_000, new AbortController().signal);
  const stream = async () => {
    const current = () => streams.filter((entry) => entry.socket.readyState === 1).at(-1);
    await vi.waitFor(() => expect(current()).toBeDefined());
    return current()!;
  };
  return { runtime, wait, stream, endpoints, close: async () => {
    runtime.observations.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

describe('session observation lifecycle', () => {
  it('uses only the conversation stream, survives the opening deadline, and releases it on completion', async () => {
    const f = await fixture({ snapshot: followSnapshot([{ type: 'event', event: { seq: 0, type: 'turn/start', data: { turn: 1 } } }], { header: { cwd: join(process.cwd(), '..') } }) });
    try {
      expect((await f.runtime.events.sessionSnapshot('session-test')).header.cwd).toBe(join(process.cwd(), '..'));
      const waiting = f.wait();
      await vi.waitFor(() => expect(f.endpoints).toHaveLength(2));
      const follow = await f.stream();
      await new Promise((resolve) => setTimeout(resolve, 150));
      follow.send({ type: 'event', event: { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
      expect((await waiting).structuredContent).toMatchObject({ state: 'completed' });
      expect(f.endpoints).toEqual(['session/follow', 'session/follow']);
      await vi.waitFor(() => expect(follow.socket.readyState).toBe(3));
    } finally { await f.close(); }
  });

  it('recovers after a lost stream and can resume on a later wait', async () => {
    const f = await fixture();
    try {
      const waiting = f.wait();
      const first = await f.stream();
      first.socket.close();
      expect((await waiting).structuredContent).toMatchObject({ state: 'transport_lost' });
      const previousConnections = f.endpoints.length;
      const resumed = f.wait();
      await vi.waitFor(() => expect(f.endpoints.length).toBeGreaterThan(previousConnections));
      const follow = await f.stream();
      follow.send({ type: 'event', event: { seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
      expect((await resumed).structuredContent).toMatchObject({ state: 'completed' });
    } finally { await f.close(); }
  });

  it.each([
    { projections: { asOfSeq: 0, values: { agentPreset: 'standard' } } },
    { projections: { asOfSeq: 0, values: { permissions: { currentValue: 'workspace-write' } } } },
  ])('rejects incompatible existing session snapshots: %j', async (overrides) => {
    const f = await fixture({ snapshot: followSnapshot([], overrides) });
    try {
      await expect(f.runtime.events.sessionSnapshot('session-test')).rejects.toMatchObject({ code: 'unsupported-session' });
      expect((await f.wait()).structuredContent).toMatchObject({ error: { code: 'unsupported-session' } });
    } finally { await f.close(); }
  });

  it('bounds opening snapshots and preserves caller cancellation', async () => {
    const f = await fixture({ baseline: false });
    try {
      await expect(f.runtime.events.archivedSessionIds()).rejects.toMatchObject({ code: 'transport-error', message: expect.stringContaining('timed out') });
      const controller = new AbortController();
      const snapshot = f.runtime.events.sessionSnapshot('session-test', 20, controller.signal);
      const rejection = expect(snapshot).rejects.toMatchObject({ name: 'AbortError' });
      await f.stream();
      controller.abort();
      await rejection;
    } finally { await f.close(); }
  });
});
