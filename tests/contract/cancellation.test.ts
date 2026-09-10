import { testRuntime } from '../unit/fixtures.js';
import { describe, expect, it } from 'vitest';
import { TurnStore } from '../../src/domain/turns.js';
import { waitForTurn } from '../../src/mcp/actions/turns.js';

describe('observation cancellation', () => {
  it('releases active waits on MCP shutdown without cancelling DSH', async () => {
    let stopped = 0;
    let cancelled = 0;
    const runtime = testRuntime({
      events: { subscribeSession: () => () => { stopped += 1; } },
      rpc: { session: { cancel: async () => { cancelled += 1; return { ok: true, value: { accepted: true } }; } } },
    });
    const turn = runtime.turns.register({ sessionId: 'running', sourceRef: 'rpc:running' });
    const waiting = waitForTurn(runtime, turn.turnRef, 1_000, new AbortController().signal);
    runtime.observations.watch('another', () => undefined);
    runtime.observations.close();
    expect((await waiting).structuredContent).toMatchObject({ state: 'transport_lost' });
    expect(stopped).toBeGreaterThanOrEqual(2);
    expect(cancelled).toBe(0);
  });

  it.each(['abort', 'timeout'])('releases observation and cached-turn retention on %s without cancelling DSH', async (outcome) => {
    let unsubscribeCalls = 0;
    let dshCancelCalls = 0;
    const runtime = testRuntime({
      turns: new TurnStore(),
      rpc: { session: { cancel: async () => { dshCancelCalls += 1; return { ok: true, value: { accepted: true } }; } } },
      events: { subscribeSession: (_sessionId: string, _listener: unknown, _signal: AbortSignal) => { return () => { unsubscribeCalls += 1; }; } },
    });
    const record = runtime.turns.register({ sessionId: 'session-test', sourceRef: 'rpc:test' });
    const controller = new AbortController();
    const promise = waitForTurn(runtime, record.turnRef, outcome === 'timeout' ? 10 : 10_000, controller.signal);
    if (outcome === 'abort') {
      controller.abort();
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    } else {
      expect((await promise).structuredContent).toMatchObject({ state: 'timed_out' });
    }
    expect(unsubscribeCalls).toBeGreaterThanOrEqual(1);
    expect(dshCancelCalls).toBe(0);
    runtime.turns.observe('session-test', { turn: 1, requestIds: ['test'], state: 'completed', reason: null, finalResponse: 'finished after waiting stopped' });
    for (let turn = 1; turn <= 200; turn++) {
      runtime.turns.observe('other', { turn, requestIds: [], state: 'completed', reason: null, finalResponse: null });
    }
    expect(runtime.turns.get(record.turnRef)).toBeUndefined();
  });


});
