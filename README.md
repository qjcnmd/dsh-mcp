# DSH Local MCP

This project provides a host-neutral local MCP server for the DSH work surface.
The server is designed for user-level stdio registration and talks to an already
running DSH instance over its structured local interfaces.

## Local development

    npm install
    npm run typecheck
    npm test
    npm run build

The MCP wire protocol uses stdout. All diagnostics, tracing, and startup errors
must use stderr so that an MCP host never receives non-protocol bytes.

The server does not start, stop, restart, or attach to DSH automatically. DSH
must already be running at the configured loopback endpoint, and the adapter only
performs DSH reads after an explicit MCP operation or an active turn wait.

The current user session is not a validation target. Tests must use disposable
workspaces/sessions and explicit identifiers.
