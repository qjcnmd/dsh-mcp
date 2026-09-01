import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ActionRuntime } from './common.js';
import { mutateResult, projectToolResult, registerAction, requestSignal } from './common.js';

const sessionId = z.string().trim().min(1);
const pendingInteractionId = z.string().trim().min(1);

export function registerInterventionActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.cancel', {
    description: 'Cancel the active turn for one explicitly targeted session while preserving queued work.',
    inputSchema: z.object({ sessionId }),
  }, (args, ctx) => mutateResult(runtime.rpc.session.cancel(args, requestSignal(ctx)), { sessionId: args.sessionId }));

  registerAction(server, 'dsh.session.respond_approval', {
    description: 'Resolve one pending DSH approval with a one-shot grant or rejection.',
    inputSchema: z.object({ sessionId, pendingInteractionId, outcome: z.enum(['allowed-once', 'rejected']) }),
  }, (args, ctx) => respond(runtime, args.sessionId, args.pendingInteractionId, 'approval', args.outcome, requestSignal(ctx)));

  registerAction(server, 'dsh.session.answer_question', {
    description: 'Answer one pending DSH question batch by its interaction identity.',
    inputSchema: z.object({
      sessionId,
      pendingInteractionId,
      answers: z.array(z.object({ id: z.string().min(1), selected: z.array(z.string()), custom: z.string().optional() })).min(1),
    }),
  }, (args, ctx) => respond(runtime, args.sessionId, args.pendingInteractionId, 'question', { answers: args.answers }, requestSignal(ctx)));
}

async function respond(runtime: ActionRuntime, sessionId: string, interactionId: string, kind: 'approval' | 'question', value: unknown, signal: AbortSignal) {
  const pending = runtime.pending.get(interactionId);
  if (pending === undefined) {
    return { ...projectToolResult({ target: { sessionId, pendingInteractionId: interactionId }, accepted: false, effect: 'rejected', error: { code: 'pending-interaction-not-found', message: 'The pending interaction is no longer available.' } }), isError: true };
  }
  if (pending.sessionId !== sessionId || pending.kind !== kind) {
    return { ...projectToolResult({ target: { sessionId, pendingInteractionId: interactionId }, accepted: false, effect: 'rejected', error: { code: 'pending-interaction-mismatch', message: 'The pending interaction does not match the requested session or response type.' } }), isError: true };
  }
  const receipt = await runtime.events.respondRemoteInteraction(interactionId, value, signal);
  if (!receipt.ok) {
    return projectToolResult({ target: { sessionId, pendingInteractionId: interactionId }, accepted: false, effect: 'rejected', error: { code: receipt.error.dshCode, message: receipt.error.message } });
  }
  runtime.turns.resolveInteraction(interactionId);
  runtime.pending.remove(interactionId);
  return projectToolResult({ target: { sessionId, pendingInteractionId: interactionId }, accepted: true, effect: 'applied', result: { accepted: true } });
}
