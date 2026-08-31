import type { PendingInteractionId, SessionId, TurnRef } from './targets.js';

export const TURN_STATES = [
  'accepted', 'queued', 'running', 'pending-human-input', 'completed',
  'failed', 'cancelled', 'interrupted', 'transport-lost', 'unknown',
] as const;
export type TurnState = (typeof TURN_STATES)[number];
export type TerminalTurnState = Extract<TurnState, 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'transport-lost' | 'unknown'>;
export type TurnEvidence = 'event' | 'history' | 'rpc' | 'recovered' | 'incomplete';

export interface TurnProjection {
  turnRef: TurnRef;
  sessionId: SessionId;
  state: TurnState;
  reason: string | null;
  finalAnswer: string | null;
  pendingInteractionId: PendingInteractionId | null;
  observedAt: string;
  evidence: TurnEvidence;
}

export interface TurnRecord extends TurnProjection {
  sourceRef: string;
  submittedAt: string;
}

export function isTerminalState(state: TurnState): state is TerminalTurnState {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'interrupted' || state === 'transport-lost' || state === 'unknown';
}

const RANK: Record<TurnState, number> = { accepted: 0, queued: 1, running: 2, 'pending-human-input': 3, completed: 4, failed: 4, cancelled: 4, interrupted: 4, 'transport-lost': 4, unknown: 4 };

export class TurnStore {
  private readonly records = new Map<TurnRef, TurnRecord>();

  register(input: { sessionId: SessionId; sourceRef: string; turnRef?: TurnRef; submittedAt?: string }): TurnRecord {
    const submittedAt = input.submittedAt ?? new Date().toISOString();
    const turnRef = input.turnRef ?? `turn_${crypto.randomUUID()}`;
    const record: TurnRecord = { turnRef, sessionId: input.sessionId, sourceRef: input.sourceRef, submittedAt, state: 'accepted', reason: null, finalAnswer: null, pendingInteractionId: null, observedAt: submittedAt, evidence: 'rpc' };
    this.records.set(turnRef, record);
    return { ...record };
  }

  get(turnRef: TurnRef): TurnRecord | undefined {
    const record = this.records.get(turnRef);
    return record === undefined ? undefined : { ...record };
  }

  findPendingForSession(sessionId: SessionId): TurnRecord | undefined {
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId && !isTerminalState(record.state) && record.sourceRef.startsWith('local-')) return { ...record };
    }
    return undefined;
  }

  bindSource(turnRef: TurnRef, sourceRef: string): TurnRecord {
    const current = this.records.get(turnRef);
    if (current === undefined) throw new Error(`unknown turnRef: ${turnRef}`);
    const updated = { ...current, sourceRef };
    this.records.set(turnRef, updated);
    return { ...updated };
  }

  transition(turnRef: TurnRef, next: Pick<TurnProjection, 'state' | 'reason' | 'finalAnswer' | 'pendingInteractionId' | 'evidence'>): TurnRecord {
    const current = this.records.get(turnRef);
    if (current === undefined) throw new Error(`unknown turnRef: ${turnRef}`);
    if (isTerminalState(current.state)) return { ...current };
    if (RANK[next.state] < RANK[current.state]) return { ...current };
    const updated: TurnRecord = { ...current, ...next, observedAt: new Date().toISOString() };
    this.records.set(turnRef, updated);
    return { ...updated };
  }
}
