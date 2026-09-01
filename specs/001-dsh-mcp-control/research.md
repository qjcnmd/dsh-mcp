# Current MCP and WebMCP Basis

Verified: 2026-09-01

## MCP server basis

The project uses the official TypeScript SDK v2 server package and its `serveStdio`
factory. The SDK roadmap identifies v2 as the stable line implementing MCP
2026-07-28 while retaining the 2025-11-25 behavior needed by legacy clients. The
official stdio guide requires protocol traffic on stdout and diagnostics on stderr.

Primary sources:

- [TypeScript SDK roadmap](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/ROADMAP.md)
- [Serve MCP over stdio](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md)
- [2026-07-28 migration support](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)
- [Official SDK list](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/2026-07-28/sdk.mdx)

The implementation therefore uses one host-neutral tool factory over local stdio. It
does not add an HTTP listener because no selected requirement needs one.

## Waiting and cancellation

MCP request cancellation and DSH execution cancellation are separate operations. A
cancelled `wait_turn` releases its local Remote streams. DSH execution changes only
through the explicit cancellation tool. Turn completion comes from DSH events; MCP
progress, notifications, or Tasks are not correctness dependencies.

## WebMCP boundary

The current WebMCP document is a Draft Community Group Report dated 2026-08-26. It
defines a browser `Document` API through which a web page registers JavaScript tools.
The report states that it is not a W3C Standard or Standards Track document.

Primary source:

- [WebMCP Draft Community Group Report](https://webmachinelearning.github.io/webmcp/)

That browser-page lifecycle does not match this project's local stdio distribution or
its need to wait on DSH backend events without keeping a browser integration in the
execution path. The MCP server therefore talks directly to the current DSH HTTP and
Remote WebSocket contracts.

## DSH protocol evidence

The DSH side was verified from the current local package's generated Remote clients
and runtime call sites. Key findings are recorded in `capability-inventory.md` and
covered by wire and stream tests. Local generated sources, rather than remembered DSH
API shapes, are authoritative for this adapter version.
