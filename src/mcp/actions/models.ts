import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ActionRuntime } from './common.js';
import { mutateResult, projectToolResult, registerAction, requestSignal } from './common.js';

const sessionId = z.string().trim().min(1);

export function registerModelActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.models', {
    description: 'Read the model catalog and effective selection for one explicitly targeted session.',
    inputSchema: z.object({ sessionId }),
  }, async (args, ctx) => {
    const signal = requestSignal(ctx);
    const [catalog, sessions] = await Promise.all([
      runtime.rpc.session.modelCatalog(signal),
      runtime.rpc.session.list({}, signal),
    ]);
    if (!catalog.ok) return projectToolResult({ target: { sessionId: args.sessionId }, accepted: false, effect: 'rejected', error: { code: catalog.error.dshCode, message: catalog.error.message } });
    if (!sessions.ok) return projectToolResult({ target: { sessionId: args.sessionId }, accepted: false, effect: 'rejected', error: { code: sessions.error.dshCode, message: sessions.error.message } });
    const session = sessions.value.items.find((item) => item.sessionId === args.sessionId);
    if (session === undefined) return projectToolResult({ target: { sessionId: args.sessionId }, accepted: false, effect: 'rejected', error: { code: 'session-not-found', message: 'The requested session is not visible.' } });
    const selection = readModelSelection(session);
    return projectToolResult(
      { target: { sessionId: args.sessionId }, accepted: true, effect: 'applied', result: { catalog: catalog.value, selection } },
      { maxDepth: 10 },
    );
  });

  registerAction(server, 'dsh.session.select_model', {
    description: 'Select an available provider, model, and optional reasoning effort for one session.',
    inputSchema: z.object({
      sessionId,
      provider: z.string().trim().min(1),
      model: z.string().trim().min(1),
      reasoningEffort: z.string().trim().min(1).optional(),
    }),
  }, (args, ctx) => mutateResult(runtime.rpc.session.selectModel({ sessionId: args.sessionId, provider: args.provider, model: args.model, ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }) }, requestSignal(ctx)), {
    sessionId: args.sessionId,
    provider: args.provider,
    model: args.model,
    reasoningEffort: args.reasoningEffort ?? null,
  }));
}

function readModelSelection(session: Record<string, unknown>): unknown {
  if (!isRecord(session.projections) || !isRecord(session.projections.values)) return null;
  return session.projections.values.modelSelection ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
