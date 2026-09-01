# Quickstart and Validation

## Build

```sh
npm ci
npm run typecheck
npm test
npm run build
```

## Inspect the MCP surface

```sh
npx @modelcontextprotocol/inspector node ./dist/server.js
```

Confirm that `tools/list` contains exactly the 19 tools documented in
`contracts/mcp-tools.md`.

## Configure DSH

Launch DSH separately, then pass its loopback URL to the MCP process:

```text
DSH_BASE_URL=http://127.0.0.1:3080/
DSH_AUTH_TOKEN=<launch-token-if-required>
```

Register `node <absolute-path>/dist/server.js` as a user-level stdio MCP server in the
chosen host.

## Isolated live validation

1. Call `dsh.workspace.list` and choose a disposable workspace.
2. Create a new session with `dsh.session.create`.
3. Send a harmless prompt with `dsh.session.send_message`.
4. Wait on the returned reference with `dsh.session.wait_turn`.
5. Compare the terminal state and final answer with that newly created DSH session.
6. Archive the disposable session when validation is complete.

Do not use an existing session as a mutation target during validation.
