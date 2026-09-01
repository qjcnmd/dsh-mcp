import type { TurnProjection, TurnState } from '../domain/turns.js';
import type { SessionPageValue } from './rpc-client.js';

export function classifyHistoryTurn(history: SessionPageValue, turnRef: string, sessionId: string, sourceRef?: string, now = new Date().toISOString()): TurnProjection | null {
  const targetRequestId = sourceRef?.startsWith('rpc:') === true ? sourceRef.slice(4) : undefined;
  const targetTurn = sourceRef?.startsWith('dsh-turn:') === true ? Number(sourceRef.slice(9)) : undefined;
  let openTurn: number | undefined;
  let matchedTurn = Number.isFinite(targetTurn) ? targetTurn : undefined;
  let finalAnswer: string | null = null;

  for (const record of history.records) {
    const event = record.event;
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === 'turn/start' && typeof data.turn === 'number') {
      openTurn = data.turn;
      continue;
    }
    if (event.type === 'user/message'
      && openTurn !== undefined
      && isRecord(data.source)
      && data.source.kind === 'user'
      && typeof data.source.rpcId === 'string'
      && data.source.rpcId === targetRequestId) {
      matchedTurn = openTurn;
      continue;
    }
    if (matchedTurn === undefined || data.turn !== matchedTurn) continue;
    if (event.type === 'assistant/message') {
      finalAnswer = readAssistantText(data) ?? finalAnswer;
      continue;
    }
    if (event.type !== 'turn/end') continue;
    const state = terminalState(data.reason);
    if (state === null) return null;
    return {
      turnRef,
      sessionId,
      state,
      reason: boundedReason(data.reason),
      finalAnswer,
      pendingInteractionId: null,
      observedAt: now,
      evidence: 'recovered',
    };
  }
  return null;
}

function terminalState(value: unknown): TurnState | null {
  const kind = isRecord(value) && typeof value.kind === 'string' ? value.kind : '';
  if (kind === 'completed') return 'completed';
  if (kind === 'aborted') return isRecord(value) && isRecord(value.reason) && value.reason.kind === 'user' ? 'cancelled' : 'interrupted';
  if (kind === 'interrupted') return 'interrupted';
  if (kind === 'error' || kind === 'blocked' || kind === 'max-tokens') return 'failed';
  return null;
}

function readAssistantText(data: Record<string, unknown>): string | null {
  if (!isRecord(data.message) || !Array.isArray(data.message.content)) return null;
  const text = data.message.content
    .filter(isRecord)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
  return text === '' ? null : text;
}

function boundedReason(value: unknown): string | null {
  if (!isRecord(value)) return typeof value === 'string' ? value.slice(0, 4_000) : null;
  const kind = typeof value.kind === 'string' ? value.kind : null;
  const error = isRecord(value.error) && typeof value.error.message === 'string' ? value.error.message : null;
  const text = kind === null ? error : error === null ? kind : `${kind}: ${error}`;
  return text === null ? null : text.slice(0, 4_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
