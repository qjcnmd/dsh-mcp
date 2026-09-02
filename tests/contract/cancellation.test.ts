import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { PendingInteractionStore } from '../../src/domain/pending-interactions.js';
import { TurnStore } from '../../src/domain/turns.js';
import { waitForTurn } from '../../src/mcp/actions/turns.js';
import type { DshEvent } from '../../src/dsh/event-client.js';

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

  it('resumes waiting with the same turnRef after required input is resolved', async () => {
    let listener: ((event: DshEvent) => void) | undefined;
    const turns = new TurnStore();
    const pending = new PendingInteractionStore();
    const runtime = {
      config: loadConfig({ DSH_BASE_URL: 'http://127.0.0.1:3080/' }), turns, pending,
      rpc: {}, events: { subscribeSession: (_sessionId: string, next: (event: DshEvent) => void) => { listener = next; return () => undefined; } },
    } as never;
    const record = turns.register({ sessionId: 'session-test', sourceRef: 'dsh-turn:1' });
    pending.upsert({ pendingInteractionId: 'question', sessionId: 'session-test', turnRef: record.turnRef, kind: 'question', prompt: 'Continue?', options: [], questions: [{ id: 'q', question: 'Continue?', options: [], multiSelect: false }] });
    turns.transition(record.turnRef, { state: 'pending-human-input', reason: null, finalAnswer: null, pendingInteractionId: 'question' });
    expect((await waitForTurn(runtime, record.turnRef, 100, new AbortController().signal)).structuredContent).toMatchObject({ state: 'input_required' });

    turns.resolveInteraction('question');
    pending.remove('question');
    const resumed = waitForTurn(runtime, record.turnRef, 100, new AbortController().signal);
    listener!({ stream: 'mux', rpcId: '', method: 'session/follow', payload: { type: 'session/event', sessionId: 'session-test', event: { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, message: { content: [{ type: 'text', text: 'finished' }] } } } } });
    listener!({ stream: 'mux', rpcId: '', method: 'session/follow', payload: { type: 'session/event', sessionId: 'session-test', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } } });
    expect(await resumed).toMatchObject({ structuredContent: { state: 'completed', turnRef: record.turnRef }, content: [{ type: 'text', text: 'finished' }] });
  });
});
