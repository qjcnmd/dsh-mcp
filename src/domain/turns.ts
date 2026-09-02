export const TURN_STATES = [
  'accepted', 'queued', 'running', 'pending-human-input', 'completed',
  'failed', 'cancelled', 'interrupted', 'transport-lost', 'unknown',
] as const;
export type TurnState = (typeof TURN_STATES)[number];
export type TerminalTurnState = Extract<TurnState, 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'transport-lost' | 'unknown'>;

export interface TerminalReason {
  kind: string;
  code: string | null;
  message: string | null;
}

export interface TurnProjection {
  turnRef: string;
  sessionId: string;
  state: TurnState;
  reason: TerminalReason | null;
  finalAnswer: string | null;
  pendingInteractionId: string | null;
  observedAt: string;
}

export interface TurnRecord extends TurnProjection {
  sourceRef: string;
}

export function isTerminalState(state: TurnState): state is TerminalTurnState {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'interrupted' || state === 'transport-lost' || state === 'unknown';
}

const RANK: Record<TurnState, number> = { accepted: 0, queued: 1, running: 2, 'pending-human-input': 3, completed: 4, failed: 4, cancelled: 4, interrupted: 4, 'transport-lost': 4, unknown: 4 };

export class TurnStore {
  private readonly records = new Map<string, TurnRecord>();
  private readonly openDshTurns = new Map<string, number>();

  register(input: { sessionId: string; sourceRef: string; turnRef?: string }): TurnRecord {
    const observedAt = new Date().toISOString();
    const turnRef = input.turnRef ?? `turn_${crypto.randomUUID()}`;
    const record: TurnRecord = { turnRef, sessionId: input.sessionId, sourceRef: input.sourceRef, state: 'accepted', reason: null, finalAnswer: null, pendingInteractionId: null, observedAt };
    this.records.set(turnRef, record);
    return { ...record };
  }

  get(turnRef: string): TurnRecord | undefined {
    const record = this.records.get(turnRef);
    return record === undefined ? undefined : { ...record };
  }

  all(): TurnRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  bindSource(turnRef: string, sourceRef: string): TurnRecord {
    const current = this.records.get(turnRef);
    if (current === undefined) throw new Error(`unknown turnRef: ${turnRef}`);
    const updated = { ...current, sourceRef };
    this.records.set(turnRef, updated);
    return { ...updated };
  }

  observeDshTurnStart(sessionId: string, turn: number): void {
    this.openDshTurns.set(sessionId, turn);
  }

  bindRequestToOpenTurn(sessionId: string, requestId: string): TurnRecord | undefined {
    const turn = this.openDshTurns.get(sessionId);
    if (turn === undefined) return undefined;
    const record = [...this.records.values()].find((candidate) => candidate.sessionId === sessionId && candidate.sourceRef === `rpc:${requestId}` && !isTerminalState(candidate.state));
    if (record === undefined) return undefined;
    return this.bindSource(record.turnRef, `dsh-turn:${turn}`);
  }

  findByDshTurn(sessionId: string, turn: number): TurnRecord[] {
    const sourceRef = `dsh-turn:${turn}`;
    return [...this.records.values()].filter((candidate) => candidate.sessionId === sessionId && candidate.sourceRef === sourceRef).map((record) => ({ ...record }));
  }

  reject(turnRef: string, reason: string): TurnRecord {
    return this.transition(turnRef, { state: 'failed', reason: { kind: 'rejected', code: null, message: reason }, finalAnswer: null, pendingInteractionId: null });
  }

  resolveInteraction(pendingInteractionId: string): TurnRecord | undefined {
    const current = [...this.records.values()].find((record) => record.state === 'pending-human-input' && record.pendingInteractionId === pendingInteractionId);
    if (current === undefined) return undefined;
    const updated: TurnRecord = { ...current, state: 'running', reason: null, pendingInteractionId: null, observedAt: new Date().toISOString() };
    this.records.set(updated.turnRef, updated);
    return { ...updated };
  }

  transition(turnRef: string, next: Pick<TurnProjection, 'state' | 'reason' | 'finalAnswer' | 'pendingInteractionId'>): TurnRecord {
    const current = this.records.get(turnRef);
    if (current === undefined) throw new Error(`unknown turnRef: ${turnRef}`);
    if (isTerminalState(current.state)) return { ...current };
    if (RANK[next.state] < RANK[current.state]) return { ...current };
    const updated: TurnRecord = { ...current, ...next, observedAt: new Date().toISOString() };
    this.records.set(turnRef, updated);
    return { ...updated };
  }
}
