import type { EventCursor } from '../domain/snapshots.js';
import type { TurnProjection, TurnState } from '../domain/turns.js';
import type { SessionHistoryValue } from './rpc-client.js';

export interface RecoveryEvent {
  type: string;
  sessionId?: string;
  seq?: number;
  data?: unknown;
  turnRef?: string;
  state?: TurnState;
  reason?: string;
  finalAnswer?: string;
}

export class RecoveryCursorStore {
  private readonly cursors = new Map<string, EventCursor>();

  record(stream: string, event: { type: string; position?: string | null }): EventCursor {
    const cursor: EventCursor = { stream, position: event.position ?? null, lastEventType: event.type, updatedAt: new Date().toISOString() };
    this.cursors.set(stream, cursor);
    return { ...cursor };
  }

  get(stream: string): EventCursor | null {
    const cursor = this.cursors.get(stream);
    return cursor === undefined ? null : { ...cursor };
  }
}

export function classifyHistoryTurn(history: SessionHistoryValue, turnRef: string, sessionId: string, sourceRef?: string, now = new Date().toISOString()): TurnProjection | null {
  const entries = history.events as unknown as Array<RecoveryEvent & { event?: RecoveryEvent }>;
  for (const entry of entries) {
    const event = entry.event ?? entry;
    const state = terminalState(event.state ?? readState(event.data) ?? inferTerminalState(event.type, event.data));
    const ref = event.turnRef ?? readTurnRef(event.data) ?? readDshTurnRef(event.data);
    if ((ref !== turnRef && ref !== sourceRef) || state === null) continue;
    return {
      turnRef,
      sessionId,
      state,
      reason: event.reason ?? readString(event.data, 'reason'),
      finalAnswer: event.finalAnswer ?? readString(event.data, 'finalAnswer'),
      pendingInteractionId: null,
      observedAt: now,
      evidence: 'recovered',
    };
  }
  return null;
}

function terminalState(value: unknown): TurnState | null {
  return value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'interrupted' ? value : null;
}

function inferTerminalState(type: string | undefined, data: unknown): TurnState | null {
  if (type !== 'turn/end') return null;
  const reason = isRecord(data) && isRecord(data.reason) && typeof data.reason.kind === 'string' ? data.reason.kind : '';
  if (reason === 'cancelled' || reason === 'canceled') return 'cancelled';
  if (reason === 'interrupted') return 'interrupted';
  if (reason === 'error' || reason === 'failed') return 'failed';
  return 'completed';
}

function readState(value: unknown): unknown {
  return isRecord(value) ? value.state ?? value.status : undefined;
}

function readTurnRef(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.turnRef === 'string' ? value.turnRef : typeof value.turnId === 'string' ? value.turnId : undefined;
}

function readDshTurnRef(value: unknown): string | undefined {
  if (!isRecord(value) || (typeof value.turn !== 'number' && typeof value.turnId !== 'number')) return undefined;
  return `dsh-turn:${String(value.turn ?? value.turnId)}`;
}

function readString(value: unknown, key: string): string | null {
  if (!isRecord(value) || typeof value[key] !== 'string') return null;
  return value[key] as string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
