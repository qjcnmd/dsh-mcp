import { InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/server';
import { createMcpServer } from '../../src/mcp/transport.js';
import type { DshRuntime } from '../../src/mcp/transport.js';
import { loadConfig } from '../../src/config.js';
import { DshRpcClient } from '../../src/dsh/rpc-client.js';
import { DshEventClient, type SessionFollowSnapshot } from '../../src/dsh/event-client.js';
import type { SessionHistoryRecord } from '../../src/dsh/rpc-client.js';
import { SessionObserver } from '../../src/dsh/observation.js';
import { TurnStore } from '../../src/domain/turns.js';

type RpcOverrides = { session?: Partial<DshRpcClient['session']>; workspace?: Partial<DshRpcClient['workspace']>; setFullAccess?: DshRpcClient['setFullAccess'] };
type EventOverrides = Partial<Pick<DshEventClient, 'subscribeSession' | 'sessionSnapshot' | 'archivedSessionIds' | 'workspaceSnapshot'>>;

export function testRuntime(overrides: { rpc?: RpcOverrides; events?: EventOverrides; turns?: TurnStore } = {}): DshRuntime {
  const config = loadConfig({});
  const unexpected = (): never => { throw new Error('Unexpected DSH call: configure the test dependency explicitly.'); };
  const rpc = new DshRpcClient(config, unexpected);
  Object.assign(rpc.session, overrides.rpc?.session);
  Object.assign(rpc.workspace, overrides.rpc?.workspace);
  if (overrides.rpc?.setFullAccess) rpc.setFullAccess = overrides.rpc.setFullAccess;
  const events = Object.assign(new DshEventClient(config, unexpected), {
    subscribeSession: unexpected, sessionSnapshot: unexpected, archivedSessionIds: unexpected, workspaceSnapshot: unexpected,
  }, overrides.events);
  const dependencies = { rpc, events, turns: overrides.turns ?? new TurnStore() };
  return Object.assign(dependencies, { observations: new SessionObserver(dependencies) });
}

export function followSnapshot(records: SessionHistoryRecord[] = [], overrides: Partial<Omit<SessionFollowSnapshot, 'records'>> = {}): SessionFollowSnapshot {
  const cursor = records.at(-1)?.event.seq;
  return {
    type: 'snapshot', cursor: typeof cursor === 'number' ? cursor : 0, hasMore: false, ...overrides, records,
    header: { id: 'session-test', cwd: process.cwd(), ...overrides.header },
    projections: { asOfSeq: typeof cursor === 'number' ? cursor : 0, ...overrides.projections, values: { agentPreset: 'minimal', permissions: { currentValue: 'danger-full-access' }, ...overrides.projections?.values } },
  };
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

export async function callMcpTool(runtime: Parameters<typeof createMcpServer>[0], name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return await mcpRequest(runtime, 'tools/call', { name, arguments: args }) as CallToolResult;
}

export async function mcpRequest(runtime: Parameters<typeof createMcpServer>[0], method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const server = createMcpServer(runtime);
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const responses = new Map<number, (message: Record<string, unknown>) => void>();
  client.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') responses.get(message.id)?.(message as Record<string, unknown>);
  };
  const request = async (id: number, method: string, params: Record<string, unknown>) => {
    const response = new Promise<Record<string, unknown>>((resolve) => responses.set(id, resolve));
    await client.send({ jsonrpc: '2.0', id, method, params });
    const message = await response;
    if (message.error !== undefined) throw new Error(JSON.stringify(message.error));
    return message.result as Record<string, unknown>;
  };
  try {
    await server.connect(transport);
    await client.start();
    await request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return await request(2, method, params);
  } finally {
    await client.close();
    await server.close();
  }
}
