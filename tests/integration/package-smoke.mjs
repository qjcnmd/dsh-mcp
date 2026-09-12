import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { StdioClient } from './stdio-client.mjs';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this test with npm run test:package.');
const temporary = await mkdtemp(join(tmpdir(), 'dsh-mcp-package-'));
const installation = join(temporary, 'installation');
const npm = (args, cwd = root) => run(process.execPath, [npmCli, ...args], { cwd, windowsHide: true, timeout: 120_000 });
let client;

try {
  const packed = JSON.parse((await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', temporary])).stdout)[0];
  const paths = packed.files.map((file) => file.path);
  assert(paths.includes('LICENSE'));
  assert(paths.includes('README.md'));
  assert(paths.includes('dist/server.js'));
  const pluginFiles = ['plugins/dsh-mcp/skills/dsh-mcp/SKILL.md', 'plugins/dsh-mcp/.codex-plugin/plugin.json', 'plugins/dsh-mcp/.mcp.json'];
  for (const path of pluginFiles) assert(paths.includes(path));
  assert(paths.every((path) => ['package.json', 'LICENSE', 'README.md', ...pluginFiles].includes(path) || /^dist\/.*\.js$/.test(path)), 'The install package contains unexpected files');
  await npm(['install', '--global', '--prefix', installation, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, packed.filename)]);
  const moduleRoot = (await npm(['root', '--global', '--prefix', installation])).stdout.trim();
  const manifest = JSON.parse(await readFile(join(moduleRoot, packed.name, 'package.json'), 'utf8'));
  assert.equal(manifest.bin['dsh-mcp'], 'dist/server.js');
  assert.equal(manifest.license, 'MIT');
  const command = process.platform === 'win32' ? 'cmd.exe' : join(installation, 'bin', 'dsh-mcp');
  const launch = process.platform === 'win32' ? ['/d', '/c', 'dsh-mcp.cmd'] : [];
  assert.match((await run(command, [...launch, '--help'], { cwd: installation, windowsHide: true, timeout: 10_000 })).stdout, /Usage: dsh-mcp/);
  client = new StdioClient(command, launch, installation);
  const initialized = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dsh-mcp-package-test', version: '1' } });
  assert.equal(initialized.serverInfo.version, manifest.version);
  client.notify('notifications/initialized');
  const listed = await client.request('tools/list', {});
  assert.equal(listed.tools.length, 7);
  assert(listed.tools.some((tool) => tool.name === 'dsh.session.select_model'));
  for (const name of ['create', 'list']) assert(listed.tools.find((tool) => tool.name === 'dsh.session.' + name).inputSchema.required.includes('cwd'));
  await client.close();
  client = undefined;
  console.log(JSON.stringify({ ok: true, package: packed.filename, files: paths.length, bytes: packed.size, installedCommand: true, hostSelectedWorkspace: true, tools: listed.tools.length }));
} finally {
  try { await client?.close(); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}
