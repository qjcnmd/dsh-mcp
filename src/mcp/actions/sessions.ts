import { z } from 'zod';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { pageSessions, projectSessions } from '../../domain/collections.js';
import type { ActionRuntime } from './common.js';
import { idSchema as sessionId, projectToolResult, registerAction, requestSignal, sessionSummarySchema, toolExecutionError } from './common.js';

const cwdSchema = z.string().min(1).refine(isAbsolute, 'cwd must be an absolute directory path').transform((value) => resolve(value));

export function registerSessionActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.list', {
    description: 'List unarchived top-level DSH sessions whose working directory matches cwd, newest first. For another page, pass nextCursor as cursor with the same cwd. unsupportedReason explains why a session cannot be used.',
    inputSchema: z.object({ cwd: cwdSchema.describe('Absolute working directory to match when listing sessions.'), cursor: z.string().min(1).optional(), limit: z.number().int().min(1).max(50).default(20) }),
    outputSchema: z.object({ cwd: z.string(), items: z.array(sessionSummarySchema), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
  }, async (args, ctx) => {
    const signal = requestSignal(ctx);
    const [sessions, archived] = await Promise.all([runtime.rpc.session.list(signal), runtime.events.archivedSessionIds(signal)]);
    if (!sessions.ok) throw sessions.error;
    const items = projectSessions(sessions.value.items, archived, args.cwd);
    const page = pageSessions(items, args.cwd, args.limit, args.cursor);
    return projectToolResult({ cwd: args.cwd, ...page }, `${page.items.length} session(s); more: ${page.hasMore}.`);
  });

  registerAction(server, 'dsh.session.create', {
    description: 'Create a minimal, full-access DSH session in the workspace for cwd. Reuses the native workspace for this directory, or registers it if absent.',
    inputSchema: z.object({ cwd: cwdSchema.describe('Absolute initial working directory for the new session.') }),
    outputSchema: z.object({ sessionId, cwd: z.string(), workspaceId: z.string() }),
  }, async (args, ctx) => {
    const signal = requestSignal(ctx);
    if (!(await stat(args.cwd)).isDirectory()) return toolExecutionError('invalid-directory', `Not a directory: ${args.cwd}`);
    const registered = await runtime.rpc.workspace.create(args.cwd, signal);
    if (!registered.ok) throw registered.error;
    const { workspace } = registered.value;
    const result = await runtime.rpc.session.create({ workspaceId: workspace.workspaceId, agentPreset: 'minimal' }, signal);
    if (!result.ok) throw result.error;
    const sessionId = result.value.sessionId;
    try {
      await runtime.rpc.setFullAccess(sessionId, signal);
      await runtime.events.sessionSnapshot(sessionId, 1, signal);
      const baseline = await runtime.events.workspaceSnapshot(signal);
      if (!baseline.items.some((item) => item.workspaceId === workspace.workspaceId && item.sessionIds.includes(sessionId))) {
        throw new Error('DSH did not associate the session with its workspace');
      }
    } catch (error) {
      signal.throwIfAborted();
      return toolExecutionError('session-setup-failed', `Created ${sessionId}, but setup could not be confirmed: ${error instanceof Error ? error.message : String(error)}`, { sessionId, workspaceId: workspace.workspaceId });
    }
    return projectToolResult({ sessionId, cwd: workspace.path, workspaceId: workspace.workspaceId }, `Created session ${sessionId} in ${workspace.title}.`);
  });

}
