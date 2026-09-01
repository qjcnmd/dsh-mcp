import type { PendingInteraction } from './pending-interactions.js';
import type { TurnProjection } from './turns.js';

export type SessionStatus = 'idle' | 'running' | 'waiting_for_input' | 'stopping' | 'error' | 'unknown';

export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  path?: string;
  sessionIds: string[];
}

export interface SessionSummary {
  sessionId: string;
  workspaceId: string | null;
  title?: string;
  status: SessionStatus;
  running?: boolean;
}

export interface EventCursor {
  stream: string;
  position: string | null;
  lastEventType: string | null;
  updatedAt: string;
}

export interface RuntimeSnapshot {
  session: SessionSummary;
  activeTurn: TurnProjection | null;
  pendingInteractions: PendingInteraction[];
  recentEvents?: Array<{ type: string; sessionId?: string; observedAt: string }>;
  cursor: EventCursor | null;
}
