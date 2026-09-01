# Feature Specification: DSH Local MCP

Feature Branch: `001-dsh-mcp-control`
Status: Implementation

## Goal

Provide one local stdio MCP server that lets any configured MCP host operate the
selected DSH capabilities through DSH's structured interfaces. The public registry is
fixed to the 19 tools in `contracts/mcp-tools.md`.

## User scenarios

### Operate DSH directly

A host can list workspaces and sessions, create or archive a session, choose a model
or preset, send a message, run a command, and explicitly cancel an active session.
Every mutation names its target; page state is never an implicit mutation target.

### Wait for a turn

Sending a message returns immediately with a stable `turnRef`. Waiting on that
reference consumes DSH events and returns when the matching turn completes, fails,
is cancelled or interrupted, or requests human input. The result contains the final
assistant answer when DSH recorded one.

### Inspect and respond

A host can read bounded history, snapshots, context statistics, and a selected read
context. Pending approvals and questions can be answered by their exact interaction
identity.

## Functional requirements

- FR-001: The MCP server MUST expose exactly the 19 tools listed in
  `contracts/mcp-tools.md`.
- FR-002: The server MUST use DSH HTTP RPC and Remote WebSocket streams.
- FR-003: The server MUST use stdio for local MCP transport and remain independent of
  any particular MCP host.
- FR-004: DSH MUST already be running; the server MUST NOT manage the DSH process.
- FR-005: Every mutating tool MUST require an explicit `sessionId`, `turnRef`, or
  `pendingInteractionId` as appropriate.
- FR-006: Message submission MUST return immediately with admission state and a stable
  `turnRef`.
- FR-007: Turn waiting MUST be event-driven and MUST NOT periodically poll DSH status.
- FR-008: Turn correlation MUST use the DSH prompt request identity and matching DSH
  turn number, not session-level idle state.
- FR-009: Terminal results MUST distinguish completed, failed, cancelled,
  interrupted, transport-lost, and unknown outcomes when the evidence allows it.
- FR-010: A pending approval or question MUST end the current wait with
  `pending-human-input` and an interaction identity.
- FR-011: Cancelling an MCP wait MUST only stop observation. DSH execution changes
  only through `dsh.session.cancel`.
- FR-012: On follow-stream failure, the active wait MUST perform one bounded history
  recovery read and MUST report uncertainty when the terminal outcome cannot be
  proven.
- FR-013: Reads and waits MUST be bounded. Default results MUST omit raw envelopes,
  credentials, full traces, and unrequested conversation history.
- FR-014: The server MUST remain idle until a tool call or active wait requires a DSH
  connection.
- FR-015: DSH authentication MUST use the configured launch token and authority-bound
  cookie flow without exposing secrets in results or logs. On the supported Windows
  launcher, the current same-origin token MAY be discovered from the launcher's log
  tail when no explicit token is configured.
- FR-016: `dsh.page.select_session` MUST select only the MCP process's read context;
  other tools MUST continue to use explicit targets.
- FR-017: Tool input and output MUST be declared with MCP-compatible schemas and
  business rejections MUST remain distinguishable from transport/protocol failures.

## Acceptance criteria

- `tools/list` returns the exact 19-name set and no other public tool.
- Current DSH slash commands are sent to `commands/execute`.
- Model inspection reads the session-list projection without activating a cold
  session solely for model lookup.
- A matching terminal DSH event completes `wait_turn` without a status-query loop.
- Old or unrelated session events cannot complete a newly submitted turn.
- Request cancellation releases event subscriptions without invoking DSH cancel.
- Type checking, contract tests, event-stream tests, and production build pass.

## Supported environment

The adapter targets the currently installed local DSH protocol observed in
`@deepseek-ai/dsh@0.1.2-alpha.2`. DSH remains the source of truth for workspaces,
sessions, model availability, commands, permissions, questions, approvals, and turn
history.
