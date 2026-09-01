import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { loadConfig, type DshConfig } from '../config.js';
import { DshEventClient } from '../dsh/event-client.js';
import { DshRpcClient } from '../dsh/rpc-client.js';
import { DshAuthSession } from '../dsh/auth.js';
import { TurnStore } from '../domain/turns.js';
import { PendingInteractionStore } from '../domain/pending-interactions.js';
import { PageContextStore } from '../domain/page-context.js';
import { registerTools } from './register-tools.js';

export interface DshRuntime {
  config: DshConfig;
  rpc: DshRpcClient;
  events: DshEventClient;
  turns: TurnStore;
  pending: PendingInteractionStore;
  page: PageContextStore;
}

export function createRuntime(config = loadConfig()): DshRuntime {
  const auth = new DshAuthSession(config);
  return { config, rpc: new DshRpcClient(config, auth), events: new DshEventClient(config, auth), turns: new TurnStore(), pending: new PendingInteractionStore(), page: new PageContextStore() };
}

export function createMcpServer(runtime: DshRuntime): McpServer {
  const server = new McpServer({ name: 'dsh-mcp', version: '0.1.0' });
  registerTools(server, runtime);
  return server;
}

export function startStdioServer(config = loadConfig()): StdioServerHandle {
  const runtime = createRuntime(config);
  return serveStdio(() => createMcpServer(runtime), {
    legacy: 'serve',
    onerror: (error) => {
      if (config.logLevel !== 'silent') process.stderr.write(`[dsh-mcp] ${error.message}\n`);
    },
  });
}
