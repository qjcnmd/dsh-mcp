# dsh-mcp

`dsh-mcp` is a local, host-neutral MCP server for operating an already running
DSH instance through DSH's structured HTTP and WebSocket interfaces.

The server is intentionally small. It exposes exactly these 19 tools:

| Area | Tools |
|---|---|
| Workspace | `dsh.workspace.list`, `dsh.session.archive` |
| Session | `dsh.session.list`, `dsh.session.create`, `dsh.session.history` |
| Model | `dsh.session.models`, `dsh.session.select_model` |
| Turn | `dsh.session.send_message`, `dsh.session.wait_turn` |
| Intervention | `dsh.session.cancel`, `dsh.session.respond_approval`, `dsh.session.answer_question` |
| Command | `dsh.session.command`, `dsh.command.compact` |
| Inspection | `dsh.session.snapshot`, `dsh.session.context_stats` |
| Preset | `dsh.agent_preset.select` |
| Context | `dsh.page.select_session`, `dsh.page.get_context` |

## Runtime contract

- DSH must already be running. The MCP server never starts, stops, or restarts it.
- Mutating tools always require an explicit DSH target.
- `dsh.session.wait_turn` waits on DSH events; it does not periodically query status.
- DSH connections are opened only for an explicit tool call or an active turn wait.
- List and history results are paged. Final responses are returned once, without
  truncation, and results omit credentials, raw envelopes, and unrequested traces.
- The context tools keep a read context inside the MCP process. They do not control a browser page.
- `turnRef` values belong to the running MCP process. Send and wait for a turn through
  the same process.

## Core flow

1. Find a target with `dsh.workspace.list` or `dsh.session.list`. Both return
   `hasMore` and an opaque `nextCursor` when another page exists.
2. Use `dsh.session.send_message`. The default mode is `steer`; pass `queue` to wait
   behind an active turn.
3. Pass the returned `turnRef` to `dsh.session.wait_turn`. It resolves on completion,
   failure, cancellation, interruption, required input, timeout, or transport loss.
4. If input is required, answer the exact interaction ID and wait on the same
   `turnRef` again.

`dsh.session.history` is an explicit compact read: it defaults to one recent turn,
accepts at most five per page, and excludes reasoning, chunks, tool calls, and tool
results. Tool execution failures use `isError: true` with a stable error code, message,
and target.

## Install and run

Requires Node.js 20 or newer.

```sh
npm ci
npm run build
```

Register `node <absolute-path>/dist/server.js` as a user-level stdio MCP server in
the host. Configure the DSH endpoint through the process environment:

```text
DSH_BASE_URL=http://127.0.0.1:3080/
DSH_AUTH_TOKEN=<launch-token-if-required>
```

The launch token may instead be present as `?token=...` in `DSH_BASE_URL`; it is
exchanged for DSH's authority-bound session cookie and is never returned by tools.
When the Windows DeepSeek Harness launcher owns DSH and no token is configured, the
server reads the latest same-origin launch URL from the launcher's bounded log tail.

Optional settings:

```text
DSH_REQUEST_TIMEOUT_MS=30000
DSH_STREAM_CONNECT_TIMEOUT_MS=10000
DSH_MCP_LOG_LEVEL=info
```

## Development

```sh
npm run typecheck
npm test
npm run build
```

The MCP wire protocol uses stdout. Diagnostics use stderr.
