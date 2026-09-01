import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ActionRuntime } from './common.js';
import { mutateResult, projectToolResult, registerAction, requestSignal } from './common.js';

const sessionId = z.string().trim().min(1);

export function registerWorkspaceActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.workspace.list', {
    description: 'List the current DSH workspace baseline and archived session identities.',
    inputSchema: z.object({}),
  }, async (_args, ctx) => {
    const result = await runtime.events.workspaceSnapshot(requestSignal(ctx));
    return projectToolResult({ accepted: true, effect: 'applied', result });
  });

  registerAction(server, 'dsh.session.archive', {
    description: 'Archive one explicitly targeted DSH session.',
    inputSchema: z.object({ sessionId }),
  }, (args, ctx) => mutateResult(runtime.rpc.workspace.archiveSession(args, requestSignal(ctx)), { sessionId: args.sessionId }));
}
