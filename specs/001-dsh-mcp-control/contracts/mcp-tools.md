# MCP Tool Contract

This is the adapter-facing contract for the selected MCP SDK. The complete tool
registry is generated from the versioned DSH main-work-surface capability inventory;
the names below define the common shape and the primary lifecycle tools. The final
inventory may add action-level tools for controls discovered during the implementation
audit, but it must not silently omit a visible action.

## Common conventions

- Tool names are stable MCP names using lowercase segments separated by dots, for
  example dsh.session.send_message. Names obey MCP tool-name character and length
  constraints.
- Every mutating input contains an explicit workspaceId, sessionId, turnRef, or
  pendingInteractionId target as required by the action. No mutation defaults to the
  page's current selection.
- Every result contains structured JSON matching its declared output schema and a
  short human-readable content summary. Modern MCP results may additionally carry
  resultType: complete or resultType: input_required.
- A valid DSH rejection or execution failure is a tool result with isError: true and
  a bounded domain error. Invalid MCP arguments, unknown tools, and protocol failures
  use the SDK's JSON-RPC error path.
- Results report DSH's observed effect: applied, queued, changed, superseded,
  rejected, or unknown.
- Raw DSH envelopes, secrets, full history, and unbounded event traces are not part
  of normal results.

## Lifecycle tools

### dsh.session.send_message

Input (logical shape):

~~~json
{
  "sessionId": "string",
  "message": "string",
  "mode": "send | queue | steer",
  "attachments": ["string"]
}
~~~

mode and attachments are registered only when the capability inventory confirms that
the current DSH surface supports them. The logical `send` mode uses the verified DSH
default prompt path; `queue` and `steer` are passed only when their DSH semantics are
confirmed. The tool returns immediately:

~~~json
{
  "target": {"sessionId": "string"},
  "accepted": true,
  "effect": "applied | queued | changed | rejected | unknown",
  "turnRef": "opaque-string",
  "state": "accepted | queued | running | unknown",
  "reason": "string | null"
}
~~~

### dsh.session.wait_turn

Input:

~~~json
{
  "turnRef": "opaque-string",
  "timeoutMs": "integer | null"
}
~~~

The adapter subscribes to DSH events internally and waits for only this turn. It
does not periodically query DSH status. timeoutMs bounds the MCP call; reaching it
returns an explicit nonterminal result rather than a fabricated terminal state. The
normal result is a complete result:

~~~json
{
  "turnRef": "opaque-string",
  "sessionId": "string",
  "state": "completed | failed | cancelled | interrupted | pending-human-input | transport-lost | unknown",
  "waitOutcome": "terminal | pending-human-input | timed-out | transport-lost",
  "reason": "string | null",
  "finalAnswer": "string | null",
  "pendingInteraction": "object | null",
  "evidence": "event | history | recovered | incomplete"
}
~~~

When the host negotiated modern input-required tool results, a pending DSH question or
approval may instead be returned as:

~~~json
{
  "resultType": "input_required",
  "inputRequests": {"pendingInteractionId": {"method": "elicitation/create"}},
  "requestState": "opaque-string",
  "structuredContent": {"turnRef": "opaque-string", "state": "pending-human-input"}
}
~~~

The adapter still exposes dedicated answer/approval tools so a host can submit the
response directly to the DSH target and so legacy hosts do not need to implement the
modern multi-round retry shape. A pending interaction is never treated as a completed
turn.

## Inspection tools

The inventory must expose action-level tools for the main surface's supported read
operations, including the equivalent of:

- dsh.workspace.list and workspace selection/inspection actions.
- dsh.session.list, dsh.session.search, dsh.session.history, and session
  selection/creation/rename/fork/archive actions.
- Effective model and reasoning inspection and selection actions.
- dsh.session.snapshot for a bounded live projection.
- Bounded history, selected-event, and diagnostics actions when the surface exposes
  the corresponding inspection.

These operations return explicit target identity, ordering metadata, bounded data, and
the DSH version/capability source used for the response.

## Intervention tools

When the inventory confirms the corresponding DSH controls, expose separate action
tools for:

- queue update and steering;
- stop/cancel;
- question answer;
- approval/confirmation response;
- any other visible running-session intervention.

Each tool targets the exact session, turn, or pending interaction and returns DSH's
native acceptance/rejection and resulting state. A request cancellation sent by an MCP
host cancels observation of a tool call; it does not implicitly invoke a DSH stop/cancel
action.

## Dynamic registry behavior

The inventory may change when the supported DSH version or visible capability set
changes. If the SDK supports notifications/tools/list_changed, the server may send
that notification; correctness must still come from the next tools/list and the
individual tool call, not from delivery of the notification.
