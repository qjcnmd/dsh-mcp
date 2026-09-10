import { StdioClient } from './stdio-client.mjs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshRpcClient } from '../../dist/dsh/rpc-client.js';
import { DshEventClient } from '../../dist/dsh/event-client.js';
import { loadConfig } from '../../dist/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shellTool = process.platform === 'win32' ? 'pwsh' : 'bash';
const availableCases = ['recovery', 'steering', 'cancellation'];
const selectedCases = new Set(process.argv.length > 2 ? process.argv.slice(2) : availableCases);
for (const name of selectedCases) if (!availableCases.includes(name)) throw new Error('Unknown live test case: ' + name);
const clients = new Set();
const createdSessions = [];
const cleanupFailures = [];
const tempRoot = resolve(tmpdir());
const probeDirectory = await mkdtemp(resolve(tempRoot, 'dsh-mcp-live-'));
const rpc = new DshRpcClient(loadConfig());
const events = new DshEventClient(loadConfig());
let client;
let failure;
let summary;

try {
  client = await connect();
  const listed = await client.request('tools/list', {});
  if (!Array.isArray(listed.tools) || listed.tools.some((tool) => !tool.outputSchema || !tool.annotations)) throw new Error('Tools must advertise output schemas and annotations');
  if (listed.tools.length !== 7) throw new Error('Expected exactly seven tools');

  const catalog = await tool('dsh.session.models', {});
  const provider = process.env.DSH_TEST_PROVIDER ?? catalog.value.selection.provider;
  const modelId = process.env.DSH_TEST_MODEL ?? (catalog.value.selection.provider === provider ? catalog.value.selection.model : catalog.value.models.find((item) => item.provider === provider)?.model);
  const advertised = catalog.value.models.find((item) => item.provider === provider && item.model === modelId);
  if (!advertised) throw new Error('The requested test provider/model is absent from the current DSH catalog');
  const effort = process.env.DSH_TEST_REASONING_EFFORT ?? (catalog.value.selection.provider === provider && catalog.value.selection.model === modelId ? catalog.value.selection.reasoningEffort : advertised.defaultReasoningEffort);
  if (effort && !advertised.reasoningEfforts.includes(effort)) throw new Error('The test reasoning effort is not advertised for this model');
  const model = { provider, model: modelId, ...(effort ? { reasoningEffort: effort } : {}) };
  report('model', model);

  const initialSessions = await tool('dsh.session.list', { cwd: probeDirectory });
  if (initialSessions.value.cwd !== probeDirectory) throw new Error('The MCP did not use the requested workspace');
  const otherWorkspace = await tool('dsh.session.list', { cwd: root });
  if (otherWorkspace.value.cwd !== root) throw new Error('The same MCP cannot list another workspace');

  if (selectedCases.has('recovery')) {
    const sessionId = await createSession();
    await selectModel(sessionId, model);
    const nativeSnapshot = await events.sessionSnapshot(sessionId);
    if (nativeSnapshot.projections.values.agentPreset !== 'minimal') throw new Error('Session is not using the actual minimal preset');

    const requestId = randomUUID();
    const message = 'Reply with exactly: DSH MCP smoke test passed.';
    const sent = await tool('dsh.session.send_message', { sessionId, requestId, message });
    const repeated = await tool('dsh.session.send_message', { sessionId, requestId, message });
    if (sent.value.turnRef !== repeated.value.turnRef) throw new Error('A repeated logical submission changed its handle');
    const completed = await waitTurn(sent.value.turnRef);
    requireState(completed.value, ['completed'], 'basic turn');
    if (!completed.text.includes('DSH MCP smoke test passed.')) throw new Error('Missing final model response');
    if (JSON.stringify(completed.value).includes('DSH MCP smoke test passed.')) throw new Error('Final response duplicated in metadata');
    const snapshot = await events.sessionSnapshot(sessionId);
    const admitted = snapshot.records.filter(({ event }) => event.type === 'user/message' && event.surfaceOp === 'append' && event.data?.source?.rpcId === requestId);
    if (admitted.length !== 1) throw new Error('Repeated request was admitted more than once');
    await restart();
    const recovered = await waitTurn(sent.value.turnRef);
    requireState(recovered.value, ['completed'], 'cross-process wait');
    if (!recovered.text.includes('DSH MCP smoke test passed.')) throw new Error('Recovered response was incomplete');
    const adopted = await tool('dsh.session.wait_turn', { sessionId, timeoutMs: 30_000 });
    requireState(adopted.value, ['completed'], 'existing-session takeover');
    // Change only the thinking effort before a second turn in the same session.
    const otherEffort = advertised.reasoningEfforts.find((value) => value !== effort);
    const nextSelection = { ...model, ...(otherEffort ? { reasoningEffort: otherEffort } : {}) };
    await selectModel(sessionId, nextSelection);
    const target = resolve(probeDirectory, 'shared-project.txt');
    const script = process.platform === 'win32'
      ? "[System.IO.File]::WriteAllText('" + target.replaceAll("'", "''") + "', (Get-Location).Path); exit"
      : 'pwd > ' + shellQuote(target) + '; exit';
    const next = await tool('dsh.session.send_message', { sessionId, message: 'Call ' + shellTool + ' once with this exact script: ' + script + '. Then reply exactly PROJECT VERIFIED. The exit closes only this test session terminal.' });
    const result = await waitTurn(next.value.turnRef);
    requireState(result.value, ['completed'], 'continued session with changed thinking effort');
    if ((await readFile(target, 'utf8')).trim() !== probeDirectory) throw new Error('DSH did not execute from the requested workspace');
    report('durable-recovery', { repeatedRequestOnce: true, sessionTakeover: true, continuation: true, thinkingEffort: nextSelection.reasoningEffort, hostSelectedWorkspaceWrite: true });
  }

  if (selectedCases.has('steering')) {
    const sessionId = await createSession(model);
    const first = await tool('dsh.session.send_message', { sessionId, message: 'Call ' + shellTool + ' once with ' + sleepCommand(5) + '; exit, then reply exactly FIRST DONE.' });
    const progress = await tool('dsh.session.wait_turn', { turnRef: first.value.turnRef, timeoutMs: 500 });
    requireState(progress.value, ['timed_out'], 'active work before steering');
    const second = await tool('dsh.session.send_message', { sessionId, message: 'Update to the current task: after the command finishes, reply exactly STEER VERIFIED instead of FIRST DONE. Do not run another command.' });
    const firstResult = await waitTurn(first.value.turnRef);
    const secondResult = await waitTurn(second.value.turnRef);
    requireState(firstResult.value, ['completed'], 'steered task');
    requireState(secondResult.value, ['completed'], 'steering receipt');
    if (!firstResult.text.includes('STEER VERIFIED') || !secondResult.text.includes('STEER VERIFIED')) throw new Error('The active task did not use the steering instruction');
    const snapshot = await events.sessionSnapshot(sessionId);
    const turns = snapshot.records.filter(({ event }) => event.type === 'turn/start');
    const requestIds = snapshot.records.filter(({ event }) => event.type === 'user/message' && event.surfaceOp === 'append').map(({ event }) => event.data?.source?.rpcId);
    if (turns.length !== 1 || ![first.value.requestId, second.value.requestId].every((id) => requestIds.includes(id))) throw new Error('Steering should join the active turn');
    report('steering', { activeTurnUpdated: true, bothReceiptsCompleted: true });
  }

  if (selectedCases.has('cancellation')) {
    const cancelSessionId = await createSession(model);
    const cancelSent = await tool('dsh.session.send_message', { sessionId: cancelSessionId, message: 'Call ' + shellTool + ' with ' + sleepCommand(20) + ', then write a long response.' });
    const cancelWait = waitTurn(cancelSent.value.turnRef);
    await delay(500);
    await tool('dsh.session.cancel', { sessionId: cancelSessionId });
    requireState((await cancelWait).value, ['cancelled'], 'cancelled turn');
    const resumed = await tool('dsh.session.send_message', { sessionId: cancelSessionId, message: 'The previous task is cancelled. Reply exactly RESUMED, without using tools.' });
    const result = await waitTurn(resumed.value.turnRef);
    requireState(result.value, ['completed'], 'continued session after cancellation');
    if (!result.text.includes('RESUMED')) throw new Error('Cancelled session did not accept a new task');
    report('cancellation', { cancelled: true, continuation: true });
  }

  summary = { ok: true, toolCount: listed.tools.length, visibleSessionCount: initialSessions.value.items.length, model, checks: [...selectedCases] };
} catch (error) {
  failure = error;
} finally {
  for (const sessionId of createdSessions.reverse()) {
    try { await tool('dsh.session.cancel', { sessionId }); } catch (error) { cleanupFailures.push(error); }
    try { await raw('workspace/archiveSession', { request: { sessionId } }); } catch (error) { cleanupFailures.push(error); }
  }
  for (const directory of [probeDirectory]) {
    const childPath = relative(tempRoot, resolve(directory));
    if (childPath === '' || childPath.startsWith('..') || isAbsolute(childPath)) { cleanupFailures.push(new Error('Refusing cleanup outside the test temporary root')); continue; }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { cleanupFailures.push(error); }
  }
  for (const connection of [...clients]) {
    try { await connection.close(); } catch (error) { cleanupFailures.push(error); }
  }
}
if (failure !== undefined || cleanupFailures.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupFailures], 'Live validation or cleanup failed');
console.log(JSON.stringify(summary));

