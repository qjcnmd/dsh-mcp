import { testRuntime, followSnapshot } from '../unit/fixtures.js';
import { callMcpTool } from '../unit/fixtures.js';
import { describe, expect, it } from 'vitest';
import type { DshEvent as Event } from '../../src/dsh/event-client.js';
import { TurnStore } from '../../src/domain/turns.js';
import { SessionHistory } from '../../src/dsh/session-history.js';
import { waitForTurn } from '../../src/mcp/actions/turns.js';

describe('turn lifecycle projection', () => {
  it('evicts old completed turns and their aliases while preserving active and retried submissions', () => {
    const store = new TurnStore();
    const receipt = store.register({ sessionId: 'old', sourceRef: 'rpc:old' });
    const completed = store.observe('old', { turn: 1, requestIds: ['old'], state: 'completed', reason: null, finalResponse: 'old answer' });
    const pending = store.register({ sessionId: 'pending', sourceRef: 'rpc:pending' });
    store.reject(pending.turnRef, 'temporarily unavailable');
    store.accept(pending.turnRef);
    const running = store.observe('running', { turn: 1, requestIds: [], state: 'running', reason: null, finalResponse: null });

    for (let turn = 1; turn <= 1_000; turn++) {
      store.observe('recent', { turn, requestIds: [], state: 'completed', reason: null, finalResponse: 'answer ' + turn });
    }

    expect(store.get(receipt.turnRef)).toBeUndefined();
    expect(store.get(completed.turnRef)).toBeUndefined();
    expect(store.latest('old')).toBeUndefined();
    expect(store.latest('recent')?.sourceRef).toBe('dsh-turn:1000');
    expect(store.get(pending.turnRef)?.state).toBe('accepted');
    expect(store.get(running.turnRef)?.state).toBe('running');
    expect(store.restore(receipt.turnRef)).toMatchObject({ sessionId: 'old', sourceRef: 'rpc:old', state: 'accepted' });
  });

  it('retains steering aliases through large history hydration and recovers them after eviction', async () => {
    let listener: (event: Event) => void;
    const runtime = testRuntime({ events: { subscribeSession: (_id, next) => { listener = next; return () => undefined; } } });
    const first = runtime.turns.register({ sessionId: 'history', sourceRef: 'rpc:first' });
    const second = runtime.turns.register({ sessionId: 'history', sourceRef: 'rpc:second' });
    const records = [
      record(0, 'turn/start', { turn: 1 }),
      record(1, 'user/message', { source: { kind: 'user', rpcId: 'first' } }),
      record(2, 'user/message', { source: { kind: 'user', rpcId: 'second' } }),
      record(3, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'original answer' }] } }, 'append'),
      record(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ];
    for (let turn = 2; turn <= 200; turn++) {
      records.push(record(records.length, 'turn/start', { turn }));
      records.push(record(records.length, 'turn/end', { turn, reason: { kind: 'completed' } }));
    }
    const waits = [first, second].map(({ turnRef }) => waitForTurn(runtime, turnRef, 1_000, new AbortController().signal));
    listener!({ method: 'session/snapshot', payload: { sessionId: 'history', snapshot: follow(records) } });
    for (const result of await Promise.all(waits)) {
      expect(result.structuredContent).toMatchObject({ state: 'completed' });
      expect(result.content[1]).toEqual({ type: 'text', text: 'original answer' });
    }
    for (let turn = 1; turn <= 200; turn++) {
      runtime.turns.observe('other', { turn, requestIds: [], state: 'completed', reason: null, finalResponse: null });
    }
    expect(runtime.turns.get(first.turnRef)).toBeUndefined();
    expect(runtime.turns.get(second.turnRef)).toBeUndefined();
    const recovered = waitForTurn(runtime, first.turnRef, 1_000, new AbortController().signal);
    listener!({ method: 'session/snapshot', payload: { sessionId: 'history', snapshot: follow(records) } });
    const result = await recovered;
    expect(result.structuredContent).toMatchObject({ state: 'completed', turnRef: first.turnRef });
    expect(result.content[1]).toEqual({ type: 'text', text: 'original answer' });
  });

  it('correlates DSH turn numbers and preserves the final assistant answer', () => {
    const runtime = makeRuntime();
    const record = runtime.turns.register({ sessionId: 'session-test', sourceRef: 'rpc:prompt-1' });
    observeEvent(runtime, event('mux-1', { type: 'session/event', sessionId: 'session-test', event: { type: 'turn/start', seq: 1, time: 1, data: { turn: 7 } } }));
    observeEvent(runtime, event('mux-2', { type: 'session/event', sessionId: 'session-test', event: { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'user', rpcId: 'prompt-1' }, content: [{ type: 'text', text: 'go' }] } } }));
    observeEvent(runtime, event('mux-3', { type: 'session/event', sessionId: 'session-test', event: { type: 'assistant/message', surfaceOp: 'append', seq: 3, time: 3, data: { turn: 7, message: { content: [{ type: 'text', text: 'done' }] } } } }));
    observeEvent(runtime, event('mux-4', { type: 'session/event', sessionId: 'session-test', event: { type: 'turn/end', seq: 4, time: 4, data: { turn: 7, reason: { kind: 'completed' } } } }));
    const result = runtime.turns.get(record.turnRef)!;
    expect(result.sourceRef).toBe('dsh-turn:7');
    expect(result.state).toBe('completed');
    expect(result.finalAnswer).toBe('done');
  });

  it('classifies failure and user cancellation', async () => {
    const runtime = makeRuntime();
    const failed = runtime.turns.register({ sessionId: 'session-failed', sourceRef: 'rpc:failed' });
    observeEvent(runtime, event('f-1', { type: 'session/event', sessionId: 'session-failed', event: { type: 'turn/start', data: { turn: 1 } } }));
    observeEvent(runtime, event('f-2', { type: 'session/event', sessionId: 'session-failed', event: { type: 'user/message', data: { source: { kind: 'user', rpcId: 'failed' } } } }));
    observeEvent(runtime, event('f-3', { type: 'session/event', sessionId: 'session-failed', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } } }));
    expect(runtime.turns.get(failed.turnRef)).toMatchObject({ state: 'failed', reason: { kind: 'error', message: 'boom' } });

    const cancelled = runtime.turns.register({ sessionId: 'session-cancelled', sourceRef: 'rpc:cancelled' });
    observeEvent(runtime, event('c-1', { type: 'session/event', sessionId: 'session-cancelled', event: { type: 'turn/start', data: { turn: 2 } } }));
    observeEvent(runtime, event('c-2', { type: 'session/event', sessionId: 'session-cancelled', event: { type: 'user/message', data: { source: { kind: 'user', rpcId: 'cancelled' } } } }));
    observeEvent(runtime, event('c-3', { type: 'session/event', sessionId: 'session-cancelled', event: { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } } }));
    expect(runtime.turns.get(cancelled.turnRef)?.state).toBe('cancelled');

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
    const history = new SessionHistory([
        historyEvent('turn/start', { turn: 1 }),
        historyEvent('user/message', { source: { kind: 'user', rpcId: 'older-prompt' } }),
        historyEvent('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'older answer' }] } }, 'append'),
        historyEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
        historyEvent('turn/start', { turn: 2 }),
        historyEvent('user/message', { source: { kind: 'user', rpcId: 'wanted-prompt' } }),
        historyEvent('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'wanted answer' }] } }, 'append'),
        historyEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }),
      ]);
    const projection = history.all().find((turn) => turn.requestIds.includes('wanted-prompt'));

    expect(projection?.state).toBe('completed');
    expect(projection?.finalResponse).toBe('wanted answer');
  });

  it('settles every steering reference bound to the same DSH turn', () => {
    const runtime = makeRuntime();
    const first = runtime.turns.register({ sessionId: 'session-test', sourceRef: 'rpc:first' });
    const second = runtime.turns.register({ sessionId: 'session-test', sourceRef: 'rpc:second' });
    observeEvent(runtime, event('1', { type: 'session/event', sessionId: 'session-test', event: { type: 'turn/start', data: { turn: 3 } } }));
    observeEvent(runtime, event('2', { type: 'session/event', sessionId: 'session-test', event: { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user', rpcId: 'first' } } } }));
    observeEvent(runtime, event('3', { type: 'session/event', sessionId: 'session-test', event: { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user', rpcId: 'second' } } } }));
    observeEvent(runtime, event('4', { type: 'session/event', sessionId: 'session-test', event: { type: 'assistant/message', surfaceOp: 'append', data: { turn: 3, message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'visible' }] } } } }));
    observeEvent(runtime, event('5', { type: 'session/event', sessionId: 'session-test', event: { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } } }));
    expect(runtime.turns.get(first.turnRef)).toMatchObject({ state: 'completed', finalAnswer: 'visible' });
    expect(runtime.turns.get(second.turnRef)).toMatchObject({ state: 'completed', finalAnswer: 'visible' });
  });

  it('returns one uncut visible response and rejects unknown turn references', async () => {
    const runtime = makeRuntime();
    const text = 'x'.repeat(3_999) + '😀' + 'tail'.repeat(1_000);
    const record = runtime.turns.register({ sessionId: 'session-test', sourceRef: 'rpc:test' });
    runtime.turns.transition(record.turnRef, { state: 'completed', reason: null, finalAnswer: text });
    const completed = await callMcpTool(runtime, 'dsh.session.wait_turn', { turnRef: record.turnRef });
    expect(completed.structuredContent).toEqual({ state: 'completed', turnRef: record.turnRef, sessionId: 'session-test', hasFinalResponse: true });
    expect(completed.content).toHaveLength(2);
    expect(completed.content[1]).toEqual({ type: 'text', text });
    expect(completed.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(record.turnRef) });
    expect(JSON.stringify(completed.structuredContent)).not.toContain(text);

    const missing = await waitForTurn(runtime, 'missing', 100, new AbortController().signal);
    expect(missing).toMatchObject({ isError: true, structuredContent: { error: { code: 'turn-ref-not-found', target: { turnRef: 'missing' } } } });
  });

  it('times out without status reads and performs one recovery read after stream failure', async () => {
    let snapshotCalls = 0;
    let listener: ((value: Event) => void) | undefined;
    const runtime = testRuntime({ events: {
      subscribeSession: (_sessionId: string, next: (value: Event) => void) => { listener = next; return () => undefined; },
      sessionSnapshot: async () => {
        snapshotCalls += 1;
        return followSnapshot([historyEvent('turn/start', { turn: 9 }), historyEvent('user/message', { source: { kind: 'user', rpcId: 'recover' } }, 'append'), historyEvent('assistant/message', { turn: 9, message: { content: [{ type: 'text', text: 'recovered' }] } }, 'append'), historyEvent('turn/end', { turn: 9, reason: { kind: 'completed' } })]);
      },
    } });
    const timed = runtime.turns.register({ sessionId: 'timed', sourceRef: 'rpc:timed' });
    const timeoutResult = await waitForTurn(runtime, timed.turnRef, 1, new AbortController().signal);
    expect(timeoutResult.structuredContent).toMatchObject({ state: 'timed_out', observedState: 'accepted' });
    expect(snapshotCalls).toBe(0);

    const recovered = runtime.turns.register({ sessionId: 'recovered', sourceRef: 'rpc:recover' });
    const promise = waitForTurn(runtime, recovered.turnRef, 100, new AbortController().signal);
    listener!(event('', { sessionId: 'recovered', message: 'closed' }, 'stream/error'));
    listener!(event('', { sessionId: 'recovered', message: 'closed again' }, 'stream/error'));
    const result = await promise;
    expect(snapshotCalls).toBe(1);
    expect(result.structuredContent).toMatchObject({ state: 'completed', hasFinalResponse: true });
    expect(result.content[1]).toEqual({ type: 'text', text: 'recovered' });
  });

  it('reports transport loss and unknown durable terminal reasons explicitly', async () => {
    let listener: ((value: Event) => void) | undefined;
    const runtime = testRuntime({ events: { subscribeSession: (_sessionId, next) => { listener = next; return () => undefined; }, sessionSnapshot: async () => { throw new Error('offline'); } } });
    const lost = runtime.turns.register({ sessionId: 'lost', sourceRef: 'rpc:lost' });
    const waiting = waitForTurn(runtime, lost.turnRef, 100, new AbortController().signal);
    listener!(event('', { sessionId: 'lost', message: 'socket closed' }, 'stream/error'));
    expect((await waiting).structuredContent).toMatchObject({ state: 'transport_lost', reason: { kind: 'transport-lost', message: expect.stringContaining('socket closed') } });

    const unknown = runtime.turns.register({ sessionId: 'unknown', sourceRef: 'rpc:unknown' });
    observeEvent(runtime, event('1', { type: 'session/event', sessionId: 'unknown', event: { type: 'turn/start', data: { turn: 4 } } }));
    observeEvent(runtime, event('2', { type: 'session/event', sessionId: 'unknown', event: { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user', rpcId: 'unknown' } } } }));
    observeEvent(runtime, event('3', { type: 'session/event', sessionId: 'unknown', event: { type: 'turn/end', data: { turn: 4, reason: { kind: 'future-stop', code: 'F1', message: 'new reason' } } } }));
    expect((await waitForTurn(runtime, unknown.turnRef, 100, new AbortController().signal)).structuredContent).toMatchObject({ state: 'unknown', reason: { kind: 'future-stop', code: 'F1', message: 'new reason' } });
  });

  it('restores a durable request and backfills past multiple opening windows', async () => {
    const receipt = new TurnStore().register({ sessionId: 'late', sourceRef: 'rpc:original' });
    const older = [record(0, 'turn/start', { turn: 1 }), record(1, 'user/message', { source: { kind: 'user', rpcId: 'original' } }, 'append')];
    const middle = [record(50, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Complete late response' }] } }, 'append')];
    const recent = [record(99, 'turn/end', { turn: 1, reason: { kind: 'completed' } })];
    const pages: number[] = [];
    let listener: (event: Event) => void;
    const runtime = testRuntime({
      events: { subscribeSession: (_id: string, next: (event: Event) => void) => { listener = next; return () => undefined; } },
      rpc: { session: { page: async (request) => { pages.push(request.beforeSeq!); return { ok: true, value: { records: request.beforeSeq === 99 ? middle : older, hasMore: request.beforeSeq === 99 } }; } } },
    });
    const waiting = waitForTurn(runtime, receipt.turnRef, 1_000, new AbortController().signal);
    listener!({ method: 'session/snapshot', payload: { sessionId: 'late', snapshot: follow(recent, true) } });
    const result = await waiting;
    expect(pages).toEqual([99, 50]);
    expect(result.structuredContent).toMatchObject({ state: 'completed', turnRef: receipt.turnRef });
    expect(result.content[1]).toEqual({ type: 'text', text: 'Complete late response' });
  });

  it('shares observation across steering handles without claiming an older receipt', async () => {
    let listener: (event: Event) => void;
    let subscriptions = 0;
    const runtime = testRuntime({ events: { subscribeSession: (_id, next) => { subscriptions += 1; listener = next; return () => undefined; } } });
    const older = runtime.turns.register({ sessionId: 'shared', sourceRef: 'rpc:older-unobserved' });
    const first = runtime.turns.register({ sessionId: 'shared', sourceRef: 'rpc:first' });
    const second = runtime.turns.register({ sessionId: 'shared', sourceRef: 'rpc:second' });
    const waits = [first, second].map((turn) => waitForTurn(runtime, turn.turnRef, 1_000, new AbortController().signal));
    const snapshot = follow([record(0, 'turn/start', { turn: 4 }), record(1, 'user/message', { source: { kind: 'user', rpcId: 'first' } }), record(2, 'user/message', { source: { kind: 'user', rpcId: 'second' } }), record(3, 'turn/end', { turn: 4, reason: { kind: 'completed' } })]);
    listener!({ method: 'session/snapshot', payload: { sessionId: 'shared', snapshot } });
    for (const result of await Promise.all(waits)) expect(result.structuredContent).toMatchObject({ state: 'completed' });
    expect(subscriptions).toBe(1);
    expect(runtime.turns.get(older.turnRef)?.state).toBe('accepted');
  });

  it.each(['completed', 'error'])('keeps intermediate output out of waits for %s', async (kind) => {
    const records = [
      record(0, 'turn/start', { turn: 1 }),
      record(1, 'user/message', { source: { kind: 'user', rpcId: 'p' } }, 'append'),
      record(2, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Checking files' }, { type: 'tool-call', id: 'c', name: 'read', arguments: '{}' }] } }, 'append'),
      record(3, 'assistant/message', { turn: 1, message: { content: [{ type: 'reasoning', text: 'private reasoning' }] } }, 'append'),
      record(4, 'turn/end', { turn: 1, reason: { kind } }),
    ];
    const runtime = testRuntime();
    const receipt = runtime.turns.register({ sessionId: 'answer', sourceRef: 'rpc:p' });
    for (const item of records) observeEvent(runtime, event('', { ...item.event, sessionId: 'answer' }));
    const waited = await waitForTurn(runtime, receipt.turnRef, 100, new AbortController().signal);
    expect(waited.structuredContent).toMatchObject({ hasFinalResponse: false });
    expect(JSON.stringify(waited)).not.toContain('Checking files');
    expect(JSON.stringify(waited)).not.toContain('private reasoning');
  });

  it('recovers on a later wait after a failed recovery read instead of freezing the turn', async () => {
    let listener: (event: Event) => void;
    let subscriptions = 0;
    const runtime = testRuntime({ events: {
      subscribeSession: (_id: string, next: (event: Event) => void) => { subscriptions += 1; listener = next; return () => undefined; },
      sessionSnapshot: async () => { throw new Error('offline'); },
    } });
    const receipt = runtime.turns.register({ sessionId: 'retry', sourceRef: 'rpc:p' });
    const first = waitForTurn(runtime, receipt.turnRef, 1_000, new AbortController().signal);
    listener!(event('', { sessionId: 'retry', message: 'lost' }, 'stream/error'));
    expect((await first).structuredContent).toMatchObject({ state: 'transport_lost' });
    const resumed = waitForTurn(runtime, receipt.turnRef, 1_000, new AbortController().signal);
    listener!({ method: 'session/snapshot', payload: { sessionId: 'retry', snapshot: follow([record(0, 'turn/start', { turn: 1 }), record(1, 'user/message', { source: { kind: 'user', rpcId: 'p' } }), record(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } })]) } });
    expect((await resumed).structuredContent).toMatchObject({ state: 'completed' });
    expect(subscriptions).toBe(2);
  });

  it('bounds session identification by the requested wait deadline', async () => {
    let stopped = false;
    const runtime = testRuntime({ events: { sessionSnapshot: (_id, _limit, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => { stopped = true; reject(signal!.reason); }, { once: true });
    }) } });
    const result = await callMcpTool(runtime, 'dsh.session.wait_turn', { sessionId: 'unreachable', timeoutMs: 20 });
    expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'observation-timeout' } } });
    expect(stopped).toBe(true);
  });

  it('takes over an existing completed turn by session identity without a prompt', async () => {
    const runtime = testRuntime({ events: { sessionSnapshot: async () => follow([record(0, 'turn/start', { turn: 8 }), record(1, 'turn/end', { turn: 8, reason: { kind: 'completed' } })]) } });
    expect((await callMcpTool(runtime, 'dsh.session.wait_turn', { sessionId: 'existing', timeoutMs: 1_000 })).structuredContent).toMatchObject({ state: 'completed', sessionId: 'existing' });
  });
});

function makeRuntime() {
  return testRuntime();
}

function event(_rpcId: string, payload: unknown, method = 'session/follow'): Event {
  if (method === 'stream/error') return { method, payload: new Error((payload as { message: string }).message) };
  const value = payload as Record<string, unknown>;
  if (value.event === undefined && typeof value.sessionId === 'string') {
    const { sessionId, ...frame } = value;
    return { method, payload: { sessionId, event: frame } };
  }
  return { method, payload };
}

function historyEvent(type: string, data: Record<string, unknown>, surfaceOp?: 'append') {
  return { type: 'event' as const, event: { type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } };
}

function record(seq: number, type: string, data: Record<string, unknown>, surfaceOp?: 'append') {
  return { type: 'event' as const, event: { seq, time: seq * 10, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } };
}

function observeEvent(runtime: ReturnType<typeof testRuntime>, value: Event): void { runtime.observations.observe(value); }

function follow(records: ReturnType<typeof record>[], hasMore = false) {
  return followSnapshot(records, { hasMore });
}
