import type { PendingInteractionId, SessionId, TurnRef } from './targets.js';

export type PendingInteractionKind = 'question' | 'approval';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface PendingInteraction {
  pendingInteractionId: PendingInteractionId;
  sessionId: SessionId;
  turnRef: TurnRef | null;
  kind: PendingInteractionKind;
  prompt: string;
  options: QuestionOption[];
  expiresAt: string | null;
}
