import type { McpServer, ServerContext, StandardSchemaWithJSON, ToolCallback } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { DshRuntime } from '../transport.js';
import { DshDomainError, DshMcpError, isAbortError } from '../../errors.js';
import { projectToolResult, type ProjectedToolResult } from '../result-projection.js';
export { projectToolResult };

const errorOutputSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    target: z.union([z.record(z.string(), z.string()), z.null()]),
  }),
});

type ErrorOutput = z.infer<typeof errorOutputSchema>;
export type ToolErrorResult = ProjectedToolResult<ErrorOutput> & { isError: true };
type ActionResult<O extends StandardSchemaWithJSON> = ProjectedToolResult<StandardSchemaWithJSON.InferOutput<O> & Record<string, unknown>> | ToolErrorResult;

export const idSchema = z.string().trim().min(1);
export const reasonSchema = z.object({ kind: z.string(), code: z.string().nullable(), message: z.string().nullable() });
export const modelSelectionSchema = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().nullable() });
export const sessionSummarySchema = z.object({ sessionId: idSchema, title: z.string().nullable(), status: z.enum(['running', 'idle']), blank: z.boolean(), updatedAt: z.number(), model: modelSelectionSchema.nullable(), unsupportedReason: z.string().nullable() });

const READ_ONLY_ACTIONS = new Set(['dsh.session.list', 'dsh.session.models', 'dsh.session.wait_turn']);

export function requestSignal(ctx: ServerContext): AbortSignal {
  return ctx.mcpReq.signal;
}

export function registerAction<S extends StandardSchemaWithJSON, O extends StandardSchemaWithJSON>(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema: S; outputSchema: O },
  handler: (args: StandardSchemaWithJSON.InferOutput<S>, ctx: ServerContext) => ActionResult<O> | Promise<ActionResult<O>>,
): void {
  const callback = (async (args: StandardSchemaWithJSON.InferOutput<S>, ctx: ServerContext) => {
    try {
      return await handler(args, ctx);
    } catch (error) {
      return toolError(error);
    }
  }) as ToolCallback<S>;
  server.registerTool<StandardSchemaWithJSON, S>(name, {
    ...config,
    annotations: { readOnlyHint: READ_ONLY_ACTIONS.has(name), destructiveHint: !READ_ONLY_ACTIONS.has(name), idempotentHint: READ_ONLY_ACTIONS.has(name), openWorldHint: true },
    outputSchema: portableOutputSchema(config.outputSchema),
  }, callback);
}

export function toolExecutionError(
  code: string,
  message: string,
  target: Record<string, string> | null = null,
): ToolErrorResult {
  return {
    ...projectToolResult({ error: { code, message, target } }, message),
    isError: true,
  };
}

export function toolError(error: unknown, target: Record<string, string> = {}): ToolErrorResult {
  if (isAbortError(error)) throw error;
  if (error instanceof DshMcpError) {
    const { dshCode: _dshCode, ...details } = error.details;
    return toolExecutionError(error instanceof DshDomainError ? error.dshCode : error.code, error.message, stringTarget({ ...details, ...target }));
  }
  return toolExecutionError('internal-error', error instanceof Error ? error.message : 'Unexpected DSH MCP failure.', stringTarget(target));
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
