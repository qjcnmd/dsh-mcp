import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { sessionModelSelection } from '../../domain/collections.js';
import { isRecord } from '../../value-guards.js';
import type { ActionRuntime } from './common.js';
import { idSchema as sessionId, modelSelectionSchema as selectionSchema, projectToolResult, registerAction, requestSignal, toolError } from './common.js';

const modelSchema = z.object({ provider: z.string(), model: z.string(), label: z.string().nullable(), reasoningEfforts: z.array(z.string()), defaultReasoningEffort: z.string().nullable() });

export function registerModelActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.models', {
    description: 'Discover available provider/model IDs and supported reasoning efforts before selecting them. With sessionId, return the effective session selection; without it, return the service default. Also reports provider discovery failures.',
    inputSchema: z.object({ sessionId: sessionId.optional() }),
    outputSchema: z.object({ sessionId: sessionId.nullable(), selection: selectionSchema, selectionSource: z.enum(['session', 'default']), models: z.array(modelSchema), failures: z.array(z.object({ id: z.string(), name: z.string(), message: z.string() })) }),
  }, async (args, ctx) => {
    const signal = requestSignal(ctx);
    const [catalog, follow] = await Promise.all([runtime.rpc.session.modelCatalog(signal), args.sessionId === undefined ? undefined : runtime.events.sessionSnapshot(args.sessionId, 1, signal)]);
    if (!catalog.ok) throw catalog.error;
    const sessionSelection = sessionModelSelection(follow?.projections.values);
    const selection = sessionSelection ?? { ...catalog.value.default, reasoningEffort: catalog.value.default.reasoningEffort ?? null };
    const routable = new Set(catalog.value.routableProviders);
    const models = catalog.value.groups.flatMap((group) => {
      const provider = group.id;
      if (typeof provider !== 'string' || !routable.has(provider) || !Array.isArray(group.models)) return [];
      return group.models.flatMap((model: unknown) => {
        const projected = projectModel(provider, model);
        return projected === null ? [] : [projected];
      });
    });
    const selectionSource = sessionSelection === null ? 'default' : 'session';
    return projectToolResult({ sessionId: args.sessionId ?? null, selection, selectionSource, models, failures: catalog.value.failures }, `${models.length} model option(s).`);
  });

  registerAction(server, 'dsh.session.select_model', {
    description: 'Configure the provider, model and optional reasoning effort for a session using IDs from models. The selected result confirms the effective setting; it need not be repeated in task text. Use this tool to change model settings.',
    inputSchema: z.object({
      sessionId,
      provider: z.string().trim().min(1),
      model: z.string().trim().min(1),
      reasoningEffort: z.string().trim().min(1).optional(),
    }),
    outputSchema: z.object({ sessionId, selected: selectionSchema }),
  }, async (args, ctx) => {
    await runtime.events.sessionSnapshot(args.sessionId, 1, requestSignal(ctx));
    const result = await runtime.rpc.session.selectModel({ sessionId: args.sessionId, provider: args.provider, model: args.model, ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }) }, requestSignal(ctx));
    if (!result.ok) return toolError(result.error, { sessionId: args.sessionId });
    const selected = result.value.selected;
    return projectToolResult({ sessionId: args.sessionId, selected: { provider: selected.provider, model: selected.model, reasoningEffort: selected.reasoningEffort ?? null } }, `Selected ${selected.provider}/${selected.model}.`);
  });
}

function projectModel(provider: string, model: unknown): z.infer<typeof modelSchema> | null {
  if (!isRecord(model) || typeof model.id !== 'string') return null;
  const reasoning = isRecord(model.reasoning) ? model.reasoning : undefined;
  const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : [];
  return {
    provider,
    model: model.id,
    label: typeof model.name === 'string' ? model.name : null,
    reasoningEfforts: efforts.flatMap((effort: unknown) => isRecord(effort) && typeof effort.id === 'string' ? [effort.id] : []),
    defaultReasoningEffort: typeof reasoning?.defaultEffort === 'string' ? reasoning.defaultEffort : null,
  };
}
