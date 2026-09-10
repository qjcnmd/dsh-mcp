export const TURN_STATES = ['accepted', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown'] as const;
export type TurnState = (typeof TURN_STATES)[number];
export type TerminalTurnState = Extract<TurnState, 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'>;
export interface TerminalReason { kind: string; code: string | null; message: string | null; }
export interface TurnProjection {
  turnRef: string;
  sessionId: string;
  state: TurnState;
  reason: TerminalReason | null;
  finalAnswer: string | null;
}
export interface TurnRecord extends TurnProjection { sourceRef: string; }

type State = Pick<TurnProjection, 'state' | 'reason' | 'finalAnswer'>;
type Identity = { sessionId: string; sourceRef: string };
interface Entry {
  identity: Identity;
  state: State;
  refs: Set<string>;
  waiters: number;
}

const MAX_COMPLETED_TURNS = 128;

export function isTerminalState(state: TurnState): state is TerminalTurnState {
  return ['completed', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(state);
}

/** Handles share one entry per DSH turn. Evicted completions can be restored from DSH. */
export class TurnStore {
  private readonly handles = new Map<string, Entry>();
  private readonly completed = new Set<Entry>();
  private readonly latestDshTurns = new Map<string, number>();

  register(input: Identity & { turnRef?: string }): TurnRecord {
    const canonicalRef = encodeTurnRef(input);
    const turnRef = input.turnRef ?? canonicalRef;
    const entry: Entry = this.handles.get(canonicalRef) ?? {
      identity: { sessionId: input.sessionId, sourceRef: input.sourceRef },
      state: { state: 'accepted', reason: null, finalAnswer: null },
      refs: new Set<string>(),
      waiters: 0,
    };
    for (const ref of [canonicalRef, turnRef]) {
      entry.refs.add(ref);
      this.handles.set(ref, entry);
    }
    return this.record(turnRef, entry);
  }

  restore(turnRef: string): TurnRecord | undefined {
    const existing = this.get(turnRef);
    if (existing !== undefined) return existing;
    if (!turnRef.startsWith('turn_')) return undefined;
    try {
      const value: unknown = JSON.parse(Buffer.from(turnRef.slice(5), 'base64url').toString('utf8'));
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || value[0] === '' || typeof value[1] !== 'string' || !/^(rpc:.+|dsh-turn:\d+)$/.test(value[1])) return undefined;
      return this.register({ sessionId: value[0], sourceRef: value[1], turnRef });
    } catch { return undefined; }
  }

  get(turnRef: string): TurnRecord | undefined {
    const entry = this.handles.get(turnRef);
    return entry === undefined ? undefined : this.record(turnRef, entry);
  }

  /** Keep an observed turn available until its waiters have consumed the result. */
  retain(turnRef: string): () => void {
    this.entry(turnRef).waiters++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.entry(turnRef).waiters--;
      this.prune();
    };
  }

  observe(sessionId: string, fact: { turn: number; requestIds: string[]; state: TurnState; reason: TerminalReason | null; finalResponse: string | null }): TurnRecord {
    this.latestDshTurns.set(sessionId, Math.max(this.latestDshTurns.get(sessionId) ?? fact.turn, fact.turn));
    const record = this.register({ sessionId, sourceRef: 'dsh-turn:' + fact.turn });
    const target = this.entry(record.turnRef);
    for (const requestId of fact.requestIds) {
      const source = this.handles.get(encodeTurnRef({ sessionId, sourceRef: 'rpc:' + requestId }));
      if (source === undefined || source === target) continue;
      for (const ref of source.refs) {
        target.refs.add(ref);
        this.handles.set(ref, target);
      }
      target.waiters += source.waiters;
      this.completed.delete(source);
    }
    return this.transition(record.turnRef, { state: fact.state, reason: fact.reason, finalAnswer: fact.finalResponse });
  }

  latest(sessionId: string): TurnRecord | undefined {
    const turn = this.latestDshTurns.get(sessionId);
    return turn === undefined ? undefined : this.get(encodeTurnRef({ sessionId, sourceRef: 'dsh-turn:' + turn }));
  }

  reject(turnRef: string, reason: string): TurnRecord {
    return this.transition(turnRef, { state: 'failed', reason: { kind: 'rejected', code: null, message: reason }, finalAnswer: null });
  }

  accept(turnRef: string): void {
    const entry = this.entry(turnRef);
    if (entry.state.reason?.kind === 'rejected') {
      entry.state = { state: 'accepted', reason: null, finalAnswer: null };
      this.completed.delete(entry);
    }
  }

  transition(turnRef: string, next: State): TurnRecord {
    const entry = this.entry(turnRef);
    if (!isTerminalState(entry.state.state)) {
      entry.state = { ...next };
      if (isTerminalState(next.state)) this.completed.add(entry);
    }
    // Keep this result available to the caller even if all older entries are retained.
    this.prune(entry);
    return this.record(turnRef, entry);
  }

  private prune(current?: Entry): void {
    for (const entry of this.completed) {
      if (this.completed.size <= MAX_COMPLETED_TURNS) break;
      if (entry === current || entry.waiters !== 0) continue;
      this.completed.delete(entry);
      for (const ref of entry.refs) this.handles.delete(ref);
      const { sessionId, sourceRef } = entry.identity;
      if (sourceRef === 'dsh-turn:' + this.latestDshTurns.get(sessionId)) this.latestDshTurns.delete(sessionId);
    }
  }

  private entry(turnRef: string): Entry {
    const entry = this.handles.get(turnRef);
    if (entry === undefined) throw new Error('unknown turnRef: ' + turnRef);
    return entry;
  }

  private record(turnRef: string, entry: Entry): TurnRecord { return { turnRef, ...entry.identity, ...entry.state }; }
}

function encodeTurnRef(identity: Identity): string {
  return 'turn_' + Buffer.from(JSON.stringify([identity.sessionId, identity.sourceRef])).toString('base64url');
}
