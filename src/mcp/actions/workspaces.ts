import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { workspacePage } from '../../domain/collections.js';
import type { ActionRuntime } from './common.js';
import { projectToolResult, registerAction, requestSignal, toolExecutionError } from './common.js';

const sessionId = z.string().trim().min(1);
const workspaceSummary = z.object({ workspaceId: sessionId, title: z.string(), path: z.string(), sessionCount: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string() });

export function registerWorkspaceActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.workspace.list', {
    description: 'List compact DSH workspace summaries in deterministic pages.',
    inputSchema: z.object({ query: z.string().optional(), limit: z.number().int().min(1).max(100).default(20), cursor: z.string().min(1).optional() }),
    outputSchema: z.object({ items: z.array(workspaceSummary), hasMore: z.boolean(), nextCursor: z.string().nullable() }),
  }, async (_args, ctx) => {
    const result = await runtime.events.workspaceSnapshot(requestSignal(ctx));
    const page = workspacePage(result, _args);
    return projectToolResult(page, `${page.items.length} workspace(s); more: ${page.hasMore}.`);
  });

  registerAction(server, 'dsh.session.archive', {
    description: 'Archive one explicitly targeted DSH session.',
    inputSchema: z.object({ sessionId }),
    outputSchema: z.object({ sessionId, archived: z.literal(true) }),
  }, async (args, ctx) => {
    const result = await runtime.rpc.workspace.archiveSession(args, requestSignal(ctx));
    if (!result.ok) return toolExecutionError(result.error.dshCode, result.error.message, { sessionId: args.sessionId });
    if (!result.value.archivedSessionIds.includes(args.sessionId)) return toolExecutionError('archive-not-confirmed', 'DSH did not confirm the session in its archive set.', { sessionId: args.sessionId });
    return projectToolResult({ sessionId: args.sessionId, archived: true }, `Archived session ${args.sessionId}.`);
  });
}
