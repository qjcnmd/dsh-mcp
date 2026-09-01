# MCP Tool Contract

The public registry contains exactly the following tools. Adding or renaming a tool
requires an explicit product-scope change and an update to the exact-set contract test.

| Tool | Required target/input | Result |
|---|---|---|
| `dsh.workspace.list` | none | Workspace baseline and archived session IDs |
| `dsh.session.archive` | `sessionId` | DSH archive receipt |
| `dsh.session.list` | optional `cursor` | Bounded session summaries |
| `dsh.session.create` | exactly one of `workspaceId` or `cwd`; optional `sessionId`, `agentPreset` | Created session identity |
| `dsh.session.history` | `sessionId`; optional `beforeSeq`, bounded `maxMessages` | Ordered history page and cursor |
| `dsh.session.models` | `sessionId` | Current DSH catalog and session selection projection |
| `dsh.session.select_model` | `sessionId`, `provider`, `model`; optional `reasoningEffort` | DSH selection receipt |
| `dsh.session.send_message` | `sessionId`; exactly one of `message` or `content`; optional `mode`, `clientTimeZone` | Immediate admission and `turnRef` |
| `dsh.session.wait_turn` | `turnRef`; optional bounded `timeoutMs` | Matching turn state, reason, final answer, pending interaction |
| `dsh.session.cancel` | `sessionId` | DSH cancellation receipt |
| `dsh.session.respond_approval` | `sessionId`, `pendingInteractionId`, `outcome` | DSH interaction receipt |
| `dsh.session.answer_question` | `sessionId`, `pendingInteractionId`, `answers` | DSH interaction receipt |
| `dsh.session.command` | `sessionId`, slash-prefixed `command` | DSH command execution |
| `dsh.command.compact` | `sessionId` | DSH `/compact` execution |
| `dsh.session.snapshot` | `sessionId`; optional bounded `recentEvents` | Bounded current session projection |
| `dsh.session.context_stats` | `sessionId` | Available context/token/usage projections |
| `dsh.agent_preset.select` | `sessionId`, `agentPreset` | DSH preset receipt |
| `dsh.page.select_session` | `sessionId` | Selected MCP read context |
| `dsh.page.get_context` | none | Selected read context and current summaries |

## Common result rules

- Results include structured content plus a concise text rendering.
- Mutations identify their explicit target and report `accepted` and `effect`.
- DSH domain rejection returns a bounded error with the native DSH code.
- Transport and malformed-protocol failures remain adapter errors.
- Raw RPC envelopes, cookies, launch tokens, full traces, and unbounded history are
  never returned.

## Turn contract

`dsh.session.send_message` creates a local opaque `turnRef` before calling
`session/prompt`. The request carries its own `requestId`. DSH history later associates
that request identity with a numeric turn through `user/message.data.source.rpcId`.

`dsh.session.wait_turn` listens to `session/follow` and the DSH remote interaction
stream. It returns one of:

- `terminal` for a proven completed, failed, cancelled, or interrupted turn;
- `pending-human-input` for a matching approval or question;
- `timed-out` when the MCP call deadline expires while the turn remains nonterminal;
- `transport-lost` when neither events nor a bounded recovery snapshot can prove an
  outcome.

MCP request cancellation releases observation resources and does not invoke
`dsh.session.cancel`.

## Context contract

The two `dsh.page.*` tools model a convenient read context held by the MCP server.
They do not mutate a browser tab or supply implicit targets to mutating tools.
