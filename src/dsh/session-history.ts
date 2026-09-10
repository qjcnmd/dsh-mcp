import type { TerminalReason, TerminalTurnState } from '../domain/turns.js';
import { DshProtocolError } from '../errors.js';
import type { DshRpcClient, SessionHistoryRecord, SessionPageValue } from './rpc-client.js';
import { isRecord } from '../value-guards.js';

export interface HistoryTurn {
  turn: number;
  state: 'running' | TerminalTurnState;
  finalResponse: string | null;
  reason: TerminalReason | null;
  requestIds: string[];
}

/** The same fold projects historical pages and ongoing session events. */
export class SessionHistory {
  private readonly turns = new Map<number, HistoryTurn>();
  private readonly inboxes = { 'next-step': new Map<number, string>(), 'next-turn': new Map<number, string>() };
  private openTurn: number | undefined;
  private lastSeq = -1;

  constructor(records: SessionHistoryRecord[] = []) {
    for (const record of records) if (record.type === 'event') this.apply(record.event);
  }

  all(): HistoryTurn[] { return [...this.turns.values()]; }

  covers(sources: readonly string[]): boolean {
    const turns = this.all();
    if (turns.length === 0) return false;
    return sources.every((source) => turns.some((turn) => source === `dsh-turn:${turn.turn}` || turn.requestIds.some((id) => source === `rpc:${id}`)));
  }

  apply(event: Record<string, unknown>): HistoryTurn | undefined {
    if (typeof event.seq === 'number') {
      if (event.seq <= this.lastSeq) return undefined;
      this.lastSeq = event.seq;
    }
    const data = isRecord(event.data) ? event.data : {};
    if (event.type === 'turn/start' && typeof data.turn === 'number') {
      this.openTurn = data.turn;
      const turn: HistoryTurn = { turn: data.turn, state: 'running', finalResponse: null, reason: null, requestIds: [] };
      this.turns.set(data.turn, turn);
      return turn;
    }
    const turnNumber = typeof data.turn === 'number' ? data.turn : this.openTurn;
    const turn = turnNumber === undefined ? undefined : this.turns.get(turnNumber);
    // Inbox claims precede model preparation and the corresponding user/message.
    const claimed = event.type === 'agent/inbox/spliced' ? this.spliceInbox(data) : [];
    if (turn === undefined || turn.state !== 'running') return undefined;
    const messageRequest = event.type === 'user/message' ? requestId(data.source) : undefined;
    if (messageRequest !== undefined) claimed.push(messageRequest);
    for (const id of claimed) if (!turn.requestIds.includes(id)) turn.requestIds.push(id);
    if (event.type === 'assistant/message' && event.surfaceOp === 'append' && isRecord(data.message) && Array.isArray(data.message.content)) {
      const parts = data.message.content.filter(isRecord);
      const text = parts.flatMap((part) => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('');
      // A step that invokes tools is intermediate, even when it includes visible text.
      turn.finalResponse = parts.some((part) => part.type === 'tool-call') ? null : text || null;
    } else if (event.type === 'turn/end') {
      const terminal = terminalFromReason(data.reason);
      turn.state = terminal.state;
      turn.reason = terminal.reason;
      if (terminal.state !== 'completed') turn.finalResponse = null;
      if (this.openTurn === turn.turn) this.openTurn = undefined;
    }
    return turn;
  }

  private spliceInbox(data: Record<string, unknown>): string[] {
    const { target, start, inserted } = data;
    const removedCount = data.removedCount ?? 0;
    if ((target !== 'next-step' && target !== 'next-turn') || typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0
      || typeof removedCount !== 'number' || !Number.isSafeInteger(removedCount) || removedCount < 0 || !Array.isArray(inserted)) {
      throw new DshProtocolError('DSH returned an invalid inbox splice.');
    }
    // A history page can begin with an occupied inbox. Keep known identities at their native indices.
    const next = new Map<number, string>();
    const claimed: string[] = [];
    for (const [index, id] of this.inboxes[target]) {
      if (index < start) next.set(index, id);
      else if (index < start + removedCount) {
        if (data.outcome === undefined) claimed.push(id);
      } else next.set(index - removedCount + inserted.length, id);
    }
    inserted.forEach((message: unknown, index) => {
      const id = isRecord(message) ? requestId(message.source) : undefined;
      if (id !== undefined) next.set(start + index, id);
    });
    this.inboxes[target] = next;
    return claimed;
  }
}

function requestId(source: unknown): string | undefined {
  return isRecord(source) && source.kind === 'user' && typeof source.rpcId === 'string' ? source.rpcId : undefined;
}

/** Backfill a stable native window until the requested turn identities are covered. */
export async function loadSessionHistory(
  rpc: DshRpcClient,
  sessionId: string,
  initial: SessionPageValue & { throughSeq: number },
  sources: () => readonly string[],
  signal: AbortSignal,
): Promise<SessionHistory> {
  let records = [...initial.records];
  let hasMore = initial.hasMore;
  let beforeSeq = Infinity;
  let history = new SessionHistory(records);
  while (hasMore && !history.covers(sources())) {
    signal.throwIfAborted();
    const seqs = records.map((record) => record.event.seq).filter((seq): seq is number => typeof seq === 'number');
    const nextBefore = Math.min(...seqs);
    if (!Number.isFinite(nextBefore) || nextBefore >= beforeSeq) throw new DshProtocolError('DSH history did not advance to an older page.', { sessionId });
    const page = await rpc.session.page({ sessionId, throughSeq: initial.throughSeq, beforeSeq: nextBefore, maxMessages: 50 }, signal);
    if (!page.ok) throw page.error;
    records = [...page.value.records, ...records];
    hasMore = page.value.hasMore;
    beforeSeq = nextBefore;
    history = new SessionHistory(records);
  }
  return history;
}

function terminalFromReason(value: unknown): { state: TerminalTurnState; reason: TerminalReason | null } {
  const reason = terminalReason(value);
  if (reason.kind === 'completed') return { state: 'completed', reason: null };
  if (reason.kind === 'aborted') return { state: isRecord(value) && isRecord(value.reason) && value.reason.kind === 'user' ? 'cancelled' : 'interrupted', reason };
  if (reason.kind === 'interrupted') return { state: 'interrupted', reason };
  if (reason.kind === 'error' || reason.kind === 'blocked' || reason.kind === 'max-tokens') return { state: 'failed', reason };
  return { state: 'unknown', reason };
}

function terminalReason(value: unknown): TerminalReason {
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
