# DSH MCP Capability Inventory

Verified: 2026-09-01
DSH package: `@deepseek-ai/dsh@0.1.2-alpha.2`

| Public tool | DSH operation or local state |
|---|---|
| `dsh.workspace.list` | Remote `workspace/follow` opening baseline |
| `dsh.session.archive` | RPC `workspace/archiveSession` |
| `dsh.session.list` | RPC `session/list` |
| `dsh.session.create` | RPC `session/create` |
| `dsh.session.history` | Remote `session/follow` opening snapshot, then RPC `session/page` for older pages |
| `dsh.session.models` | RPC `session/modelCatalog` plus the target's `session/list` projection |
| `dsh.session.select_model` | RPC `session/selectModel` |
| `dsh.session.send_message` | RPC `session/prompt` |
| `dsh.session.wait_turn` | Remote `session/follow` and `$events`; one bounded `session/follow` recovery snapshot after stream failure |
| `dsh.session.cancel` | RPC `session/cancel` |
| `dsh.session.respond_approval` | Remote `$events/result` |
| `dsh.session.answer_question` | Remote `$events/result` |
| `dsh.session.command` | RPC `commands/execute` |
| `dsh.command.compact` | RPC `commands/execute` with `/compact` |
| `dsh.session.snapshot` | RPC `session/list` plus Remote `session/follow` opening snapshot |
| `dsh.session.context_stats` | Remote `session/follow` projection snapshot |
| `dsh.agent_preset.select` | RPC `agentPresets/select` |
| `dsh.page.select_session` | MCP-local read-context state after RPC `session/list` validation |
| `dsh.page.get_context` | MCP-local read-context state plus RPC `session/list` and Remote `workspace/follow` |

The exact public names are asserted by `tests/contract/capability-coverage.test.ts`.
