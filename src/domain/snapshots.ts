import type { SessionSummary } from './collections.js';
import type { TerminalReason, TurnState } from './turns.js';

export interface RuntimeSnapshot {
  session: SessionSummary;
  activeTurn: { turnRef: string; state: TurnState; reason: TerminalReason | null; observedAt: string } | null;
  pendingInteractions: Array<Record<string, unknown>>;
  recentEvents: Array<{ seq: number; type: string; time: number | null; turn: number | null }>;
  cursor: number;
}
