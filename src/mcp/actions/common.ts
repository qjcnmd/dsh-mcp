import type { CallToolResult, McpServer, ServerContext, StandardSchemaWithJSON, ToolCallback } from '@modelcontextprotocol/server';
import type { RpcResult } from '../../dsh/rpc-client.js';
import type { DshRuntime } from '../transport.js';
import { projectToolResult } from '../result-projection.js';
export { projectToolResult };
import { z } from 'zod';

export const toolOutputSchema = z.object({
  accepted: z.boolean().optional(),
  supported: z.boolean().optional(),
  effect: z.string().optional(),
  target: z.record(z.string(), z.unknown()).optional(),
  turnRef: z.string().optional(),
  state: z.string().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
}).passthrough();

export function requestSignal(ctx: ServerContext): AbortSignal {
  return ctx.mcpReq.signal;
}

export function registerAction<S extends StandardSchemaWithJSON>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema: S; outputSchema?: StandardSchemaWithJSON },
  handler: ToolCallback<S>,
): void {
  server.registerTool(name, { description: config.description, inputSchema: config.inputSchema, outputSchema: config.outputSchema ?? toolOutputSchema }, handler);
}

export async function readResult<T>(result: Promise<RpcResult<T>>): Promise<CallToolResult> {
  const value = await result;
  if (value.ok) return projectToolResult({ accepted: true, effect: 'applied', result: value.value });
  return projectToolResult({ accepted: false, effect: 'rejected', error: { code: value.error.dshCode, message: value.error.message } });
}

export async function mutateResult<T>(result: Promise<RpcResult<T>>, target: Record<string, unknown>): Promise<CallToolResult> {
  const value = await result;
  if (value.ok) return projectToolResult({ target, accepted: true, effect: 'applied', result: value.value });
  return projectToolResult({ target, accepted: false, effect: 'rejected', error: { code: value.error.dshCode, message: value.error.message } });
}

export function clean<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export type ActionRuntime = DshRuntime;
