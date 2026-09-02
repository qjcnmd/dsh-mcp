import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ActionRuntime } from './common.js';
import { idSchema, projectToolResult, registerAction, requestSignal, toolExecutionError } from './common.js';

export function registerInterventionActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.cancel', {
    description: 'Cancel the active turn for one explicitly targeted session while preserving queued work.',
    inputSchema: z.object({ sessionId: idSchema }),
    outputSchema: z.object({ sessionId: idSchema, cancellationRequested: z.literal(true) }),
  }, async (args, ctx) => {
    const result = await runtime.rpc.session.cancel(args, requestSignal(ctx));
    if (!result.ok) return toolExecutionError(result.error.dshCode, result.error.message, { sessionId: args.sessionId });
    return projectToolResult({ sessionId: args.sessionId, cancellationRequested: true }, `Cancellation requested for ${args.sessionId}.`);
  });

  registerAction(server, 'dsh.session.respond_approval', {
    description: 'Resolve one pending DSH approval with a one-shot grant or rejection.',
    inputSchema: z.object({ sessionId: idSchema, pendingInteractionId: idSchema, outcome: z.enum(['allowed-once', 'rejected']) }),
    outputSchema: z.object({ sessionId: idSchema, pendingInteractionId: idSchema, outcome: z.enum(['allowed-once', 'rejected']), accepted: z.literal(true) }),
  }, (args, ctx) => respond(runtime, args.sessionId, args.pendingInteractionId, 'approval', args.outcome, requestSignal(ctx)));

  registerAction(server, 'dsh.session.answer_question', {
    description: 'Answer one pending DSH question batch by its interaction identity.',
    inputSchema: z.object({
      sessionId: idSchema,
      pendingInteractionId: idSchema,
      answers: z.array(z.object({ id: z.string().min(1), selected: z.array(z.string()), custom: z.string().optional() })).min(1),
    }),
    outputSchema: z.object({ sessionId: idSchema, pendingInteractionId: idSchema, accepted: z.literal(true) }),
  }, (args, ctx) => respond(runtime, args.sessionId, args.pendingInteractionId, 'question', { answers: args.answers }, requestSignal(ctx)));
}

async function respond(runtime: ActionRuntime, sessionId: string, interactionId: string, kind: 'approval' | 'question', value: unknown, signal: AbortSignal) {
  const pending = runtime.pending.get(interactionId);
  if (pending === undefined) {
    return toolExecutionError('pending-interaction-not-found', 'The pending interaction is no longer available.', { sessionId, pendingInteractionId: interactionId });
  }
  if (pending.sessionId !== sessionId || pending.kind !== kind) {
    return toolExecutionError('pending-interaction-mismatch', 'The pending interaction does not match the requested session or response type.', { sessionId, pendingInteractionId: interactionId });
  }
  const receipt = await runtime.events.respondRemoteInteraction(interactionId, value, signal);
  if (!receipt.ok) {
    return toolExecutionError(receipt.error.dshCode, receipt.error.message, { sessionId, pendingInteractionId: interactionId });
  }
  runtime.turns.resolveInteraction(interactionId);
  runtime.pending.remove(interactionId);
  return kind === 'approval'
    ? projectToolResult({ sessionId, pendingInteractionId: interactionId, outcome: value as 'allowed-once' | 'rejected', accepted: true }, 'Approval response accepted.')
    : projectToolResult({ sessionId, pendingInteractionId: interactionId, accepted: true }, 'Question answer accepted.');
}