async function connect() {
  const connection = new StdioClient(process.execPath, ['dist/server.js'], root);
  clients.add(connection);
  await connection.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dsh-mcp-live-smoke', version: '1' } });
  connection.notify('notifications/initialized');
  return connection;
}
async function restart() { await client.close(); clients.delete(client); client = await connect(); }
async function createSession(model) {
  const result = await tool('dsh.session.create', { cwd: probeDirectory });
  const sessionId = result.value.sessionId;
  createdSessions.push(sessionId);
  if (result.value.cwd !== probeDirectory) throw new Error('DSH session uses another project');
  const listed = await tool('dsh.session.list', { cwd: probeDirectory });
  if (!listed.value.items.some((item) => item.sessionId === sessionId)) throw new Error('Created session is absent from its workspace');
  if (model) await selectModel(sessionId, model);
  return sessionId;
}
async function raw(endpoint, args) {
  const result = await rpc.call(endpoint, args);
  if (!result.ok) throw result.error;
  return result.value;
}
async function selectModel(sessionId, model) {
  await tool('dsh.session.select_model', { sessionId, ...model });
  const result = await tool('dsh.session.models', { sessionId });
  if (result.value.selection.provider !== model.provider || result.value.selection.model !== model.model || result.value.selection.reasoningEffort !== (model.reasoningEffort ?? null)) throw new Error('The effective model selection does not match its receipt');
}
async function tool(name, args) {
  const result = await client.request('tools/call', { name, arguments: args });
  if (result?.isError) throw new Error(name + ': ' + result.content?.[0]?.text);
  if (!result?.structuredContent) throw new Error(name + ' returned no structured content');
  const text = result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
  // Generic hosts may expose only text blocks, so control metadata must remain visible.
  const metadataText = result.content[0]?.text;
  if (!metadataText?.includes(JSON.stringify(result.structuredContent))) throw new Error(name + ' omitted control metadata from text content');
  return { value: result.structuredContent, text };
}
async function waitTurn(turnRef) {
  const deadline = Date.now() + 180_000;
  do {
    const result = await tool('dsh.session.wait_turn', { turnRef, timeoutMs: 30_000 });
    if (result.value.state !== 'timed_out') return result;
  } while (Date.now() < deadline);
  throw new Error('DSH turn exceeded the live-test deadline: ' + turnRef);
}
function requireState(value, allowed, label) {
  if (!allowed.includes(value.state)) throw new Error(label + ' ended in ' + value.state + ': ' + JSON.stringify(value.reason));
}
function report(stage, value) { console.log(JSON.stringify({ stage, ...value })); }
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }
function sleepCommand(seconds) { return process.platform === 'win32' ? 'Start-Sleep -Seconds ' + seconds : 'sleep ' + seconds; }
function shellQuote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
