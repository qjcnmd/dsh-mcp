# Host Registration Contract

The project exposes one stdio server command:

```text
node <absolute-path>/dist/server.js
```

Each MCP host stores its own user-level registration, pointing to that same command
and environment. MCP standardizes the wire protocol, not a universal host config file.

Required environment:

```text
DSH_BASE_URL=http://127.0.0.1:3080/
```

Optional environment:

```text
DSH_AUTH_TOKEN=<launch-token>
DSH_REQUEST_TIMEOUT_MS=30000
DSH_STREAM_CONNECT_TIMEOUT_MS=10000
DSH_MCP_LOG_LEVEL=info
```

The process writes MCP messages only to stdout and diagnostics only to stderr. It
reports DSH connection failures and does not start or restart DSH.

For the supported Windows DeepSeek Harness launcher, `DSH_AUTH_TOKEN` may be omitted:
the MCP server reads only the bounded tail of
`%LOCALAPPDATA%\DeepSeekHarnessLauncher\dsh-web.log` and accepts the latest launch URL
whose origin exactly matches `DSH_BASE_URL`.

The official TypeScript SDK `serveStdio` factory is the transport boundary. It serves
the current protocol era and the SDK's supported legacy opening from the same tool
factory, so action handlers do not branch by host name.
