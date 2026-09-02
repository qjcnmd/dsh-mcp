import type { CallToolResult, McpServer, ServerContext, StandardSchemaWithJSON, ToolCallback } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { DshRuntime } from '../transport.js';
import { DshDomainError, DshMcpError, isAbortError } from '../../errors.js';
import { projectToolResult } from '../result-projection.js';
export { projectToolResult };

const errorOutputSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    target: z.union([z.record(z.string(), z.string()), z.null()]),
  }),
});

export const idSchema = z.string().trim().min(1);
export const reasonSchema = z.object({ kind: z.string(), code: z.string().nullable(), message: z.string().nullable() });
export const modelSelectionSchema = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().nullable() });
export const sessionSummarySchema = z.object({ sessionId: idSchema, workspaceId: idSchema.nullable(), workspaceTitle: z.string().nullable(), title: z.string().nullable(), cwd: z.string().nullable(), status: z.enum(['running', 'idle']), blank: z.boolean(), updatedAt: z.number(), model: modelSelectionSchema.nullable(), agentPreset: z.string().nullable() });
export const workspaceSummarySchema = z.object({ workspaceId: idSchema, title: z.string(), path: z.string(), sessionCount: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string() });
export const questionSchema = z.object({ id: idSchema, question: z.string(), detail: z.string().optional(), header: z.string().optional(), options: z.array(z.object({ label: z.string(), description: z.string().optional() })), multiSelect: z.boolean() });
export const pendingInteractionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approval'), pendingInteractionId: idSchema, sessionId: idSchema, prompt: z.string(), options: z.array(z.object({ outcome: z.enum(['allowed-once', 'rejected']), label: z.string() })) }),
  z.object({ kind: z.literal('question'), pendingInteractionId: idSchema, sessionId: idSchema, questions: z.array(questionSchema) }),
]);

export function requestSignal(ctx: ServerContext): AbortSignal {
  return ctx.mcpReq.signal;
}

export function registerAction<S extends StandardSchemaWithJSON>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema: S; outputSchema: StandardSchemaWithJSON },
  handler: ToolCallback<S>,
): void {
  const callback = (async (args: unknown, ctx: ServerContext) => {
    try {
      return await (handler as unknown as (args: unknown, ctx: ServerContext) => CallToolResult | Promise<CallToolResult>)(args, ctx);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof DshDomainError) {
        return toolExecutionError(error.dshCode, error.message, stringTarget(Object.fromEntries(Object.entries(error.details).filter(([key]) => key !== 'dshCode'))));
      }
      if (error instanceof DshMcpError) {
        return toolExecutionError(error.code, error.message, stringTarget(error.details));
      }
      return toolExecutionError('internal-error', error instanceof Error ? error.message : 'Unexpected DSH MCP failure.');
    }
  }) as ToolCallback<S>;
  server.registerTool<StandardSchemaWithJSON, S>(name, {
    ...config,
    outputSchema: portableOutputSchema(config.outputSchema),
  }, callback);
}

export function toolExecutionError(
  code: string,
  message: string,
  target: Record<string, string> | null = null,
): CallToolResult {
  return {
    ...projectToolResult({ error: { code, message, target } }, message),
    isError: true,
  };
}

export type ActionRuntime = DshRuntime;

function stringTarget(value: Record<string, unknown>): Record<string, string> | null {
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof entry[1]))
    .map(([key, item]) => [key, String(item)]);
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

function portableOutputSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const standard = schema['~standard'];
  const error = errorOutputSchema['~standard'];
  return {
    '~standard': {
      ...standard,
      validate: async (value, options) => {
        const failure = await error.validate(value, options);
        return failure.issues === undefined ? failure : standard.validate(value, options);
      },
      jsonSchema: {
        input: (options) => combinedOutputSchema(standard.jsonSchema.input(options), error.jsonSchema.input(options)),
        output: (options) => combinedOutputSchema(standard.jsonSchema.output(options), error.jsonSchema.output(options)),
      },
    },
  };
}

function combinedOutputSchema(success: Record<string, unknown>, failure: Record<string, unknown>): Record<string, unknown> {
  const { $schema, ...successShape } = normalizeNullableTypes(success) as Record<string, unknown>;
  const { $schema: _failureSchema, ...failureShape } = normalizeNullableTypes(failure) as Record<string, unknown>;
  return { ...($schema === undefined ? {} : { $schema }), oneOf: [successShape, failureShape] };
}

function normalizeNullableTypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNullableTypes);
  if (typeof value !== 'object' || value === null) return value;
  const mapped = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeNullableTypes(item)]));
  const types = mapped.type;
  if (!Array.isArray(types) || !types.includes('null')) return mapped;
  const { type: _type, ...rest } = mapped;
  return { ...rest, anyOf: types.map((type) => ({ type })) };
}
