import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { loadConfig } from '../../src/config.js';
import { DshEventClient } from '../../src/dsh/event-client.js';
import { jsonResponse } from './fixtures.js';

describe('DSH Remote stream client', () => {
  it('reads opening baselines and carries one targeted question response', async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('test WebSocket server has no TCP port');

    const opens: Array<Record<string, unknown>> = [];
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type !== 'open' || typeof message.streamId !== 'string') return;
        opens.push(message);
        if (message.endpoint === 'workspace/follow') {
          socket.send(JSON.stringify({ type: 'item', streamId: message.streamId, value: { type: 'baseline', value: { items: [{ workspaceId: 'workspace-test', sessionIds: ['session-test'] }], archivedSessionIds: [] } } }));
          return;
        }
        if (message.endpoint === 'session/follow') {
          socket.send(JSON.stringify({ type: 'item', streamId: message.streamId, value: { type: 'snapshot', header: { id: 'session-test' }, cursor: 2, records: [], hasMore: false, projections: { asOfSeq: 2, values: {} } } }));
          return;
        }
        if (message.endpoint === '$events') {
          socket.send(JSON.stringify({ type: 'item', streamId: message.streamId, value: { type: 'ready', clientId: 'client-test', host: { home: '/home/test' } } }));
          socket.send(JSON.stringify({ type: 'item', streamId: message.streamId, value: { type: 'waterfall', event: 'user-questions/request', eventId: 'question-test', agentId: 'session-test', request: { questions: [{ id: 'choice', question: 'Continue?', options: [{ label: 'yes' }] }] } } }));
        }
      });
    });

    const rpcBodies: Array<Record<string, unknown>> = [];
    const config = loadConfig({ DSH_BASE_URL: `http://127.0.0.1:${address.port}/` });
    const client = new DshEventClient(config, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      rpcBodies.push(body);
      return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true } });
    });

    const workspace = await client.workspaceSnapshot();
    expect(workspace.items[0]?.workspaceId).toBe('workspace-test');

    const events: string[] = [];
    const unsubscribe = client.subscribeSession('session-test', (event) => events.push(event.method));
    await waitFor(() => events.includes('user-questions/request'));
    const response = await client.respondRemoteInteraction('question-test', { answers: [{ id: 'choice', selected: ['yes'] }] });
    expect(response.ok).toBe(true);
    expect(rpcBodies).toHaveLength(1);
    expect(rpcBodies[0]).toMatchObject({ method: '$events/result', payload: { args: { clientId: 'client-test', eventId: 'question-test', outcome: { kind: 'result' } } } });
    expect(opens.map((open) => open.endpoint)).toEqual(expect.arrayContaining(['workspace/follow', 'session/follow', '$events']));

    unsubscribe();
    await client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for test event');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
