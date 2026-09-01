import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const validationModel = { provider: 'b-ai', model: 'deepseek-v4-flash', reasoningEffort: 'max' };
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

const createdSessions = [];
let approvalDirectory;
let testWorkspace;
let summary;
let failure;
const cleanupFailures = [];
try {
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dsh-mcp-live-smoke', version: '1' } });
  notify('notifications/initialized');
  const listed = await request('tools/list', {});
  if (!Array.isArray(listed.tools) || listed.tools.length !== 19) throw new Error(`Expected 19 tools, received ${String(listed.tools?.length)}`);
  testWorkspace = await mkdtemp(resolve(tmpdir(), 'dsh-mcp-live-'));

  const presetSessionId = await createSession('preset', 'simple');
  const selectedPreset = expectAccepted(await callTool('dsh.agent_preset.select', { sessionId: presetSessionId, agentPreset: 'standard' }));
  if (selectedPreset.result !== 'standard') throw new Error(`DSH returned an unexpected selected preset: ${JSON.stringify(selectedPreset.result)}`);

  const sessionId = await createSession('surface', 'simple');
  expectAccepted(await callTool('dsh.workspace.list', {}));
  expectAccepted(await callTool('dsh.session.list', {}));
  expectAccepted(await callTool('dsh.page.select_session', { sessionId }));
  expectAccepted(await callTool('dsh.page.get_context', {}));
  const models = expectAccepted(await callTool('dsh.session.models', { sessionId }));
  const selectedModel = requireValidationModel(models);
  expectAccepted(await callTool('dsh.session.select_model', { sessionId, ...selectedModel }));
  const selectedModels = expectAccepted(await callTool('dsh.session.models', { sessionId }));
  if (!JSON.stringify(selectedModels.result?.selection).includes(selectedModel.model)) throw new Error('Selected model was not projected back by DSH');
  expectAccepted(await callTool('dsh.session.command', { sessionId, command: '/permission' }));

  approvalDirectory = await mkdtemp(resolve(dirname(root), 'dsh-mcp-approval-'));
  const approvalTarget = resolve(approvalDirectory, 'blocked-write.txt');
  const approvalSessionId = await createSession('approval', 'simple', validationModel);
  expectAccepted(await callTool('dsh.session.command', { sessionId: approvalSessionId, command: '/permission workspace-write' }));
  const approvalSent = expectAccepted(await callTool('dsh.session.send_message', {
    sessionId: approvalSessionId,
    message: `This is an isolated approval validation. Call pwsh exactly once to write exactly "approval probe" to ${approvalTarget}. Set sandbox_permissions to "danger-full-access" and include a concise justification in that tool call. Do not attempt the write without escalation. Wait for the approval decision.`,
  }));
  const approvalWait = await waitTurn(approvalSent, 180_000);
  const approval = expectPending(approvalWait, 'approval');
  expectAccepted(await callTool('dsh.session.respond_approval', { sessionId: approvalSessionId, pendingInteractionId: approval.pendingInteractionId, outcome: 'rejected' }));
  const approvalFinalWait = waitTurn(approvalSent, 180_000);
  await delay(500);
  expectAccepted(await callTool('dsh.session.cancel', { sessionId: approvalSessionId }));
  const approvalDone = expectState(await approvalFinalWait, ['cancelled', 'completed', 'failed'], 'approval turn');
  if (await exists(approvalTarget)) throw new Error('Rejected approval unexpectedly wrote the target file');

  const sent = expectAccepted(await callTool('dsh.session.send_message', { sessionId, message: 'Reply with exactly: DSH MCP smoke test passed.' }));
  const waited = await waitTurn(sent, 180_000);
  expectState(waited, ['completed'], 'basic turn');
  expectAccepted(await callTool('dsh.session.history', { sessionId }));
  expectAccepted(await callTool('dsh.session.snapshot', { sessionId }));
  expectAccepted(await callTool('dsh.session.context_stats', { sessionId }));
  expectAccepted(await callTool('dsh.command.compact', { sessionId }));

  const questionSessionId = await createSession('question', 'simple', validationModel);
  const questionSent = expectAccepted(await callTool('dsh.session.send_message', {
    sessionId: questionSessionId,
    message: 'Call ask_user_question exactly once. Ask one question with id "continue", text "Continue the MCP validation?", and options "yes" and "no". After receiving the answer, call no other tools; reply exactly "QUESTION ANSWER RECEIVED" and end the turn.',
  }));
  const questionWait = await waitTurn(questionSent, 180_000);
  const question = expectPending(questionWait, 'question');
  const answers = question.questions.map((item) => item.options[0] === undefined
    ? { id: item.id, selected: [], custom: 'yes' }
    : { id: item.id, selected: [item.options[0].label] });
  expectAccepted(await callTool('dsh.session.answer_question', { sessionId: questionSessionId, pendingInteractionId: question.pendingInteractionId, answers }));
  const questionDone = expectState(await waitTurn(questionSent, 180_000), ['completed'], 'question turn');

  const cancelSessionId = await createSession('cancel', 'simple', validationModel);
  const cancelSent = expectAccepted(await callTool('dsh.session.send_message', {
    sessionId: cancelSessionId,
    message: 'Produce a detailed 5000-word technical essay. Do not finish early.',
  }));
  const cancelWait = waitTurn(cancelSent, 180_000);
  await delay(500);
  expectAccepted(await callTool('dsh.session.cancel', { sessionId: cancelSessionId }));
  const cancelDone = expectState(await cancelWait, ['cancelled'], 'cancelled turn');

  summary = {
    ok: true,
    toolCount: listed.tools.length,
    exercisedTools: 19,
    states: { basic: waited.state, question: questionDone.state, cancel: cancelDone.state, approval: approvalDone.state },
    selectedModel,
    finalAnswer: waited.finalAnswer,
  };
} catch (error) {
  failure = error;
} finally {
  for (const sessionId of createdSessions.reverse()) {
    try {
      expectAccepted(await callTool('dsh.session.cancel', { sessionId }));
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      expectAccepted(await callTool('dsh.session.archive', { sessionId }));
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (approvalDirectory !== undefined) {
    try {
      await rm(approvalDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (testWorkspace !== undefined) {
    try {
      await rm(testWorkspace, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  child.kill();
}

if (failure !== undefined) throw failure;
if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'Live smoke cleanup failed');
console.log(JSON.stringify(summary));

async function createSession(label, agentPreset, modelSelection) {
  if (testWorkspace === undefined) throw new Error('Live smoke workspace is not initialized');
  const sessionId = `session-mcp-smoke-${label}-${randomUUID()}`;
  expectAccepted(await callTool('dsh.session.create', { cwd: testWorkspace, sessionId, ...(agentPreset === undefined ? {} : { agentPreset }) }));
  createdSessions.push(sessionId);
  if (modelSelection !== undefined) expectAccepted(await callTool('dsh.session.select_model', { sessionId, ...modelSelection }));
  return sessionId;
}

async function waitTurn(sent, timeoutMs) {
  if (typeof sent.turnRef !== 'string') throw new Error('send_message did not return a turnRef');
  return structured(await callTool('dsh.session.wait_turn', { turnRef: sent.turnRef, timeoutMs }));
}

function expectState(value, allowed, label) {
  if (!allowed.includes(value.state)) throw new Error(`${label} ended in state ${String(value.state)}: ${String(value.reason)}`);
  return value;
}

function expectPending(value, kind) {
  expectState(value, ['pending-human-input'], `${kind} turn`);
  const interaction = value.pendingInteraction;
  if (typeof interaction !== 'object' || interaction === null || interaction.kind !== kind || typeof interaction.pendingInteractionId !== 'string') {
    throw new Error(`wait_turn returned no ${kind} interaction: ${JSON.stringify(value)}`);
  }
  if (kind === 'question' && (!Array.isArray(interaction.questions) || interaction.questions.length === 0)) {
    throw new Error(`wait_turn returned no answerable questions: ${JSON.stringify(interaction)}`);
  }
  return interaction;
}

function requireValidationModel(models) {
  const catalog = models.result?.catalog;
  if (typeof catalog !== 'object' || catalog === null || !Array.isArray(catalog.groups)) throw new Error('DSH returned no model groups');
  const group = catalog.groups.find((item) => typeof item === 'object' && item !== null && item.id === validationModel.provider);
  const model = Array.isArray(group?.models) ? group.models.find((item) => typeof item === 'object' && item !== null && item.id === validationModel.model) : undefined;
  const efforts = model?.reasoning?.efforts;
  if (!Array.isArray(efforts) || !efforts.some((effort) => effort?.id === validationModel.reasoningEffort)) {
    throw new Error('DSH does not currently expose DeepSeek V4 Flash with max reasoning');
  }
  return validationModel;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && error.code === 'ENOENT') return false;
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

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
    throw new Error(`Tool returned no structured content: ${JSON.stringify(result)}`);
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
