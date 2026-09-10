import type { DshEvent, DshEventClient, SessionFollowSnapshot } from './event-client.js';
import type { DshRpcClient } from './rpc-client.js';
import { DshMcpError } from '../errors.js';
import type { TurnStore } from '../domain/turns.js';
import { loadSessionHistory, SessionHistory } from './session-history.js';
import { isRecord } from '../value-guards.js';

interface Dependencies { events: DshEventClient; rpc: DshRpcClient; turns: TurnStore; }
interface Subscription {
  listeners: Set<() => void>;
  sources: Set<string>;
  stop: () => void;
  controller: AbortController;
  work: Promise<void>;
  error?: Error;
}

/** One observation per session, shared by waiters and explicit inspection. */
export class SessionObserver {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly histories = new Map<string, SessionHistory>();

  constructor(private readonly runtime: Dependencies) {}

  watch(sessionId: string, listener: () => void, sourceRef?: string): () => void {
    let subscription = this.subscriptions.get(sessionId);
    if (subscription?.error !== undefined) {
      subscription.stop();
      subscription.controller.abort();
      this.subscriptions.delete(sessionId);
      subscription = undefined;
    }
    if (subscription === undefined) {
      subscription = { listeners: new Set(), sources: new Set(), stop: () => undefined, controller: new AbortController(), work: Promise.resolve() };
      this.subscriptions.set(sessionId, subscription);
      const current = subscription;
      subscription.stop = this.runtime.events.subscribeSession(sessionId, (event) => {
        this.enqueue(sessionId, current, async () => {
          if (event.method === 'session/snapshot' && isRecord(event.payload)) {
            await this.hydrate(sessionId, current, event.payload.snapshot as SessionFollowSnapshot);
          } else if (event.method === 'stream/error') {
            if (current.error !== undefined) return;
            if (event.payload instanceof DshMcpError && event.payload.code !== 'transport-error') throw event.payload;
            const message = event.payload instanceof Error ? event.payload.message : 'DSH event stream failed.';
            // Read once to recover a durable completion; leave loss retryable on the next call.
            try {
              await this.refresh(sessionId, current);
            } catch (error) {
              if (current.controller.signal.aborted) return;
              throw new DshMcpError('transport-lost', `${message} Recovery failed: ${error instanceof Error ? error.message : String(error)}`, { sessionId });
            }
            throw new DshMcpError('transport-lost', message, { sessionId });
          } else {
            this.observe(event);
          }
        });
      }, subscription.controller.signal);
    }
    subscription.listeners.add(listener);
    if (sourceRef !== undefined && !subscription.sources.has(sourceRef)) {
      subscription.sources.add(sourceRef);
      const history = this.histories.get(sessionId);
      if (history !== undefined && !history.covers(subscription.sources)) {
        const current = subscription;
        this.enqueue(sessionId, current, () => this.refresh(sessionId, current));
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      subscription.listeners.delete(listener);
      this.releaseUnused(sessionId, subscription);
    };
  }

  error(sessionId: string): Error | undefined { return this.subscriptions.get(sessionId)?.error; }

  close(): void {
    for (const [sessionId, subscription] of this.subscriptions) {
      subscription.error = new DshMcpError('transport-lost', 'The MCP connection closed.', { sessionId });
      subscription.stop();
      subscription.controller.abort();
      for (const listener of [...subscription.listeners]) listener();
    }
    this.subscriptions.clear();
    this.histories.clear();
  }

  async inspect(sessionId: string, signal: AbortSignal): Promise<void> {
    const snapshot = await this.runtime.events.sessionSnapshot(sessionId, 20, signal);
    const history = await loadSessionHistory(this.runtime.rpc, sessionId, { ...snapshot, throughSeq: snapshot.cursor }, new Set(), signal);
    signal.throwIfAborted();
    for (const turn of history.all()) this.runtime.turns.observe(sessionId, turn);
  }

  observe(event: DshEvent): void {
    if (!isRecord(event.payload) || !isRecord(event.payload.event) || typeof event.payload.sessionId !== 'string') return;
    const { sessionId, event: frame } = event.payload;
    let history = this.histories.get(sessionId);
    if (history === undefined) { history = new SessionHistory(); this.histories.set(sessionId, history); }
    const turn = history.apply(frame);
    if (turn !== undefined) this.runtime.turns.observe(sessionId, turn);
  }

  private async refresh(sessionId: string, subscription: Subscription): Promise<void> {
    const snapshot = await this.runtime.events.sessionSnapshot(sessionId, 20, subscription.controller.signal);
    await this.hydrate(sessionId, subscription, snapshot);
  }

  private async hydrate(sessionId: string, subscription: Subscription, snapshot: SessionFollowSnapshot): Promise<void> {
    const signal = subscription.controller.signal;
    const history = await loadSessionHistory(this.runtime.rpc, sessionId, { ...snapshot, throughSeq: snapshot.cursor }, subscription.sources, signal);
    signal.throwIfAborted();
    this.histories.set(sessionId, history);
    for (const turn of history.all()) this.runtime.turns.observe(sessionId, turn);
  }

  private enqueue(sessionId: string, subscription: Subscription, action: () => Promise<void>): void {
    subscription.work = subscription.work.then(async () => {
      if (!subscription.controller.signal.aborted) await action();
    }).catch((error: unknown) => {
      if (subscription.controller.signal.aborted) return;
      subscription.error = error instanceof Error ? error : new Error(String(error));
      subscription.stop();
      subscription.controller.abort();
    }).then(() => {
      for (const listener of [...subscription.listeners]) listener();
      this.releaseUnused(sessionId, subscription);
    });
  }

  private releaseUnused(sessionId: string, subscription: Subscription): void {
    if (subscription.listeners.size !== 0) return;
    subscription.stop();
    subscription.controller.abort();
    if (this.subscriptions.get(sessionId) === subscription) {
      this.subscriptions.delete(sessionId);
      this.histories.delete(sessionId);
    }
  }
}
