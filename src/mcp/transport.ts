import { McpServer } from '@modelcontextprotocol/server';
import { createRequire } from 'node:module';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from '../config.js';
import { DshEventClient } from '../dsh/event-client.js';
import { DshRpcClient } from '../dsh/rpc-client.js';
import { DshAuthSession } from '../dsh/auth.js';
import { TurnStore } from '../domain/turns.js';
import { SessionObserver } from '../dsh/observation.js';
import { registerTools } from './register-tools.js';

const packageInfo: { version: string } = createRequire(import.meta.url)('../../package.json');

export interface DshRuntime {
  rpc: DshRpcClient;
  events: DshEventClient;
  turns: TurnStore;
  observations: SessionObserver;
}

export function createRuntime(config = loadConfig()): DshRuntime {
  const auth = new DshAuthSession(config);
  const dependencies = { rpc: new DshRpcClient(config, auth), events: new DshEventClient(config, auth), turns: new TurnStore() };
  return Object.assign(dependencies, { observations: new SessionObserver(dependencies) });
}

export function createMcpServer(runtime: DshRuntime): McpServer {
  const server = new McpServer({ name: 'dsh-mcp', version: packageInfo.version });
  registerTools(server, runtime);
  return server;
}

export function startStdioServer(config = loadConfig()): StdioServerHandle {
  const runtime = createRuntime(config);
  const reportError = (error: Error) => {
    if (config.logLevel !== 'silent') process.stderr.write(`[dsh-mcp] ${error.message}\n`);
  };
  const cleanup = () => {
    process.stdin.off('end', end);
    runtime.observations.close();
  };
  const end = () => { void close().catch(reportError); };
  const handle = serveStdio(() => {
    const server = createMcpServer(runtime);
    server.server.onclose = cleanup;
    return server;
  }, {
    legacy: 'serve',
    onerror: reportError,
  });
  const close = async () => {
    cleanup();
    await handle.close();
  };
  process.stdin.once('end', end);
  return { close };
}
