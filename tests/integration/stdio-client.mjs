import { spawn } from 'node:child_process';

export class StdioClient {
  child;
  pending = new Map();
  nextId = 1;
  stdout = '';
  stderr = '';
  constructor(command, args, cwd) {
    this.child = spawn(command, args, { cwd, env: { ...process.env, DSH_MCP_LOG_LEVEL: 'silent' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.stdout += chunk;
      for (let newline = this.stdout.indexOf('\n'); newline >= 0; newline = this.stdout.indexOf('\n')) {
        const line = this.stdout.slice(0, newline).trim();
        this.stdout = this.stdout.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4_000); });
    this.child.once('error', (error) => this.fail(error));
    this.child.once('exit', (code) => this.fail(new Error('MCP process exited: ' + code + ' ' + this.stderr.replace(/(token=)[A-Za-z0-9_-]+/gi, '$1<redacted>'))));
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeoutMs = method === 'tools/call' && params.name === 'dsh.session.wait_turn' ? 660_000 : 60_000;
      const timer = setTimeout(() => { this.pending.delete(id); rejectRequest(new Error('MCP request timed out: ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolveRequest(value); }, reject: (error) => { clearTimeout(timer); rejectRequest(error); } });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method) { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); }
  fail(error) { for (const waiter of this.pending.values()) waiter.reject(error); this.pending.clear(); }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((resolveClose, rejectClose) => {
      const timer = setTimeout(() => {
        this.child.kill();
        rejectClose(new Error('MCP did not exit after stdin closed'));
      }, 5_000);
      this.child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolveClose();
        else rejectClose(new Error('MCP exited unsuccessfully during shutdown: ' + code));
      });
      this.child.stdin.end();
    });
  }
}
