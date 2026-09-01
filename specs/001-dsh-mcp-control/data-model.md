# Data Model: DSH MCP

DSH is the source of truth. The MCP process keeps only the minimum state needed to
correlate waits, answer active interactions, and hold a read context.

## Turn record

| Field | Meaning |
|---|---|
| `turnRef` | Opaque local reference returned by send |
| `sessionId` | Explicit DSH target |
| `sourceRef` | Prompt request identity until bound to a DSH turn number |
| `state` | `accepted`, `queued`, `running`, `pending-human-input`, `completed`, `failed`, `cancelled`, `interrupted`, `transport-lost`, or `unknown` |
| `reason` | Bounded DSH reason when available |
| `finalAnswer` | Last matching assistant text when available |
| `pendingInteractionId` | Matching DSH remote event identity while input is required |
| `submittedAt`, `observedAt` | Local timestamps |
| `evidence` | `rpc`, `event`, `recovered`, or `incomplete` |

Terminal records do not transition again. Historical events are bound only after the
prompt request identity matches.

## Pending interaction

| Field | Meaning |
|---|---|
| `pendingInteractionId` | DSH `$events` event identity |
| `sessionId` | DSH session that issued the request |
| `turnRef` | Associated local turn when known |
| `kind` | `approval` or `question` |
| `prompt`, `options` | Bounded approval projection |
| `questions` | Structured question IDs, text, options, selection mode, and known intent |

The record is removed after DSH accepts the result or cancels the remote invocation.

## Page context

The MCP process stores one nullable `selectedSessionId`. Selection is validated against
`session/list`. It affects only `dsh.page.get_context`; mutations never consume it.

## Snapshot

An on-demand snapshot contains the DSH session summary, one active local turn when
known, pending interactions, a bounded recent-event projection, and the DSH follow
cursor returned by the opening snapshot. It is not a background cache.
