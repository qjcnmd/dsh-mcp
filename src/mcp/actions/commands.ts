import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ActionRuntime } from './common.js';
import { projectToolResult, registerAction, requestSignal, toolExecutionError } from './common.js';

const sessionId = z.string().trim().min(1);

export function registerCommandActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.command', {
    description: 'Run one DSH slash command in an explicitly targeted session.',
    inputSchema: z.object({ sessionId, command: z.string().trim().regex(/^\/[a-z][a-z0-9_-]*(?:\s+[\s\S]*)?$/i) }),
    outputSchema: z.object({ sessionId, command: z.string(), status: z.literal('completed'), message: z.string().nullable() }),
  }, (args, ctx) => executeCommand(runtime, args.sessionId, args.command, false, requestSignal(ctx)));

  registerAction(server, 'dsh.command.compact', {
    description: 'Compact one explicitly targeted DSH session.',
    inputSchema: z.object({ sessionId }),
    outputSchema: z.object({ sessionId, compacted: z.literal(true), message: z.string().nullable() }),
  }, (args, ctx) => executeCommand(runtime, args.sessionId, '/compact', true, requestSignal(ctx)));
}

async function executeCommand(runtime: ActionRuntime, sessionId: string, line: string, compact: boolean, signal: AbortSignal) {
  const response = await runtime.rpc.commands.execute({ sessionId, line }, signal);
  if (!response.ok) {
    return toolExecutionError(response.error.dshCode, response.error.message, { sessionId });
  }
  if (response.value === undefined) {
    return toolExecutionError('command-not-found', 'Unknown DSH command.', { sessionId });
  }
  if (response.value.result.kind === 'error') return toolExecutionError('command-failed', response.value.result.text, { sessionId });
  const message = response.value.result.text ?? null;
  return compact ? projectToolResult({ sessionId, compacted: true, message }, 'Session compacted.') : projectToolResult({ sessionId, command: line, status: 'completed' as const, message }, `Command ${line} completed.`);
}
