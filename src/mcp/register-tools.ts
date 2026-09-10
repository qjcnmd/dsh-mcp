import type { McpServer } from '@modelcontextprotocol/server';
import type { DshRuntime } from './transport.js';
import { registerSessionActions } from './actions/sessions.js';
import { registerModelActions } from './actions/models.js';
import { registerTurnActions } from './actions/turns.js';

export function registerTools(server: McpServer, runtime: DshRuntime): void {
  registerSessionActions(server, runtime);
  registerModelActions(server, runtime);
  registerTurnActions(server, runtime);
}
