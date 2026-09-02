import type { TerminalReason, TurnProjection, TurnState } from '../domain/turns.js';
import type { SessionPageValue } from './rpc-client.js';

export function classifyHistoryTurn(history: SessionPageValue, turnRef: string, sessionId: string, sourceRef?: string, now = new Date().toISOString()): TurnProjection | null {
  const requestId = sourceRef?.startsWith('rpc:') === true ? sourceRef.slice(4) : undefined;
  const sourceTurn = sourceRef?.startsWith('dsh-turn:') === true ? Number(sourceRef.slice(9)) : undefined;
  let openTurn: number | undefined;
  let matchedTurn = Number.isFinite(sourceTurn) ? sourceTurn : undefined;
  let finalAnswer: string | null = null;

  for (const record of history.records) {
    const event = record.event;
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === 'turn/start' && typeof data.turn === 'number') {
      openTurn = data.turn;
    } else if (event.type === 'user/message' && openTurn !== undefined && isRecord(data.source) && data.source.kind === 'user' && data.source.rpcId === requestId) {
      matchedTurn = openTurn;
    } else if (matchedTurn !== undefined && data.turn === matchedTurn && event.type === 'assistant/message') {
      finalAnswer = visibleAssistantText(event) ?? finalAnswer;
    } else if (matchedTurn !== undefined && data.turn === matchedTurn && event.type === 'turn/end') {
      const terminal = terminalFromReason(data.reason);
      return { turnRef, sessionId, ...terminal, finalAnswer, pendingInteractionId: null, observedAt: now };
    }
  }
  return null;
}

export function visibleAssistantText(event: Record<string, unknown>): string | null {
  if (event.type !== 'assistant/message' || event.surfaceOp !== 'append' || !isRecord(event.data) || !isRecord(event.data.message) || !Array.isArray(event.data.message.content)) return null;
  const text = event.data.message.content
    .filter(isRecord)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
  return text === '' ? null : text;
}

export function terminalFromReason(value: unknown): { state: Extract<TurnState, 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'>; reason: TerminalReason | null } {
  const reason = terminalReason(value);
  if (reason.kind === 'completed') return { state: 'completed', reason: null };
  if (reason.kind === 'aborted') return { state: isRecord(value) && isRecord(value.reason) && value.reason.kind === 'user' ? 'cancelled' : 'interrupted', reason };
  if (reason.kind === 'interrupted') return { state: 'interrupted', reason };
  if (reason.kind === 'error' || reason.kind === 'blocked' || reason.kind === 'max-tokens') return { state: 'failed', reason };
  return { state: 'unknown', reason };
}

export function terminalReason(value: unknown): TerminalReason {
  if (!isRecord(value)) return { kind: 'unknown', code: null, message: typeof value === 'string' ? bounded(value) : null };
  const error = isRecord(value.error) ? value.error : isRecord(value.failure) ? value.failure : null;
  return {
    kind: typeof value.kind === 'string' ? value.kind : 'unknown',
    code: typeof value.code === 'string' ? value.code : error !== null && typeof error.code === 'string' ? error.code : null,
    message: typeof value.message === 'string' ? bounded(value.message) : error !== null && typeof error.message === 'string' ? bounded(error.message) : null,
  };
}

function bounded(value: string): string {
  return value.length <= 1_000 ? value : `${value.slice(0, 999)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
