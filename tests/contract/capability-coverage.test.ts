import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { loadConfig } from '../../src/config.js';
import { createMcpServer, createRuntime } from '../../src/mcp/transport.js';

const EXPECTED_TOOLS = [
  'dsh.agent_preset.select',
  'dsh.command.compact',
  'dsh.page.get_context',
  'dsh.page.select_session',
  'dsh.session.answer_question',
  'dsh.session.archive',
  'dsh.session.cancel',
  'dsh.session.command',
  'dsh.session.context_stats',
  'dsh.session.create',
  'dsh.session.history',
  'dsh.session.list',
  'dsh.session.models',
  'dsh.session.respond_approval',
  'dsh.session.select_model',
  'dsh.session.send_message',
  'dsh.session.snapshot',
  'dsh.session.wait_turn',
  'dsh.workspace.list',
] as const;

describe('public tool surface', () => {
  it('exposes exactly the selected compact tool set', async () => {
    expect((await listToolNames()).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });
});

async function listToolNames(): Promise<string[]> {
  const server = createMcpServer(createRuntime(loadConfig({ DSH_BASE_URL: 'http://127.0.0.1:3080/' })));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const messages: unknown[] = [];
  clientTransport.onmessage = (message) => messages.push(message);
  await server.connect(serverTransport);
  await clientTransport.start();
  await clientTransport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'coverage', version: '1' } } });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await clientTransport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const response = messages.find((message) => isRecord(message) && message.id === 2);
  await clientTransport.close();
  await server.close();
  const tools = isRecord(response) && isRecord(response.result) && Array.isArray(response.result.tools) ? response.result.tools : [];
  return tools.filter(isRecord).map((tool) => typeof tool.name === 'string' ? tool.name : '').filter((name) => name !== '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
