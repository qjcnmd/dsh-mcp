import { fileURLToPath } from 'node:url';
import { startStdioServer } from './mcp/transport.js';

export function main(): void {
  startStdioServer();
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
