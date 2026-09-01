import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { PendingInteractionStore } from '../../src/domain/pending-interactions.js';
import { TurnStore } from '../../src/domain/turns.js';
import { waitForTurn } from '../../src/mcp/actions/turns.js';

describe('observation cancellation', () => {
  it('releases MCP observation without invoking DSH cancellation', async () => {
    let unsubscribeCalls = 0;
    let dshCancelCalls = 0;
    const runtime = {
      config: loadConfig({ DSH_BASE_URL: 'http://127.0.0.1:3080/' }),
      turns: new TurnStore(),
      pending: new PendingInteractionStore(),
      rpc: { session: { cancel: async () => { dshCancelCalls += 1; return { ok: true, value: { accepted: true } }; } } },
      events: { subscribeSession: (_sessionId: string, _listener: unknown, _signal: AbortSignal) => { return () => { unsubscribeCalls += 1; }; } },
    } as never;
    const record = runtime.turns.register({ sessionId: 'session-test', sourceRef: 'rpc:test' });
    const controller = new AbortController();
    const promise = waitForTurn(runtime, record.turnRef, 10_000, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(unsubscribeCalls).toBeGreaterThanOrEqual(1);
    expect(dshCancelCalls).toBe(0);
  });
});
