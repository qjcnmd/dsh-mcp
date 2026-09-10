export const ACTIVE_TURN_STATES = ['accepted', 'running'] as const;
export const TERMINAL_TURN_STATES = ['completed', 'failed', 'cancelled', 'interrupted', 'unknown'] as const;
export const TURN_STATES = [...ACTIVE_TURN_STATES, ...TERMINAL_TURN_STATES] as const;
export type TurnState = (typeof TURN_STATES)[number];
export type TerminalTurnState = (typeof TERMINAL_TURN_STATES)[number];
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
  retainCount: number;
}

const MAX_CACHED_TURNS = 128;

export function isTerminalState(state: TurnState): state is TerminalTurnState {
  return TERMINAL_TURN_STATES.some((terminal) => terminal === state);
}

/** Handles share one entry per DSH turn. Evicted entries can be restored from DSH. */
export class TurnStore {
  private readonly handles = new Map<string, Entry>();
  private readonly entries = new Set<Entry>();
  private readonly latestDshTurns = new Map<string, number>();

  register(input: Identity & { turnRef?: string }): TurnRecord {
    const canonicalRef = encodeTurnRef(input);
    const turnRef = input.turnRef ?? canonicalRef;
    const entry: Entry = this.handles.get(canonicalRef) ?? {
      identity: { sessionId: input.sessionId, sourceRef: input.sourceRef },
      state: { state: 'accepted', reason: null, finalAnswer: null },
      refs: new Set<string>(),
      retainCount: 0,
    };
    for (const ref of [canonicalRef, turnRef]) {
      entry.refs.add(ref);
      this.handles.set(ref, entry);
    }
    this.entries.add(entry);
    this.prune(entry);
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

  /** Keep a turn available while a submission or waiter is using it. */
  retain(turnRef: string): () => void {
    this.entry(turnRef).retainCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.entry(turnRef).retainCount--;
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
      target.retainCount += source.retainCount;
      this.entries.delete(source);
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
    }
  }

  transition(turnRef: string, next: State): TurnRecord {
    const entry = this.entry(turnRef);
    if (!isTerminalState(entry.state.state)) {
      entry.state = { ...next };
    }
    // Keep this result available to the caller even if all older entries are retained.
    this.prune(entry);
    return this.record(turnRef, entry);
  }

  private prune(current?: Entry): void {
    for (const entry of this.entries) {
      if (this.entries.size <= MAX_CACHED_TURNS) break;
      if (entry === current || entry.retainCount !== 0) continue;
      this.entries.delete(entry);
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
