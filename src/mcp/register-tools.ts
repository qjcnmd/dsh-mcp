import type { McpServer } from '@modelcontextprotocol/server';
import type { DshRuntime } from './transport.js';
import { registerWorkspaceActions } from './actions/workspaces.js';
import { registerSessionActions } from './actions/sessions.js';
import { registerModelActions } from './actions/models.js';
import { registerTurnActions } from './actions/turns.js';
import { registerInterventionActions } from './actions/interventions.js';
import { registerCommandActions } from './actions/commands.js';
import { registerInspectionActions } from './actions/inspection.js';
import { registerPageActions } from './actions/page.js';

export function registerTools(server: McpServer, runtime: DshRuntime): void {
  registerWorkspaceActions(server, runtime);
  registerSessionActions(server, runtime);
  registerModelActions(server, runtime);
  registerTurnActions(server, runtime);
  registerInterventionActions(server, runtime);
  registerCommandActions(server, runtime);
  registerInspectionActions(server, runtime);
  registerPageActions(server, runtime);
}
