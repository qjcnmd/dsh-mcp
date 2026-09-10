import type { DshSessionSummary } from '../dsh/rpc-client.js';
import { sameDirectory, unsupportedSession } from '../dsh/session-scope.js';
import { isRecord } from '../value-guards.js';
import { DshMcpError } from '../errors.js';

export interface ModelSelectionView { provider: string; model: string; reasoningEffort: string | null; }

export function projectSessions(sessions: DshSessionSummary[], archivedIds: string[], projectDirectory: string) {
  const archived = new Set(archivedIds);
  return sessions
    .filter((session) => session.origin !== 'subagent' && session.parentSessionId === undefined && !archived.has(session.sessionId) && sameDirectory(session.cwd, projectDirectory))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
    .map((session) => ({
      sessionId: session.sessionId,
      title: typeof session.projections?.values.title === 'string' ? session.projections.values.title : null,
      status: session.running ? 'running' as const : 'idle' as const,
      blank: session.blank,
      updatedAt: session.updatedAt,
      model: sessionModelSelection(session.projections?.values),
      unsupportedReason: unsupportedSession(session.projections?.values),
    }));
}

/** A keyset cursor excludes newer activity without keeping another session snapshot. */
export function pageSessions(items: ReturnType<typeof projectSessions>, projectDirectory: string, limit: number, cursor?: string) {
  let remaining = items;
  if (cursor !== undefined) {
    let value: unknown;
    try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw invalidSessionCursor(); }
    if (!isRecord(value) || value.cwd !== projectDirectory || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || typeof value.sessionId !== 'string') throw invalidSessionCursor();
    const { updatedAt, sessionId } = value;
    remaining = items.filter((item) => item.updatedAt < updatedAt || (item.updatedAt === updatedAt && item.sessionId.localeCompare(sessionId) > 0));
  }
  const selected = remaining.slice(0, limit);
  const hasMore = remaining.length > selected.length;
  const last = selected.at(-1);
  const nextCursor = hasMore && last !== undefined ? Buffer.from(JSON.stringify({ cwd: projectDirectory, updatedAt: last.updatedAt, sessionId: last.sessionId })).toString('base64url') : null;
  return { items: selected, hasMore, nextCursor };
}

function invalidSessionCursor(): DshMcpError { return new DshMcpError('invalid-cursor', 'The session-list cursor is invalid or belongs to another project.'); }

export function sessionModelSelection(values: Record<string, unknown> | undefined): ModelSelectionView | null {
  const selection = isRecord(values?.modelSelection) ? values.modelSelection : undefined;
  return modelSelection(selection?.next) ?? modelSelection(selection?.lastUsed);
}

function modelSelection(value: unknown): ModelSelectionView | null {
  return isRecord(value) && typeof value.provider === 'string' && typeof value.model === 'string'
    ? { provider: value.provider, model: value.model, reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : null }
    : null;
}
