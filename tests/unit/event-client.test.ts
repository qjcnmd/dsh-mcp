import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { loadConfig } from '../../src/config.js';
import { DshEventClient } from '../../src/dsh/event-client.js';

describe('DSH Remote stream client', () => {
  it('refreshes a rejected WebSocket cookie once and preserves business errors', async () => {
    let exchanges = 0;
    let expectedCookie = 'dsh=session-1';
    const server = new WebSocketServer({ port: 0, verifyClient: (info, done) => done(info.req.headers.cookie === expectedCookie, 401, 'Unauthorized') });
    await once(server, 'listening');
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('Missing test port');
    server.on('connection', (socket) => socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.type !== 'open') return;
      if (request.endpoint === 'session/follow' && request.payload.args.request.address.sessionId === 'malformed') socket.send(JSON.stringify({ type: 'item', streamId: request.streamId, value: { type: 'snapshot', records: [] } }));
      else if (request.endpoint === 'session/follow') socket.send(JSON.stringify({ type: 'error', streamId: request.streamId, error: { code: 'session/not-found', message: 'Missing test session', details: { sessionId: 'missing' } } }));
      else socket.send(JSON.stringify({ type: 'item', streamId: request.streamId, value: { type: 'baseline', value: { items: [], archivedSessionIds: [] } } }));
    }));
    const client = new DshEventClient(loadConfig({ DSH_BASE_URL: `http://127.0.0.1:${address.port}/`, DSH_AUTH_TOKEN: 'test-token' }), async () => new Response(null, { status: 303, headers: { 'set-cookie': `dsh=session-${++exchanges}; Path=/` } }));
    try {
      await client.archivedSessionIds();
      expectedCookie = 'dsh=session-2';
      expect(await client.archivedSessionIds()).toEqual([]);
      expect(exchanges).toBe(2);
      await expect(client.sessionSnapshot('missing')).rejects.toMatchObject({ dshCode: 'session/not-found', message: 'Missing test session' });
      await expect(client.sessionSnapshot('malformed')).rejects.toMatchObject({ code: 'protocol-error', message: 'DSH returned an invalid session snapshot' });
      expectedCookie = 'reject-every-cookie';
      await expect(client.archivedSessionIds()).rejects.toMatchObject({ code: 'transport-error', status: 401 });
      expect(exchanges).toBe(3);
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


});
