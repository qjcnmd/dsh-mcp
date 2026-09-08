import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMcpServer } from '../../src/mcp/transport.js';

export function disposableSessionId(): string {
  return `session-test-${crypto.randomUUID()}`;
}

export function disposableWorkspaceId(): string {
  return `workspace-test-${crypto.randomUUID()}`;
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

export function sseResponse(frames: unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function callMcpTool(runtime: Parameters<typeof createMcpServer>[0], name: string, args: Record<string, unknown>) {
  return mcpRequest(runtime, 'tools/call', { name, arguments: args });
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
