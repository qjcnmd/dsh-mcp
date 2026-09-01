import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { DshEvent as Event } from '../../src/dsh/event-client.js';
import { PendingInteractionStore } from '../../src/domain/pending-interactions.js';
import { TurnStore } from '../../src/domain/turns.js';
import { classifyHistoryTurn } from '../../src/dsh/recovery.js';
import { observeEvent, waitForTurn } from '../../src/mcp/actions/turns.js';

describe('turn lifecycle projection', () => {
  it('correlates DSH turn numbers and preserves the final assistant answer', () => {
    const runtime = makeRuntime();
    const record = runtime.turns.register({ sessionId: 'session-test', sourceRef: 'rpc:prompt-1' });
    observeEvent(runtime, event('mux-1', { type: 'session/event', sessionId: 'session-test', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 7 } } }));
    observeEvent(runtime, event('mux-2', { type: 'session/event', sessionId: 'session-test', event: { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'user', rpcId: 'prompt-1' }, content: [{ type: 'text', text: 'go' }] } } }));
    observeEvent(runtime, event('mux-3', { type: 'session/event', sessionId: 'session-test', event: { type: 'assistant/message', seq: 3, time: 3, data: { turn: 7, message: { content: [{ type: 'text', text: 'done' }] } } } }));
    observeEvent(runtime, event('mux-4', { type: 'session/event', sessionId: 'session-test', event: { type: 'turn/end', seq: 4, time: 4, data: { turn: 7, reason: { kind: 'completed' } } } }));
    const result = runtime.turns.get(record.turnRef)!;
    expect(result.sourceRef).toBe('dsh-turn:7');
    expect(result.state).toBe('completed');
    expect(result.finalAnswer).toBe('done');
    expect(result.evidence).toBe('event');
  });

  it('classifies failure, cancellation, and returns an answerable pending question without polling', async () => {
    const runtime = makeRuntime();
    const failed = runtime.turns.register({ sessionId: 'session-failed', sourceRef: 'rpc:failed' });
    observeEvent(runtime, event('f-1', { type: 'session/event', sessionId: 'session-failed', event: { type: 'turn/start', data: { turn: 1 } } }));
    observeEvent(runtime, event('f-2', { type: 'session/event', sessionId: 'session-failed', event: { type: 'user/message', data: { source: { kind: 'user', rpcId: 'failed' } } } }));
    observeEvent(runtime, event('f-3', { type: 'session/event', sessionId: 'session-failed', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } } }));
    expect(runtime.turns.get(failed.turnRef)?.state).toBe('failed');

    const cancelled = runtime.turns.register({ sessionId: 'session-cancelled', sourceRef: 'rpc:cancelled' });
    observeEvent(runtime, event('c-1', { type: 'session/event', sessionId: 'session-cancelled', event: { type: 'turn/start', data: { turn: 2 } } }));
    observeEvent(runtime, event('c-2', { type: 'session/event', sessionId: 'session-cancelled', event: { type: 'user/message', data: { source: { kind: 'user', rpcId: 'cancelled' } } } }));
    observeEvent(runtime, event('c-3', { type: 'session/event', sessionId: 'session-cancelled', event: { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } } }));
    expect(runtime.turns.get(cancelled.turnRef)?.state).toBe('cancelled');

    const pending = runtime.turns.register({ sessionId: 'session-question', sourceRef: 'rpc:question' });
    observeEvent(runtime, event('q-1', { type: 'remote/invocation', sessionId: 'session-question', request: { questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'yes', description: 'Proceed' }] }] } }, 'user-questions/request'));
    expect(runtime.turns.get(pending.turnRef)?.state).toBe('pending-human-input');
    expect(runtime.pending.get('q-1')?.kind).toBe('question');
    expect(runtime.pending.get('q-1')?.questions).toEqual([{ id: 'q', question: 'Continue?', options: [{ label: 'yes', description: 'Proceed' }], multiSelect: false }]);
    const waited = await waitForTurn(runtime, pending.turnRef, 100, new AbortController().signal);
    expect(waited.structuredContent).toMatchObject({
      state: 'pending-human-input',
      pendingInteraction: {
        pendingInteractionId: 'q-1',
        questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'yes' }] }],
      },
    });
  });

  it('ignores unrelated and duplicate terminal events', () => {
    const runtime = makeRuntime();
    const record = runtime.turns.register({ sessionId: 'session-test', sourceRef: 'rpc:prompt-2' });
    observeEvent(runtime, event('u-1', { type: 'session/event', sessionId: 'other', event: { type: 'turn/start', data: { turn: 1 } } }));
    expect(runtime.turns.get(record.turnRef)?.state).toBe('accepted');
    observeEvent(runtime, event('s-1', { type: 'session/event', sessionId: 'session-test', event: { type: 'turn/start', data: { turn: 1 } } }));
    observeEvent(runtime, event('s-2', { type: 'session/event', sessionId: 'session-test', event: { type: 'user/message', data: { source: { kind: 'user', rpcId: 'prompt-2' } } } }));
    observeEvent(runtime, event('s-3', { type: 'session/event', sessionId: 'session-test', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } }));
    observeEvent(runtime, event('s-4', { type: 'session/event', sessionId: 'session-test', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'late' } } } } }));
    expect(runtime.turns.get(record.turnRef)?.state).toBe('completed');
  });

  it('recovers only the turn whose prompt request identity matches', () => {
    const projection = classifyHistoryTurn({
      records: [
        historyEvent('turn/start', { turn: 1 }),
        historyEvent('user/message', { source: { kind: 'user', rpcId: 'older-prompt' } }),
        historyEvent('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'older answer' }] } }),
        historyEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
        historyEvent('turn/start', { turn: 2 }),
        historyEvent('user/message', { source: { kind: 'user', rpcId: 'wanted-prompt' } }),
        historyEvent('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'wanted answer' }] } }),
        historyEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }),
      ],
      hasMore: false,
    }, 'turn-ref', 'session-test', 'rpc:wanted-prompt');

    expect(projection?.state).toBe('completed');
    expect(projection?.finalAnswer).toBe('wanted answer');
  });
});

function makeRuntime() {
  return { config: loadConfig({ DSH_BASE_URL: 'http://127.0.0.1:3080/' }), turns: new TurnStore(), pending: new PendingInteractionStore(), rpc: { session: { history: async () => ({ ok: false, error: { dshCode: 'not-called', message: 'not called' } }) } }, events: { subscribe: () => () => undefined } } as never;
}

function event(rpcId: string, payload: unknown, method = 'session/follow'): Event {
  return { stream: 'mux', rpcId, method, payload, order: 1, receivedAt: new Date().toISOString() };
}

function historyEvent(type: string, data: Record<string, unknown>) {
  return { type: 'event' as const, event: { type, data } };
}
