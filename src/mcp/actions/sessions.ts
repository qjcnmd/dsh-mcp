import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ActionRuntime } from './common.js';
import { mutateResult, projectToolResult, readResult, registerAction, requestSignal } from './common.js';

const sessionId = z.string().trim().min(1);
const workspaceId = z.string().trim().min(1);

export function registerSessionActions(server: McpServer, runtime: ActionRuntime): void {
  registerAction(server, 'dsh.session.list', {
    description: 'List DSH sessions with bounded summaries.',
    inputSchema: z.object({ cursor: z.string().trim().min(1).optional() }),
  }, (args, ctx) => readResult(runtime.rpc.session.list(args.cursor === undefined ? {} : { cursor: args.cursor }, requestSignal(ctx))));

  registerAction(server, 'dsh.session.create', {
    description: 'Create a DSH session in an explicit workspace or directory.',
    inputSchema: z.object({
      workspaceId: workspaceId.optional(),
      cwd: z.string().trim().min(1).optional(),
      sessionId: sessionId.optional(),
      agentPreset: z.string().trim().min(1).optional(),
    }).refine((value) => value.workspaceId !== undefined || value.cwd !== undefined, 'workspaceId or cwd is required')
      .refine((value) => !(value.workspaceId !== undefined && value.cwd !== undefined), 'workspaceId and cwd are mutually exclusive'),
  }, (args, ctx) => mutateResult(runtime.rpc.session.create({
    ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
    ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
    ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
  }, requestSignal(ctx)), { workspaceId: args.workspaceId ?? null, cwd: args.cwd ?? null }));

  registerAction(server, 'dsh.session.history', {
    description: 'Read one bounded page of an explicitly targeted DSH session history.',
    inputSchema: z.object({
      sessionId,
      beforeSeq: z.number().int().nonnegative().optional(),
      maxMessages: z.number().int().positive().max(200).default(50),
    }),
  }, async (args, ctx) => {
    const signal = requestSignal(ctx);
    const snapshot = await runtime.events.sessionSnapshot(args.sessionId, args.maxMessages, signal);
    if (args.beforeSeq === undefined) {
      return projectToolResult({ target: { sessionId: args.sessionId }, accepted: true, effect: 'applied', result: { records: snapshot.records, hasMore: snapshot.hasMore, throughSeq: snapshot.cursor } });
    }
    return readResult(runtime.rpc.session.page({ sessionId: args.sessionId, throughSeq: snapshot.cursor, beforeSeq: args.beforeSeq, maxMessages: args.maxMessages }, signal));
  });

  registerAction(server, 'dsh.agent_preset.select', {
    description: 'Select a preset for one explicitly targeted blank session.',
    inputSchema: z.object({ sessionId, agentPreset: z.string().trim().min(1) }),
  }, (args, ctx) => mutateResult(runtime.rpc.agentPresets.select(args, requestSignal(ctx)), { sessionId: args.sessionId, agentPreset: args.agentPreset }));
}
