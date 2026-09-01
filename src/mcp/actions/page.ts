import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ActionRuntime } from './common.js';
import { projectToolResult, registerAction, requestSignal } from './common.js';

const sessionId = z.string().trim().min(1);

export function registerPageActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.page.select_session', {
    description: 'Select one verified DSH session as the MCP read context. Mutating tools still require an explicit target.',
    inputSchema: z.object({ sessionId }),
  }, async (args, ctx) => {
    const sessions = await runtime.rpc.session.list({}, requestSignal(ctx));
    if (!sessions.ok) return projectToolResult({ target: { sessionId: args.sessionId }, accepted: false, effect: 'rejected', error: { code: sessions.error.dshCode, message: sessions.error.message } });
    if (!sessions.value.items.some((item) => item.sessionId === args.sessionId)) {
      return projectToolResult({ target: { sessionId: args.sessionId }, accepted: false, effect: 'rejected', error: { code: 'session-not-found', message: 'The requested session is not visible.' } });
    }
    runtime.page.selectSession(args.sessionId);
    return projectToolResult({ target: { sessionId: args.sessionId }, accepted: true, effect: 'changed', selectedSessionId: args.sessionId });
  });

  registerAction(server, 'dsh.page.get_context', {
    description: 'Return the selected MCP read context with its current DSH session and workspace summaries.',
    inputSchema: z.object({}),
  }, async (_args, ctx) => {
    const selectedSessionId = runtime.page.selectedSessionId();
    if (selectedSessionId === null) return projectToolResult({ accepted: true, effect: 'applied', context: { selectedSessionId: null } });
    const signal = requestSignal(ctx);
    const [sessions, workspaces] = await Promise.all([runtime.rpc.session.list({}, signal), runtime.events.workspaceSnapshot(signal)]);
    if (!sessions.ok) return projectToolResult({ target: { sessionId: selectedSessionId }, accepted: false, effect: 'rejected', error: { code: sessions.error.dshCode, message: sessions.error.message } });
    const session = sessions.value.items.find((item) => item.sessionId === selectedSessionId) ?? null;
    const workspace = workspaces.items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(selectedSessionId)) ?? null;
    return projectToolResult({ accepted: true, effect: 'applied', context: { selectedSessionId, session, workspace } });
  });
}
