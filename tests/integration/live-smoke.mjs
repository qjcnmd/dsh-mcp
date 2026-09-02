import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const validationModel = { provider: 'aliyun', model: 'qwen3.8-flash', reasoningEffort: 'high' };
const child = spawn(process.execPath, ['dist/server.js'], { cwd: root, env: { ...process.env, DSH_BASE_URL: process.env.DSH_BASE_URL ?? 'http://127.0.0.1:3080/', DSH_MCP_LOG_LEVEL: 'silent' }, stdio: ['pipe', 'pipe', 'pipe'] });
let nextId = 1;
let stdout = '';
let stderr = '';
const pending = new Map();
const createdSessions = [];
const cleanupFailures = [];
let testDirectory;
let approvalDirectory;
let failure;
let summary;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  for (let newline = stdout.indexOf('\n'); newline >= 0; newline = stdout.indexOf('\n')) {
    const line = stdout.slice(0, newline).trim();
    stdout = stdout.slice(newline + 1);
    if (line !== '') consume(JSON.parse(line));
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
child.once('exit', (code) => {
  for (const waiter of pending.values()) waiter.reject(new Error(`MCP process exited with code ${String(code)}: ${redact(stderr)}`));
  pending.clear();
});

try {
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dsh-mcp-live-smoke', version: '1' } });
  notify('notifications/initialized');
  const listed = await request('tools/list', {});
  if (!Array.isArray(listed.tools) || listed.tools.length !== 19 || listed.tools.some((tool) => tool.outputSchema === undefined)) throw new Error('Expected 19 tools with output schemas');

  const workspacePage = await tool('dsh.workspace.list', { limit: 100 });
  if (workspacePage.value.items.length === 0) throw new Error('DSH returned no workspaces');
  const queriedWorkspaces = await tool('dsh.workspace.list', { query: workspacePage.value.items[0].workspaceId });
  if (!queriedWorkspaces.value.items.some((item) => item.workspaceId === workspacePage.value.items[0].workspaceId)) throw new Error('Workspace query did not preserve its target');

  const hundred = await tool('dsh.session.list', { limit: 100 });
  if (hundred.value.items.length < 100) throw new Error(`Expected at least 100 visible sessions, received ${hundred.value.items.length}`);
  const first = await tool('dsh.session.list', { status: 'idle', limit: 3 });
  if (!first.value.hasMore || typeof first.value.nextCursor !== 'string') throw new Error('Session paging did not return a continuation');
  const second = await tool('dsh.session.list', { status: 'idle', limit: 3, cursor: first.value.nextCursor });
  const firstIds = new Set(first.value.items.map((item) => item.sessionId));
  if (second.value.items.some((item) => firstIds.has(item.sessionId))) throw new Error('Session pages overlap');
  const queryTarget = hundred.value.items[0];
  const queryResult = await tool('dsh.session.list', { query: queryTarget.sessionId, limit: 20 });
  if (!queryResult.value.items.some((item) => item.sessionId === queryTarget.sessionId)) throw new Error('Session metadata query did not preserve its target');
  const workspaceWithSessions = workspacePage.value.items.find((item) => item.sessionCount > 0);
  if (workspaceWithSessions !== undefined) {
    const filtered = await tool('dsh.session.list', { workspaceId: workspaceWithSessions.workspaceId, limit: 100 });
    if (filtered.value.items.some((item) => item.workspaceId !== workspaceWithSessions.workspaceId)) throw new Error('Workspace filter returned a mismatched session');
  }

  testDirectory = await mkdtemp(resolve(tmpdir(), 'dsh-mcp-live-'));
  const presetSessionId = await createSession('preset', 'simple');
  const preset = await tool('dsh.agent_preset.select', { sessionId: presetSessionId, agentPreset: 'standard' });
  if (preset.value.agentPreset !== 'standard') throw new Error('Preset selection was not confirmed');

  const sessionId = await createSession('surface', 'simple');
  if ((await tool('dsh.page.select_session', { sessionId })).value.selectedSessionId !== sessionId) throw new Error('Read-context selection failed');
  if ((await tool('dsh.page.get_context', {})).value.selectedSessionId !== sessionId) throw new Error('Read context did not retain the target');
  const models = await tool('dsh.session.models', { sessionId });
  const modelAdvertised = models.value.models.some((item) => item.provider === validationModel.provider && item.model === validationModel.model && item.reasoningEfforts.includes(validationModel.reasoningEffort));
  await tool('dsh.session.select_model', { sessionId, ...validationModel });
  const selected = await tool('dsh.session.models', { sessionId });
  if (JSON.stringify(selected.value.selection) !== JSON.stringify(validationModel)) throw new Error(`Model selection mismatch: ${JSON.stringify(selected.value.selection)}`);
  await tool('dsh.session.command', { sessionId, command: '/permission' });

  const sent = await tool('dsh.session.send_message', { sessionId, message: 'Reply with exactly: DSH MCP smoke test passed.' });
  if (sent.value.mode !== 'steer') throw new Error('Omitted message mode was not steer');
  const completed = await waitTurn(sent.value.turnRef, 180_000);
  requireState(completed.value, ['completed'], 'basic turn');
  if (!completed.text.includes('DSH MCP smoke test passed.')) throw new Error(`Unexpected final response: ${completed.text}`);
  if (JSON.stringify(completed.value).includes('DSH MCP smoke test passed.')) throw new Error('Final response was duplicated in structured metadata');
  const history = await tool('dsh.session.history', { sessionId });
  if (history.value.turns.length !== 1 || !history.value.turns[0].finalResponse?.includes('DSH MCP smoke test passed.')) throw new Error('Projected history did not return the completed turn');
  await tool('dsh.session.snapshot', { sessionId });
  await tool('dsh.session.context_stats', { sessionId });
  await tool('dsh.command.compact', { sessionId });

  const queueSessionId = await createSession('queue', 'simple', validationModel);
  const queueFirst = await tool('dsh.session.send_message', { sessionId: queueSessionId, message: 'Call pwsh once with Start-Sleep -Seconds 3, then reply exactly FIRST DONE.' });
  await delay(250);
  const queued = await tool('dsh.session.send_message', { sessionId: queueSessionId, message: 'Reply exactly SECOND DONE.', mode: 'queue' });
  if (queued.value.mode !== 'queue') throw new Error('Explicit queue mode was not preserved');
  requireState((await waitTurn(queueFirst.value.turnRef, 180_000)).value, ['completed'], 'first queued-session turn');
  requireState((await waitTurn(queued.value.turnRef, 180_000)).value, ['completed'], 'queued turn');

  approvalDirectory = await mkdtemp(resolve(dirname(root), 'dsh-mcp-approval-'));
  const approvalTarget = resolve(approvalDirectory, 'blocked-write.txt');
  const approvalSessionId = await createSession('approval', 'simple', validationModel);
  await tool('dsh.session.command', { sessionId: approvalSessionId, command: '/permission workspace-write' });
  const approvalSent = await tool('dsh.session.send_message', { sessionId: approvalSessionId, message: `Call pwsh exactly once to write "approval probe" to ${approvalTarget}. Request danger-full-access with a concise justification and wait for the decision.` });
  const approvalWait = await waitTurn(approvalSent.value.turnRef, 180_000);
  const approval = requireInteraction(approvalWait.value, 'approval');
  await tool('dsh.session.respond_approval', { sessionId: approvalSessionId, pendingInteractionId: approval.pendingInteractionId, outcome: 'rejected' });
  const approvalFinal = waitTurn(approvalSent.value.turnRef, 180_000);
  await delay(500);
  await tool('dsh.session.cancel', { sessionId: approvalSessionId });
  requireState((await approvalFinal).value, ['cancelled', 'completed', 'failed', 'interrupted'], 'approval turn');
  if (await exists(approvalTarget)) throw new Error('Rejected approval wrote the target file');

  const questionSessionId = await createSession('question', 'simple', validationModel);
  const questionSent = await tool('dsh.session.send_message', { sessionId: questionSessionId, message: 'Call ask_user_question exactly once. Ask one question with id "continue", text "Continue the MCP validation?", and options "yes" and "no". Then reply exactly QUESTION ANSWER RECEIVED.' });
  const question = requireInteraction((await waitTurn(questionSent.value.turnRef, 180_000)).value, 'question');
  const answers = question.questions.map((item) => ({ id: item.id, selected: item.options[0] === undefined ? [] : [item.options[0].label], ...(item.options[0] === undefined ? { custom: 'yes' } : {}) }));
  await tool('dsh.session.answer_question', { sessionId: questionSessionId, pendingInteractionId: question.pendingInteractionId, answers });
  requireState((await waitTurn(questionSent.value.turnRef, 180_000)).value, ['completed'], 'question turn');

  const cancelSessionId = await createSession('cancel', 'simple', validationModel);
  const cancelSent = await tool('dsh.session.send_message', { sessionId: cancelSessionId, message: 'Call pwsh with Start-Sleep -Seconds 20, then write a long response.' });
  const cancelWait = waitTurn(cancelSent.value.turnRef, 180_000);
  await delay(500);
  await tool('dsh.session.cancel', { sessionId: cancelSessionId });
  requireState((await cancelWait).value, ['cancelled'], 'cancelled turn');

  summary = { ok: true, toolCount: listed.tools.length, visibleSessionCount: hundred.value.items.length, model: validationModel, modelAdvertised, states: { completed: completed.value.state, approval: 'input_required', question: 'input_required', cancellation: 'cancelled', queue: 'completed' }, finalResponseOnce: true };
} catch (error) {
  failure = error;
} finally {
  for (const sessionId of createdSessions.reverse()) {
    try { await tool('dsh.session.cancel', { sessionId }); } catch (error) { cleanupFailures.push(error); }
    try {
      const receipt = await tool('dsh.session.archive', { sessionId });
      if (receipt.value.archived !== true) throw new Error(`Archive not confirmed for ${sessionId}`);
    } catch (error) { cleanupFailures.push(error); }
  }
  for (const path of [approvalDirectory, testDirectory]) {
    if (path === undefined) continue;
    try { await rm(path, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
  }
  child.kill();
}

if (failure !== undefined) throw failure;
if (cleanupFailures.length !== 0) throw new AggregateError(cleanupFailures, 'Live smoke cleanup failed');
console.log(JSON.stringify(summary));

async function createSession(label, agentPreset, model) {
  if (testDirectory === undefined) throw new Error('Test directory is unavailable');
  const sessionId = `session-mcp-smoke-${label}-${randomUUID()}`;
  const created = await tool('dsh.session.create', { cwd: testDirectory, sessionId, agentPreset });
  if (created.value.sessionId !== sessionId) throw new Error('DSH returned a different session ID');
  createdSessions.push(sessionId);
  if (model !== undefined) await tool('dsh.session.select_model', { sessionId, ...model });
  return sessionId;
}

async function waitTurn(turnRef, timeoutMs) {
  return tool('dsh.session.wait_turn', { turnRef, timeoutMs });
}

function requireState(value, allowed, label) {
  if (!allowed.includes(value.state)) throw new Error(`${label} ended in ${String(value.state)}: ${JSON.stringify(value.reason)}`);
}

function requireInteraction(value, kind) {
  requireState(value, ['input_required'], `${kind} turn`);
  const interaction = value.pendingInteraction;
  if (interaction?.kind !== kind || typeof interaction.pendingInteractionId !== 'string') throw new Error(`Missing ${kind} interaction: ${JSON.stringify(value)}`);
  if (kind === 'question' && (!Array.isArray(interaction.questions) || interaction.questions.length === 0)) throw new Error('Question interaction has no questions');
  return interaction;
}

async function tool(name, args) {
  const result = await request('tools/call', { name, arguments: args });
  if (result?.isError === true) throw new Error(`${name}: ${result.content?.[0]?.text ?? JSON.stringify(result.structuredContent)}`);
  if (typeof result?.structuredContent !== 'object' || result.structuredContent === null) throw new Error(`${name} returned no structured content`);
  return { value: result.structuredContent, text: Array.isArray(result.content) ? result.content.filter((item) => item?.type === 'text').map((item) => item.text).join('\n') : '' };
}

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => { pending.delete(id); rejectRequest(new Error(`MCP request timed out: ${method}`)); }, 200_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolveRequest(value); }, reject: (error) => { clearTimeout(timer); rejectRequest(error); } });
  });
}

function notify(method) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); }
function consume(message) {
  if (typeof message !== 'object' || message === null || !('id' in message)) return;
  const waiter = pending.get(message.id);
  if (waiter === undefined) return;
  pending.delete(message.id);
  if ('error' in message) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
}
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
async function exists(path) { try { await access(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
function redact(value) { return value.replace(/(token=)[A-Za-z0-9_-]+/gi, '$1<redacted>'); }
