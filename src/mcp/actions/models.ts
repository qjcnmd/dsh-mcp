import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { DshSessionSummary } from '../../dsh/rpc-client.js';
import type { ActionRuntime } from './common.js';
import { projectToolResult, registerAction, requestSignal, toolExecutionError } from './common.js';

const sessionId = z.string().trim().min(1);
const selectionSchema = z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().nullable() });
const modelSchema = z.object({ provider: z.string(), model: z.string(), label: z.string().nullable(), reasoningEfforts: z.array(z.string()) });

export function registerModelActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.models', {
    description: 'Read the model catalog and effective selection for one explicitly targeted session.',
    inputSchema: z.object({ sessionId }),
    outputSchema: z.object({ sessionId, selection: selectionSchema.nullable(), models: z.array(modelSchema) }),
  }, async (args, ctx) => {
    const signal = requestSignal(ctx);
    const [catalog, sessions] = await Promise.all([
      runtime.rpc.session.modelCatalog(signal),
      runtime.rpc.session.list({}, signal),
    ]);
    if (!catalog.ok) return toolExecutionError(catalog.error.dshCode, catalog.error.message, { sessionId: args.sessionId });
    if (!sessions.ok) return toolExecutionError(sessions.error.dshCode, sessions.error.message, { sessionId: args.sessionId });
    const session = sessions.value.items.find((item) => item.sessionId === args.sessionId);
    if (session === undefined) return toolExecutionError('session-not-found', 'The requested session is not visible.', { sessionId: args.sessionId });
    const selection = readModelSelection(session);
    const routable = new Set(catalog.value.routableProviders);
    const models = catalog.value.groups.filter((group) => typeof group.id === 'string' && routable.has(group.id)).flatMap((group) => {
      if (typeof group.id !== 'string' || !Array.isArray(group.models)) return [];
      return group.models.filter(isRecord).flatMap((model) => typeof model.id === 'string' ? [{ provider: group.id as string, model: model.id, label: typeof model.name === 'string' ? model.name : null, reasoningEfforts: isRecord(model.reasoning) && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts.filter(isRecord).flatMap((effort) => typeof effort.id === 'string' ? [effort.id] : []) : [] }] : []);
    });
    return projectToolResult({ sessionId: args.sessionId, selection, models }, `${models.length} model option(s).`);
  });

  registerAction(server, 'dsh.session.select_model', {
    description: 'Select an available provider, model, and optional reasoning effort for one session.',
    inputSchema: z.object({
      sessionId,
      provider: z.string().trim().min(1),
      model: z.string().trim().min(1),
      reasoningEffort: z.string().trim().min(1).optional(),
    }),
    outputSchema: z.object({ sessionId, selected: selectionSchema }),
  }, async (args, ctx) => {
    const result = await runtime.rpc.session.selectModel({ sessionId: args.sessionId, provider: args.provider, model: args.model, ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }) }, requestSignal(ctx));
    if (!result.ok) return toolExecutionError(result.error.dshCode, result.error.message, { sessionId: args.sessionId });
    const selected = result.value.selected;
    return projectToolResult({ sessionId: args.sessionId, selected: { provider: selected.provider, model: selected.model, reasoningEffort: selected.reasoningEffort ?? null } }, `Selected ${selected.provider}/${selected.model}.`);
  });
}

function readModelSelection(session: DshSessionSummary) {
  const projection = session.projections?.values.modelSelection;
  if (!isRecord(projection)) return null;
  const value = isRecord(projection.next) ? projection.next : isRecord(projection.lastUsed) ? projection.lastUsed : undefined;
  return value !== undefined && typeof value.provider === 'string' && typeof value.model === 'string' ? { provider: value.provider, model: value.model, reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : null } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
