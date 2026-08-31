import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { loadConfig, type DshConfig } from '../config.js';
import { DshEventClient } from '../dsh/event-client.js';
import { DshRpcClient } from '../dsh/rpc-client.js';
import { RecoveryCursorStore } from '../dsh/recovery.js';
import { TurnStore } from '../domain/turns.js';
import { registerTools } from './register-tools.js';

export interface DshRuntime {
  config: DshConfig;
  rpc: DshRpcClient;
  events: DshEventClient;
  turns: TurnStore;
  cursors: RecoveryCursorStore;
}

export function createRuntime(config = loadConfig()): DshRuntime {
  return { config, rpc: new DshRpcClient(config), events: new DshEventClient(config), turns: new TurnStore(), cursors: new RecoveryCursorStore() };
}

export function createMcpServer(runtime: DshRuntime): McpServer {
  const server = new McpServer({ name: 'dsh-local-mcp', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } });
  registerTools(server, runtime);
  return server;
}

export function startStdioServer(config = loadConfig()): StdioServerHandle {
  const runtime = createRuntime(config);
  return serveStdio(() => createMcpServer(runtime), {
    legacy: 'serve',
    onerror: (error) => {
      if (config.logLevel !== 'silent') process.stderr.write(`[dsh-local-mcp] ${error.message}\n`);
    },
  });
}
