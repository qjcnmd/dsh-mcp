# Lifecycle and Event Contract

## Send and correlate

1. `dsh.session.send_message` creates a unique prompt `requestId` and local `turnRef`.
2. It calls DSH `session/prompt` and returns after admission.
3. `dsh.session.wait_turn` opens `session/follow` for that session.
4. A `turn/start` records the current DSH turn number.
5. The following `user/message` binds the local request only when
   `data.source.rpcId` equals the prompt `requestId`.
6. Assistant messages and `turn/end` are accepted only for that bound DSH turn.

This prevents old snapshot records or another concurrent turn from completing the
requested wait.

## Terminal projection

| DSH end reason | MCP turn state |
|---|---|
| `completed` | `completed` |
| user-caused `aborted` | `cancelled` |
| other `aborted` or `interrupted` | `interrupted` |
| `error`, `blocked`, `max-tokens` | `failed` |

The last matching assistant text is retained as `finalAnswer`. Unknown evidence is
reported as unknown rather than inferred from session idleness.

## Human input

While a wait is active, the DSH `$events` stream supplies approval and question
requests. The wait returns `pending-human-input` with the event identity. A later
approval or answer tool submits `$events/result` for that exact DSH client and event.
Question results include the stable question IDs, text, options, selection mode, and
known presentation intent needed to construct the answer.

## Cancellation and recovery

Cancelling the MCP request aborts the event streams and timers for that wait. It does
not call DSH cancellation.

If `session/follow` fails, the wait reads one bounded current snapshot and searches for
the matching prompt request and DSH turn. A proven terminal event is returned as
recovered evidence; otherwise the result is `transport-lost` with incomplete evidence.
No periodic status loop is used.
