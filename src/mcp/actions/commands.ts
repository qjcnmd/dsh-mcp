import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ActionRuntime } from './common.js';
import { projectToolResult, registerAction, requestSignal } from './common.js';

const sessionId = z.string().trim().min(1);

export function registerCommandActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.command', {
    description: 'Run one DSH slash command in an explicitly targeted session.',
    inputSchema: z.object({ sessionId, command: z.string().trim().regex(/^\/[a-z][a-z0-9_-]*(?:\s+[\s\S]*)?$/i) }),
  }, (args, ctx) => executeCommand(runtime, args.sessionId, args.command, requestSignal(ctx)));

  registerAction(server, 'dsh.command.compact', {
    description: 'Compact one explicitly targeted DSH session.',
    inputSchema: z.object({ sessionId }),
  }, (args, ctx) => executeCommand(runtime, args.sessionId, '/compact', requestSignal(ctx)));
}

async function executeCommand(runtime: ActionRuntime, sessionId: string, line: string, signal: AbortSignal) {
  const response = await runtime.rpc.commands.execute({ sessionId, line }, signal);
  if (!response.ok) {
    return projectToolResult({ target: { sessionId }, accepted: false, effect: 'rejected', error: { code: response.error.dshCode, message: response.error.message } });
  }
  if (response.value === undefined) {
    return projectToolResult({ target: { sessionId }, accepted: false, effect: 'rejected', error: { code: 'command-invalid', message: 'Unknown or malformed DSH command.' } });
  }
  return projectToolResult({
    target: { sessionId },
    accepted: response.value.result.kind === 'success',
    effect: response.value.result.kind === 'success' ? 'applied' : 'rejected',
    result: response.value,
  });
}
