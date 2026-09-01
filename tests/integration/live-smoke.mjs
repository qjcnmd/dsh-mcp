import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sessionId = `session-mcp-smoke-${randomUUID()}`;
const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: root,
  env: {
    ...process.env,
    DSH_BASE_URL: process.env.DSH_BASE_URL ?? 'http://127.0.0.1:3080/',
    DSH_MCP_LOG_LEVEL: 'silent',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let nextId = 1;
let stdout = '';
let stderr = '';
const pending = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  let newline = stdout.indexOf('\n');
  while (newline >= 0) {
    const line = stdout.slice(0, newline).trim();
    stdout = stdout.slice(newline + 1);
    if (line !== '') consume(JSON.parse(line));
    newline = stdout.indexOf('\n');
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
child.once('exit', (code) => {
  for (const { reject } of pending.values()) reject(new Error(`MCP process exited with code ${String(code)}: ${redact(stderr)}`));
  pending.clear();
});

let created = false;
let summary;
try {
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dsh-mcp-live-smoke', version: '1' } });
  notify('notifications/initialized');
  const listed = await request('tools/list', {});
  if (!Array.isArray(listed.tools) || listed.tools.length !== 19) throw new Error(`Expected 19 tools, received ${String(listed.tools?.length)}`);

  expectAccepted(await callTool('dsh.session.create', { cwd: root, sessionId }));
  created = true;
  expectAccepted(await callTool('dsh.workspace.list', {}));
  expectAccepted(await callTool('dsh.session.list', {}));
  expectAccepted(await callTool('dsh.page.select_session', { sessionId }));
  expectAccepted(await callTool('dsh.page.get_context', {}));
  expectAccepted(await callTool('dsh.session.models', { sessionId }));
  const sent = expectAccepted(await callTool('dsh.session.send_message', { sessionId, message: 'Reply with exactly: DSH MCP smoke test passed.' }));
  if (typeof sent.turnRef !== 'string') throw new Error('send_message did not return a turnRef');
  const waited = structured(await callTool('dsh.session.wait_turn', { turnRef: sent.turnRef, timeoutMs: 180_000 }));
  if (waited.state !== 'completed') throw new Error(`wait_turn ended in state ${String(waited.state)}: ${String(waited.reason)}`);
  expectAccepted(await callTool('dsh.session.history', { sessionId }));
  expectAccepted(await callTool('dsh.session.snapshot', { sessionId }));
  expectAccepted(await callTool('dsh.session.context_stats', { sessionId }));
  summary = { ok: true, toolCount: listed.tools.length, exercisedTools: 12, state: waited.state, finalAnswer: waited.finalAnswer };
} finally {
  try {
    if (created) expectAccepted(await callTool('dsh.session.archive', { sessionId }));
  } finally {
    child.kill();
  }
}

console.log(JSON.stringify(summary));

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`MCP request timed out: ${method}`));
    }, 200_000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolveRequest(value); },
      reject: (error) => { clearTimeout(timer); rejectRequest(error); },
    });
  });
}

function notify(method) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
}

function consume(message) {
  if (typeof message !== 'object' || message === null || !('id' in message)) return;
  const waiter = pending.get(message.id);
  if (waiter === undefined) return;
  pending.delete(message.id);
  if ('error' in message) waiter.reject(new Error(JSON.stringify(message.error)));
  else waiter.resolve(message.result);
}

function callTool(name, args) {
  return request('tools/call', { name, arguments: args });
}

function structured(result) {
  if (typeof result !== 'object' || result === null || typeof result.structuredContent !== 'object' || result.structuredContent === null) {
    throw new Error('Tool returned no structured content');
  }
  return result.structuredContent;
}

function expectAccepted(result) {
  const value = structured(result);
  if (value.accepted !== true) throw new Error(`Tool rejected the operation: ${JSON.stringify(value.error)}`);
  return value;
}

function redact(value) {
  return value.replace(/(token=)[A-Za-z0-9_-]+/gi, '$1<redacted>');
}
