import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { DshEventClient } from '../../src/dsh/event-client.js';
import { sseResponse } from './fixtures.js';

describe('DSH event client', () => {
  it('parses ordered mux and host SSE frames and stops on cancellation', async () => {
    const config = loadConfig({ DSH_BASE_URL: 'http://127.0.0.1:3080/' });
    const frames = [
      { type: 'server-request', rpcId: 'mux-1', method: 'events.mux', payload: { type: 'session/subscribed', sessionId: 'session-test', lastSeq: 0 } },
      { type: 'server-request', rpcId: 'host-1', method: 'events.host', payload: { type: 'host/session-status', sessionId: 'session-test', running: true } },
    ];
    let calls = 0;
    const client = new DshEventClient(config, async () => { calls += 1; return sseResponse(frames); });
    const received: Array<{ stream: string; order: number; method: string }> = [];
    const controller = new AbortController();
    const unsubscribe = client.subscribe((event) => received.push({ stream: event.stream, order: event.order, method: event.method }), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    unsubscribe();
    await client.stop();
    expect(calls).toBe(2);
    expect(received.length).toBe(4);
    expect(received.map((entry) => entry.order)).toEqual([1, 2, 3, 4]);
  });
});
