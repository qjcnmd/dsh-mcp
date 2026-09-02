import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { DshEvent as Event } from '../../src/dsh/event-client.js';
import { PendingInteractionStore } from '../../src/domain/pending-interactions.js';
import { TurnStore } from '../../src/domain/turns.js';
import { classifyHistoryTurn } from '../../src/dsh/recovery.js';
import { observeEvent, waitForTurn } from '../../src/mcp/actions/turns.js';
import { createMcpServer } from '../../src/mcp/transport.js';

describe('turn lifecycle projection', () => {
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

  it('classifies failure, cancellation, and returns an answerable pending question without polling', async () => {
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

    const pending = runtime.turns.register({ sessionId: 'session-question', sourceRef: 'rpc:question' });
    observeEvent(runtime, event('q-1', { type: 'remote/invocation', sessionId: 'session-question', request: { questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'yes', description: 'Proceed' }] }] } }, 'user-questions/request'));
    expect(runtime.turns.get(pending.turnRef)?.state).toBe('pending-human-input');
    expect(runtime.pending.get('q-1')?.kind).toBe('question');
    expect(runtime.pending.get('q-1')?.questions).toEqual([{ id: 'q', question: 'Continue?', options: [{ label: 'yes', description: 'Proceed' }], multiSelect: false }]);
    const waited = await waitForTurn(runtime, pending.turnRef, 100, new AbortController().signal);
    expect(waited.structuredContent).toMatchObject({
      state: 'input_required',
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
        historyEvent('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'older answer' }] } }, 'append'),
        historyEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
        historyEvent('turn/start', { turn: 2 }),
        historyEvent('user/message', { source: { kind: 'user', rpcId: 'wanted-prompt' } }),
        historyEvent('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'wanted answer' }] } }, 'append'),
        historyEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }),
      ],
      hasMore: false,
    }, 'turn-ref', 'session-test', 'rpc:wanted-prompt');

    expect(projection?.state).toBe('completed');
    expect(projection?.finalAnswer).toBe('wanted answer');
  });

  it('settles every steering reference bound to the same DSH turn', () => {
    const runtime = makeRuntime();
    const first = runtime.turns.register({ sessionId: 'session-test', sourceRef: 'rpc:first' });
    const second = runtime.turns.register({ sessionId: 'session-test', sourceRef: 'rpc:second' });
    observeEvent(runtime, event('1', { type: 'session/event', sessionId: 'session-test', event: { type: 'turn/start', data: { turn: 3 } } }));
    observeEvent(runtime, event('2', { type: 'session/event', sessionId: 'session-test', event: { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user', rpcId: 'first' } } } }));
    observeEvent(runtime, event('3', { type: 'session/event', sessionId: 'session-test', event: { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user', rpcId: 'second' } } } }));
    observeEvent(runtime, event('4', { type: 'session/event', sessionId: 'session-test', event: { type: 'assistant/message', surfaceOp: 'append', data: { turn: 3, message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'visible' }, { type: 'tool-call', name: 'x', arguments: '{}' }] } } } }));
    observeEvent(runtime, event('5', { type: 'session/event', sessionId: 'session-test', event: { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } } }));
    expect(runtime.turns.get(first.turnRef)).toMatchObject({ state: 'completed', finalAnswer: 'visible' });
    expect(runtime.turns.get(second.turnRef)).toMatchObject({ state: 'completed', finalAnswer: 'visible' });
  });

  it('returns one uncut visible response and rejects unknown turn references', async () => {
    const runtime = makeRuntime();
    const text = 'x'.repeat(5_000);
    const record = runtime.turns.register({ sessionId: 'session-test', sourceRef: 'rpc:test' });
    runtime.turns.transition(record.turnRef, { state: 'completed', reason: null, finalAnswer: text, pendingInteractionId: null });
    const completed = await waitForTurn(runtime, record.turnRef, 100, new AbortController().signal);
    expect(completed.structuredContent).toEqual({ state: 'completed', turnRef: record.turnRef, sessionId: 'session-test', hasFinalResponse: true });
    expect(completed.content).toEqual([{ type: 'text', text }]);
    expect(JSON.stringify(completed.structuredContent)).not.toContain(text);

    const missing = await waitForTurn(runtime, 'missing', 100, new AbortController().signal);
    expect(missing).toMatchObject({ isError: true, structuredContent: { error: { code: 'turn-ref-not-found', target: { turnRef: 'missing' } } } });
  });

  it('times out without status reads and performs one recovery read after stream failure', async () => {
    let snapshotCalls = 0;
    let listener: ((value: Event) => void) | undefined;
    const runtime = makeRuntime();
    runtime.events = {
      subscribeSession: (_sessionId: string, next: (value: Event) => void) => { listener = next; return () => undefined; },
      sessionSnapshot: async () => {
        snapshotCalls += 1;
        return { records: [historyEvent('turn/start', { turn: 9 }), historyEvent('user/message', { source: { kind: 'user', rpcId: 'recover' } }, 'append'), historyEvent('assistant/message', { turn: 9, message: { content: [{ type: 'text', text: 'recovered' }] } }, 'append'), historyEvent('turn/end', { turn: 9, reason: { kind: 'completed' } })], hasMore: false };
      },
    } as never;
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
    expect(result.content).toEqual([{ type: 'text', text: 'recovered' }]);
  });

  it('reports transport loss and unknown durable terminal reasons explicitly', async () => {
    let listener: ((value: Event) => void) | undefined;
    const runtime = makeRuntime();
    runtime.events = { subscribeSession: (_sessionId: string, next: (value: Event) => void) => { listener = next; return () => undefined; }, sessionSnapshot: async () => { throw new Error('offline'); } } as never;
    const lost = runtime.turns.register({ sessionId: 'lost', sourceRef: 'rpc:lost' });
    const waiting = waitForTurn(runtime, lost.turnRef, 100, new AbortController().signal);
    listener!(event('', { sessionId: 'lost', message: 'socket closed' }, 'stream/error'));
    expect((await waiting).structuredContent).toMatchObject({ state: 'transport_lost', reason: { kind: 'transport-lost', message: 'socket closed' } });

    const unknown = runtime.turns.register({ sessionId: 'unknown', sourceRef: 'rpc:unknown' });
    observeEvent(runtime, event('1', { type: 'session/event', sessionId: 'unknown', event: { type: 'turn/start', data: { turn: 4 } } }));
    observeEvent(runtime, event('2', { type: 'session/event', sessionId: 'unknown', event: { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user', rpcId: 'unknown' } } } }));
    observeEvent(runtime, event('3', { type: 'session/event', sessionId: 'unknown', event: { type: 'turn/end', data: { turn: 4, reason: { kind: 'future-stop', code: 'F1', message: 'new reason' } } } }));
    expect((await waitForTurn(runtime, unknown.turnRef, 100, new AbortController().signal)).structuredContent).toMatchObject({ state: 'unknown', reason: { kind: 'future-stop', code: 'F1', message: 'new reason' } });
  });

  it('assembles bounded newest-first turn history across native pages', async () => {
    const finalText = 'z'.repeat(5_000);
    const pages: Array<{ throughSeq: number; beforeSeq?: number }> = [];
    const turn1 = [record(0, 'turn/start', { turn: 1 }), record(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'one' }] }, 'append'), record(2, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'answer one' }] } }, 'append'), record(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })];
    const middle = [record(4, 'turn/start', { turn: 2 }), record(5, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'two' }, { type: 'image', data: 'not-returned' }] }, 'append'), record(6, 'assistant/chunk', { turn: 2, chunk: { type: 'reasoning-delta', text: 'hidden' } }), record(7, 'tool/result', { turn: 2, message: { content: [{ type: 'text', text: 'secret tool output' }] } }, 'append'), record(8, 'assistant/message', { turn: 2, message: { content: [{ type: 'reasoning', text: 'hidden reasoning' }, { type: 'text', text: 'answer two' }] } }, 'append'), record(9, 'turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'P1', message: 'provider failed' } } }), record(10, 'turn/start', { turn: 3 }), record(11, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'three' }] }, 'append')];
    const recent = [record(12, 'assistant/message', { turn: 3, message: { content: [{ type: 'text', text: finalText }] } }, 'append'), record(13, 'turn/end', { turn: 3, reason: { kind: 'completed' } })];
    const runtime = {
      turns: new TurnStore(), pending: new PendingInteractionStore(), selectedSessionId: null,
      events: { sessionSnapshot: async () => ({ cursor: 13, records: recent, hasMore: true, header: {}, projections: { asOfSeq: 13, values: {} } }) },
      rpc: { session: { page: async (request: { throughSeq: number; beforeSeq?: number }) => { pages.push(request); return request.beforeSeq === 12 ? { ok: true, value: { records: middle, hasMore: true } } : { ok: true, value: { records: turn1, hasMore: false } }; } } },
    } as never;

    const first = await callMcpTool(runtime, 'dsh.session.history', { sessionId: 'session-test', limit: 2 });
    const firstValue = first.structuredContent as { turns: Array<Record<string, unknown>>; hasMore: boolean; nextCursor: string };
    expect(firstValue.turns.map((turn) => turn.turn)).toEqual([3, 2]);
    expect(firstValue.turns[0]).toMatchObject({ finalResponse: finalText, finalResponseComplete: true });
    expect(firstValue.turns[1]).toMatchObject({ state: 'failed', userMessages: [{ text: 'two', imageCount: 1 }], finalResponse: 'answer two', finalResponseComplete: false, reason: { kind: 'error', code: 'P1', message: 'provider failed' } });
    expect(JSON.stringify(firstValue)).not.toContain('hidden reasoning');
    expect(JSON.stringify(firstValue)).not.toContain('secret tool output');
    expect(JSON.stringify(firstValue)).not.toContain('not-returned');
    expect(first.content).toEqual([{ type: 'text', text: '2 turn(s); more: true.' }]);

    const second = await callMcpTool(runtime, 'dsh.session.history', { sessionId: 'session-test', limit: 2, cursor: firstValue.nextCursor });
    expect(second.structuredContent).toMatchObject({ sessionId: 'session-test', turns: [{ turn: 1 }], hasMore: false, nextCursor: null });
    expect(pages.every((page) => page.throughSeq === 13)).toBe(true);
  });
});

function makeRuntime() {
  return { turns: new TurnStore(), pending: new PendingInteractionStore(), selectedSessionId: null, rpc: { session: { history: async () => ({ ok: false, error: { dshCode: 'not-called', message: 'not called' } }) } }, events: { subscribe: () => () => undefined } } as never;
}

function event(rpcId: string, payload: unknown, method = 'session/follow'): Event {
  return { stream: 'mux', rpcId, method, payload };
}

function historyEvent(type: string, data: Record<string, unknown>, surfaceOp?: 'append') {
  return { type: 'event' as const, event: { type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } };
}

function record(seq: number, type: string, data: Record<string, unknown>, surfaceOp?: 'append') {
  return { type: 'event' as const, event: { seq, time: seq * 10, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } };
}

async function callMcpTool(runtime: Parameters<typeof createMcpServer>[0], name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = createMcpServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const messages: Record<string, unknown>[] = [];
  clientTransport.onmessage = (message) => messages.push(message as Record<string, unknown>);
  await server.connect(serverTransport);
  await clientTransport.start();
  await clientTransport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'turns', version: '1' } } });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await clientTransport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const result = messages.find((message) => message.id === 2)?.result as Record<string, unknown>;
  await clientTransport.close();
  await server.close();
  return result;
}
