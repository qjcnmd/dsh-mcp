import { createHash } from 'node:crypto';
import type { DshWorkspaceView, WorkspaceBaseline } from '../dsh/event-client.js';
import type { DshSessionSummary } from '../dsh/rpc-client.js';
import { DshMcpError } from '../errors.js';

export interface WorkspaceSummary {
  workspaceId: string;
  title: string;
  path: string;
  sessionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary {
  sessionId: string;
  workspaceId: string | null;
  workspaceTitle: string | null;
  title: string | null;
  cwd: string | null;
  status: 'running' | 'idle';
  blank: boolean;
  updatedAt: number;
  model: { provider: string; model: string; reasoningEffort: string | null } | null;
  agentPreset: string | null;
}

export interface Page<T> { items: T[]; hasMore: boolean; nextCursor: string | null; }
export interface PageInput { query?: string | undefined; limit?: number | undefined; cursor?: string | undefined; }
export interface SessionPageInput extends PageInput { workspaceId?: string | undefined; status?: 'running' | 'idle' | undefined; }

export function workspacePage(baseline: WorkspaceBaseline, input: PageInput): Page<WorkspaceSummary> {
  const archived = new Set(baseline.archivedSessionIds);
  const query = normalizeQuery(input.query);
  const items = baseline.items.map((workspace) => workspaceSummary(workspace, archived))
    .filter((workspace) => query === '' || [workspace.workspaceId, workspace.title, workspace.path].some((value) => value.toLocaleLowerCase().includes(query)));
  return page('workspaces', { query }, items, input, (item) => `${item.workspaceId}\0${item.updatedAt}\0${item.sessionCount}`);
}

export function sessionPage(sessions: DshSessionSummary[], baseline: WorkspaceBaseline, input: SessionPageInput): Page<SessionSummary> {
  const archived = new Set(baseline.archivedSessionIds);
  const membership = new Map<string, DshWorkspaceView>();
  for (const workspace of baseline.items) for (const sessionId of workspace.sessionIds) if (!membership.has(sessionId)) membership.set(sessionId, workspace);
  const query = normalizeQuery(input.query);
  const status = input.status ?? null;
  const workspaceId = input.workspaceId ?? null;
  const items = sessions
    .filter((session) => !archived.has(session.sessionId))
    .map((session) => sessionSummary(session, membership.get(session.sessionId)))
    .filter((session) => workspaceId === null || session.workspaceId === workspaceId)
    .filter((session) => status === null || session.status === status)
    .filter((session) => query === '' || [session.sessionId, session.title, session.cwd, session.workspaceTitle].some((value) => value?.toLocaleLowerCase().includes(query) === true))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
  return page('sessions', { query, status, workspaceId }, items, input, (item) => `${item.sessionId}\0${item.updatedAt}`);
}

export function workspaceSummary(workspace: DshWorkspaceView, archived: ReadonlySet<string>): WorkspaceSummary {
  return { workspaceId: workspace.workspaceId, title: workspace.title, path: workspace.path, sessionCount: workspace.sessionIds.filter((id) => !archived.has(id)).length, createdAt: workspace.createdAt, updatedAt: workspace.updatedAt };
}

export function sessionSummary(session: DshSessionSummary, workspace?: DshWorkspaceView): SessionSummary {
  const values = session.projections?.values;
  const selection = isRecord(values?.modelSelection) ? values.modelSelection : undefined;
  return {
    sessionId: session.sessionId,
    workspaceId: workspace?.workspaceId ?? null,
    workspaceTitle: workspace?.title ?? null,
    title: typeof values?.title === 'string' ? values.title : null,
    cwd: session.cwd ?? null,
    status: session.running ? 'running' : 'idle',
    blank: session.blank,
    updatedAt: session.updatedAt,
    model: modelSelection(selection?.next) ?? modelSelection(selection?.lastUsed),
    agentPreset: typeof values?.agentPreset === 'string' ? values.agentPreset : null,
  };
}

function page<T>(collection: 'workspaces' | 'sessions', filters: Record<string, unknown>, items: T[], input: PageInput, key: (item: T) => string): Page<T> {
  const filterHash = hash(filters);
  const resultHash = hash(items.map(key));
  const offset = input.cursor === undefined ? 0 : readCursor(input.cursor, collection, filterHash, resultHash);
  const limit = input.limit ?? 20;
  const result = items.slice(offset, offset + limit);
  const nextOffset = offset + result.length;
  const hasMore = nextOffset < items.length;
  return { items: result, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ version: 1, collection, filterHash, resultHash, offset: nextOffset })).toString('base64url') : null };
}

function readCursor(value: string, collection: string, filterHash: string, resultHash: string): number {
  let cursor: unknown;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw invalidCursor(collection); }
  if (!isRecord(cursor) || cursor.version !== 1 || cursor.collection !== collection || cursor.filterHash !== filterHash || !Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0) throw invalidCursor(collection);
  if (cursor.resultHash !== resultHash) throw new DshMcpError('stale-cursor', 'The source collection changed; restart from the first page.', { collection });
  return cursor.offset as number;
}

function invalidCursor(collection: string): DshMcpError {
  return new DshMcpError('invalid-cursor', 'The cursor does not belong to this collection and filter set.', { collection });
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}

function normalizeQuery(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? '';
}

function modelSelection(value: unknown): SessionSummary['model'] {
  return isRecord(value) && typeof value.provider === 'string' && typeof value.model === 'string'
    ? { provider: value.provider, model: value.model, reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : null }
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
