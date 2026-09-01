# Implementation Plan: DSH Local MCP

## Architecture

```text
MCP host
  -> stdio MCP server
     -> 19 action handlers
        -> DSH HTTP RPC
        -> DSH Remote WebSocket streams
```

The action layer owns schemas and bounded results. `DshRpcClient` owns DSH unary
envelopes and authentication. `DshEventClient` owns Remote stream frames and active
interaction identities. Small in-memory stores own turn correlation, pending human
input, and the selected read context.

## Implementation sequence

1. Lock the exact 19-tool registry with a contract test.
2. Implement current DSH authentication, slash RPC endpoints, and Remote streams.
3. Implement action handlers grouped by workspace, session, model, turn,
   intervention, command, inspection, preset, and context.
4. Correlate prompt request identity to DSH turn events and recover once from bounded
   history after a stream failure.
5. Verify schemas, cancellation separation, command wire shape, Remote interaction
   responses, build output, and package contents.
6. Validate against disposable DSH targets and register the built stdio server at
   user scope.

## Verification

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm pack --dry-run`
- exact `tools/list` assertion
- isolated live smoke test using a newly created session

Live validation must avoid sessions not created for the test.
