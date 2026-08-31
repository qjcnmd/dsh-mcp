# Quickstart and Validation Guide

This guide defines the evidence the implementation must provide. It is intentionally
written for a disposable DSH test session. Do not use, rename, select, send to, stop,
or otherwise mutate the currently running user session during validation.

## Prerequisites

- Windows desktop with the supported DSH version running at its configured local
  endpoint (the current investigation observed 127.0.0.1:3080).
- Node.js LTS and the pinned project dependencies installed.
- One disposable workspace/session created for validation, or a controlled DSH test
  fixture that does not share the user's active session.
- At least two local MCP hosts configured with the same server definition at user
  scope, when host interoperability is being tested.

## Build and static checks

The implementation must provide project scripts equivalent to:

~~~powershell
npm install
npm run build
npm test
~~~

Expected evidence: the server builds, unit/contract tests pass, and no test targets
the existing running DSH session.

## Contract smoke test

1. Start the MCP server over stdio using the project entry point.
2. Complete MCP initialization and inspect tools/list.
3. Confirm every registered tool has a valid input schema and that the capability
   inventory has no visible homepage action marked without a typed MCP tool or
   explicit unsupported outcome.
4. Invoke a read-only workspace/session listing tool and verify explicit DSH target
   identity and bounded output.
5. Send invalid arguments and an unknown tool call; verify protocol errors are
   distinct from a valid DSH rejection result.

## Primary send/wait flow

1. Select the disposable workspace and session explicitly.
2. Call dsh.session.send_message with a harmless test prompt.
3. Verify the response returns promptly with accepted, an effect, and a stable turnRef;
   it must not contain the full event stream.
4. Call dsh.session.wait_turn for that exact turnRef.
5. Verify the call completes on a DSH event-derived terminal state and returns only
   the bounded reason, final answer when available, and evidence type.
6. Compare the result with a read-only DSH page/API view of the disposable session.

## Failure and intervention flows

Use controlled fixtures or safe prompts to exercise at most one path at a time:

- a turn that completes normally;
- a DSH-reported error;
- explicit stop/cancel;
- an interrupted turn;
- a question or approval request, followed by the dedicated response tool;
- a dropped event connection followed by reconnect and history recovery;
- duplicate/out-of-order event delivery.

For each path, verify that wait_turn does not poll DSH status periodically, does not
confuse another turn's idle state with the selected turn, and reports transport-lost/
unknown when recovery cannot prove an outcome.

## Independent page-state check

With the DSH page open on one disposable session:

1. Operate a different disposable session through MCP using its explicit sessionId.
2. Verify the DSH backend state and returned target identity without relying on the
   page's current selection.
3. Confirm no MCP result claims that the open page changed selection.
4. If concurrent actions are tested, record DSH's observed ordering and whether each
   operation was accepted, queued, changed, superseded, or rejected.

## Host matrix check

Register the same stdio server in at least two intended local hosts at user scope.
For each host, record the actual transport and extension behavior in
contracts/host-registration.md. Do not claim that one host's support proves another
host's support.

## Evidence to retain

- package/DSH versions and date of capability capture;
- sanitized tools/list and representative structured results;
- event-fixture inputs and resulting state transitions;
- host matrix with official configuration references;
- any unsupported inventory entries and the reason each is outside the MCP contract;
- confirmation that the user's currently running session was not touched.
