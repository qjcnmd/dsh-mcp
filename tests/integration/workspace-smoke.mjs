import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { StdioClient } from './stdio-client.mjs';
import { createRuntime } from '../../dist/mcp/transport.js';

// Exercises the native workspace association without sending a model prompt.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const directory = await mkdtemp(resolve(tmpdir(), 'dsh-workspace-'));
const client = new StdioClient(process.execPath, [resolve(root, 'dist/server.js')], root);
const runtime = createRuntime();
const sessions = [];
let workspaceId;
const cleanupErrors = [];
async function rpc(method, request) {
  const result = await runtime.rpc.call(method, { request });
  if (!result.ok) throw result.error;
  return result.value;
}
try {
  await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'workspace-smoke', version: '1' } });
  client.notify('notifications/initialized');
  for (let i = 0; i < 2; i++) {
    const result = await client.request('tools/call', { name: 'dsh.session.create', arguments: { cwd: directory } });
    assert.ok(!result.isError, JSON.stringify(result));
    const created = result.structuredContent;
    sessions.push(created.sessionId);
    if (workspaceId === undefined) workspaceId = created.workspaceId;
    assert.equal(created.workspaceId, workspaceId);
    const snapshot = await runtime.events.sessionSnapshot(created.sessionId);
    assert.equal(resolve(snapshot.header.cwd), resolve(created.cwd));
    const baseline = await runtime.events.workspaceSnapshot();
    const workspace = baseline.items.find((item) => item.workspaceId === workspaceId);
    assert.ok(workspace?.sessionIds.includes(created.sessionId));
    assert.equal(workspace.path, created.cwd);
  }
  console.log(JSON.stringify({ ok: true, sessions: sessions.length, workspaceReused: true, membershipVerified: true, modelPrompts: 0 }));
} finally {
  for (const sessionId of sessions) {
    try { await rpc('workspace/archiveSession', { sessionId }); } catch (error) { cleanupErrors.push(error); }
  }
  if (workspaceId !== undefined) {
    try { await rpc('workspace/delete', { workspaceId }); } catch (error) { cleanupErrors.push(error); }
  }
  runtime.observations.close();
  try { await client.close(); } catch (error) { cleanupErrors.push(error); }
  const childPath = relative(resolve(tmpdir()), directory);
  assert.ok(childPath !== '' && !childPath.startsWith('..') && !isAbsolute(childPath));
  await rm(directory, { recursive: true, force: true });
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Workspace smoke cleanup failed');
}
