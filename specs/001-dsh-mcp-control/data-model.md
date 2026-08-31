# Data Model: DSH MCP Adapter

This model is the adapter's stable projection. DSH remains the source of truth;
fields that depend on an exact DSH identifier or cursor are opaque until the
implementation-phase capability audit confirms their shape.

## Workspace Target

Represents a DSH workspace that can be inspected or selected.

| Field | Type | Rules |
|---|---|---|
| `workspaceId` | string | Required, stable DSH identifier. |
| `name` | string | Current display name. |
| `selected` | boolean | Whether DSH currently marks it selected. |
| `metadata` | object | Bounded display metadata only; no credentials. |

## Session Target

Represents a DSH session and its workspace relationship.

| Field | Type | Rules |
|---|---|---|
| `sessionId` | string | Required, stable DSH identifier. |
| `workspaceId` | string | Required for a known session. |
| `title` | string | Current display title. |
| `selected` | boolean | Whether this is the page's current selection. |
| `status` | enum | `idle`, `running`, `waiting_for_input`, `stopping`, `error`, `unknown`; derived only from observed DSH state. |
| `model` | object | Effective model identifier and display label when DSH provides them. |
| `reasoning` | object | Effective reasoning/thinking selection when DSH provides it. |
| `queueSummary` | object | Bounded queue/steering summary; no full message dump. |

All mutating tools require either `workspaceId` or `sessionId` as appropriate. A
tool must not silently use the page's current selection as the mutation target.

## Capability Entry

Versioned inventory row for one user-operable action on the supported DSH main work
surface.

| Field | Type | Rules |
|---|---|---|
| `capabilityId` | string | Stable adapter inventory key. |
| `surfaceRegion` | enum/string | Sidebar, workspace, session, conversation, model, reasoning, queue, intervention, or another observed main-surface region. |
| `label` | string | Human-visible action label. |
| `toolName` | string/null | MCP tool name when structured support exists. |
| `sourceOperation` | string/null | Confirmed DSH RPC/event operation, or null when absent. |
| `targetKind` | enum | `none`, `workspace`, `session`, `turn`, or `pendingInteraction`. |
| `support` | enum | `structured`, `unsupported`, `pending`, or `out_of_scope`. |
| `resultProjection` | string | Reference to the bounded result shape. |
| `verifiedAgainst` | string | DSH package/version and inventory capture date. |

The inventory is the input to tool registration and the completeness test. Browser-local
fallbacks are outside this MCP data model; a Harness Agent may choose them separately.
The inventory is not a promise that every future DSH control has the same source operation.

## Turn Reference

Opaque handle returned by `send_message` and accepted by `wait_turn` and inspection
tools.

| Field | Type | Rules |
|---|---|---|
| `turnRef` | string | Stable, opaque to the host; maps to one DSH turn in the adapter. |
| `sessionId` | string | Required target session. |
| `submittedAt` | string | RFC 3339 timestamp recorded by the adapter. |
| `sourceRef` | string | Confirmed DSH turn/event identifier, retained internally or exposed only when safe. |

The adapter must never use a session-level idle transition as a substitute for a
turn reference.

## Turn Projection

Bounded state for one submitted turn.

| Field | Type | Rules |
|---|---|---|
| `turnRef` | string | Required. |
| `sessionId` | string | Required. |
| `state` | enum | `accepted`, `queued`, `running`, `pending-human-input`, `completed`, `failed`, `cancelled`, `interrupted`, `transport-lost`, `unknown`. |
| `reason` | string/null | Bounded DSH reason; absent when not provided. |
| `finalAnswer` | string/null | Original final answer when DSH provides one; omitted from intermediate projections. |
| `pendingInteractionId` | string/null | Present only for `pending-human-input`. |
| `observedAt` | string | RFC 3339 timestamp. |
| `evidence` | enum | `event`, `history`, `rpc`, `recovered`, `incomplete`. |

`completed`, `failed`, `cancelled`, `interrupted`, and `transport-lost` are terminal
for the adapter's wait operation. `pending-human-input` is resumable but ends the
current wait call so a separate response tool can be used. `unknown` is returned
when available evidence cannot distinguish a state.

## Pending Interaction

Question or approval request exposed by DSH.

| Field | Type | Rules |
|---|---|---|
| `pendingInteractionId` | string | Stable identifier for the pending request. |
| `sessionId` | string | Required target session. |
| `turnRef` | string/null | Associated turn when DSH supplies it. |
| `kind` | enum | `question` or `approval`. |
| `prompt` | string | DSH request text, bounded to the request payload. |
| `options` | array | Structured choices or approval metadata when provided. |
| `expiresAt` | string/null | Only when DSH supplies an expiry. |

Answer/approval tools must target this identifier and report DSH acceptance or
rejection without guessing that the underlying turn continued.

## Runtime Snapshot

On-demand, bounded view of a session.

| Field | Type | Rules |
|---|---|---|
| `session` | Session Target | Required. |
| `activeTurn` | Turn Projection/null | At most the selected active turn. |
| `pendingInteractions` | array | Bounded and explicitly requested. |
| `recentEvents` | array | Optional selected events only; never the unbounded stream. |
| `cursor` | Event Cursor/null | Returned only for explicit diagnostics/recovery. |

## Event Cursor

Recovery metadata used internally to resume observation.

| Field | Type | Rules |
|---|---|---|
| `stream` | string | DSH event channel identifier. |
| `position` | string/null | Opaque DSH event position when available. |
| `lastEventType` | string/null | Diagnostic label only. |
| `updatedAt` | string | RFC 3339 timestamp. |

Cursors are not exposed in normal results and are not assumed durable until the
implementation proves that DSH positions survive reconnects.

## Action Outcome

Common result envelope for mutating action tools.

| Field | Type | Rules |
|---|---|---|
| `target` | object | Explicit workspace/session/turn target. |
| `accepted` | boolean | Whether DSH accepted the request. |
| `effect` | enum | `applied`, `queued`, `changed`, `superseded`, `rejected`, `unknown`. |
| `result` | object/null | Bounded DSH response projection. |
| `error` | object/null | Domain error when DSH rejected or failed the action. |

Protocol errors (invalid JSON-RPC/MCP request, unknown tool, invalid schema) are
separate from a valid tool result with `accepted: false` or `isError: true`.

## Relationships and State Rules

- A workspace contains zero or more sessions.
- A session owns zero or more turn references and pending interactions.
- A turn may have at most one active pending interaction at a time in the adapter
  projection; DSH remains authoritative if it reports a different arrangement.
- One DSH event subscription may update multiple sessions, but each `wait_turn`
  filters by its explicit `turnRef`.
- Duplicate or out-of-order events are ignored or reconciled by event position;
  they must not create a second terminal result.
- A reconnect must use the last confirmed cursor plus DSH history. If the gap cannot
  be closed, the projection moves to `transport-lost` or `unknown` instead of
  inventing completion.
