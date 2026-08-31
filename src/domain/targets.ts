export type WorkspaceId = string;
export type SessionId = string;
export type TurnRef = string;
export type PendingInteractionId = string;

export interface WorkspaceTarget {
  workspaceId: WorkspaceId;
}

export interface SessionTarget {
  sessionId: SessionId;
}

export interface TurnTarget {
  turnRef: TurnRef;
}

export interface PendingInteractionTarget {
  pendingInteractionId: PendingInteractionId;
}

export function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-blank string`);
  return value;
}

export function workspaceTarget(input: unknown): WorkspaceTarget {
  const record = asRecord(input, 'workspace target');
  return { workspaceId: requireIdentifier(record.workspaceId, 'workspaceId') };
}

export function sessionTarget(input: unknown): SessionTarget {
  const record = asRecord(input, 'session target');
  return { sessionId: requireIdentifier(record.sessionId, 'sessionId') };
}

export function turnTarget(input: unknown): TurnTarget {
  const record = asRecord(input, 'turn target');
  return { turnRef: requireIdentifier(record.turnRef, 'turnRef') };
}

export function pendingInteractionTarget(input: unknown): PendingInteractionTarget {
  const record = asRecord(input, 'pending interaction target');
  return { pendingInteractionId: requireIdentifier(record.pendingInteractionId, 'pendingInteractionId') };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
