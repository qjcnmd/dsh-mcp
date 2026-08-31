# Lifecycle and Event Contract

## Source boundaries

1. MCP transport carries JSON-RPC requests, responses, and optional notifications
   between a host and the adapter.
2. DSH HTTP RPC performs commands and bounded reads.
3. DSH server-sent event streams provide the normal observation path for running state and
   turn completion.

The adapter never treats MCP progress, Tasks, or a host notification as proof that a
DSH turn completed. DSH events and recoverable DSH history are the evidence source.

## Send-to-wait sequence

~~~text
host -> dsh.session.send_message(sessionId, message)
adapter -> DSH session.prompt RPC
DSH -> adapter: accepted response with source turn identity
adapter -> host: turnRef + accepted/queued state

host -> dsh.session.wait_turn(turnRef)
adapter -> DSH event subscription (already shared when possible)
DSH -> adapter: ordered session events
adapter -> host: one bounded terminal or pending-human-input result
~~~

The shared event subscription is an implementation detail. Each wait operation filters
by its explicit turnRef and must not return because another turn or another session
became idle.

If a negotiated host cannot keep a normal tool call open long enough, the adapter may
return an MCP task handle for the same wait operation. The task worker consumes this
projection and stores the terminal result; a client's tasks/get query observes the
adapter task state and never triggers periodic DSH status polling.

## State interpretation

The adapter records only transitions supported by observed DSH evidence:

- acceptance response -> accepted;
- queue/steering acknowledgement -> queued or changed;
- execution-start/progress evidence -> running;
- question/approval request -> pending-human-input;
- DSH turn/end or equivalent terminal event -> completed, failed, cancelled, or
  interrupted according to the event reason;
- event disconnect with an unclosed turn -> reconnect/recovery path;
- unrecoverable gap or ambiguous history -> transport-lost or unknown.

No transition is inferred from elapsed time, a missing event, or a session-wide idle
signal.

## Cancellation separation

- MCP request cancellation ends the adapter's wait/observation and releases any
  per-call subscription.
- dsh.session.cancel or dsh.session.stop is an explicit DSH mutation and may change
  the running turn only after DSH accepts it.
- If the host supports MCP cancellation notifications or transport stream closure,
  the selected official SDK owns their wire handling. The domain layer receives a
  local cancellation signal only.

## Reconnect and recovery

1. Mark the observation channel disconnected without assigning a terminal turn state.
2. Reconnect to the DSH event endpoint using the adapter's last confirmed cursor or
   equivalent position when DSH supports it.
3. Reconcile missed events with DSH history and current session reads.
4. If a matching terminal event/history record is found, return the corresponding
   terminal state with evidence: recovered.
5. If the evidence cannot distinguish success, failure, cancellation, or interruption,
   return transport-lost/unknown and state that the result is unproven.

Recovery must be idempotent: duplicate events or repeated history reads must not
produce multiple terminal results for the same turnRef.

## Pending human input

Question and approval events are projected as PendingInteraction records. When the
modern MCP result shape is negotiated, wait_turn may return resultType: input_required
with inputRequests and requestState; otherwise it returns the same pending interaction
inside the bounded structured result and ends its current call. Dedicated
answer/approval tools submit the response to the same DSH target; the next wait_turn
call observes whether the turn resumed or ended. The adapter does not assume that a
host will surface elicitation or multi-round retries correctly, so the direct action
tools remain part of the common contract.
