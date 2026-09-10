#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { startStdioServer } from './mcp/transport.js';

try {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    process.stdout.write('Usage: dsh-mcp\n\nStarts a stdio MCP server for DSH minimal, full-access sessions.\nPass an absolute cwd to the session create and list tools to choose a workspace.\nSet DSH_BASE_URL and DSH_AUTH_TOKEN when required.\n');
  } else {
    startStdioServer(loadConfig());
  }
} catch (error) {
  process.stderr.write(`[dsh-mcp] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
