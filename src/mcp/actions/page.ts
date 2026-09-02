import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { sessionSummary, workspaceSummary } from '../../domain/collections.js';
import type { ActionRuntime } from './common.js';
import { idSchema as id, projectToolResult, registerAction, requestSignal, sessionSummarySchema as session, toolExecutionError, workspaceSummarySchema as workspace } from './common.js';

const context = z.object({ selectedSessionId: id.nullable(), session: session.nullable(), workspace: workspace.nullable() });

export function registerPageActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.page.select_session', {
    description: 'Select one current unarchived DSH session as this MCP process read context.',
    inputSchema: z.object({ sessionId: id }),
    outputSchema: z.object({ selectedSessionId: id }),
  }, async (args, ctx) => {
    const signal = requestSignal(ctx);
    const [sessions, workspaces] = await Promise.all([runtime.rpc.session.list({}, signal), runtime.events.workspaceSnapshot(signal)]);
    if (!sessions.ok) return toolExecutionError(sessions.error.dshCode, sessions.error.message, { sessionId: args.sessionId });
    if (workspaces.archivedSessionIds.includes(args.sessionId) || !sessions.value.items.some((item) => item.sessionId === args.sessionId)) return toolExecutionError('session-not-found', 'The requested session is not visible.', { sessionId: args.sessionId });
    runtime.selectedSessionId = args.sessionId;
    return projectToolResult({ selectedSessionId: args.sessionId }, `Selected session ${args.sessionId}.`);
  });

  registerAction(server, 'dsh.page.get_context', {
    description: 'Return compact summaries for the selected read context.',
    inputSchema: z.object({}),
    outputSchema: context,
  }, async (_args, ctx) => {
    const selectedSessionId = runtime.selectedSessionId;
    if (selectedSessionId === null) return projectToolResult({ selectedSessionId: null, session: null, workspace: null }, 'No session is selected.');
    const signal = requestSignal(ctx);
    const [sessions, workspaces] = await Promise.all([runtime.rpc.session.list({}, signal), runtime.events.workspaceSnapshot(signal)]);
    if (!sessions.ok) return toolExecutionError(sessions.error.dshCode, sessions.error.message, { sessionId: selectedSessionId });
    const archived = new Set(workspaces.archivedSessionIds);
    const rawSession = archived.has(selectedSessionId) ? undefined : sessions.value.items.find((item) => item.sessionId === selectedSessionId);
    const rawWorkspace = rawSession === undefined ? undefined : workspaces.items.find((item) => item.sessionIds.includes(selectedSessionId));
    return projectToolResult({ selectedSessionId, session: rawSession === undefined ? null : sessionSummary(rawSession, rawWorkspace), workspace: rawWorkspace === undefined ? null : workspaceSummary(rawWorkspace, archived) }, `Read context for ${selectedSessionId}.`);
  });
}
