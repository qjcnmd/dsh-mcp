---
description: "Task list for DSH Main Work Surface Control via Standard Local MCP"
---

# Tasks: DSH Main Work Surface Control via Standard Local MCP

**Input**: Design documents from specs/001-dsh-mcp-control/

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md, capability-inventory.md

**Scope**: One user-level local MCP server for the single DSH instance at 127.0.0.1:3080. The current running session is never a validation target.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Pin the implementation baseline and create the smallest executable TypeScript project.

- [X] T001 Verify the current stable official MCP TypeScript SDK release, license, Windows stdio behavior, and 2026-07-28/legacy support; record the decision in specs/001-dsh-mcp-control/plan.md
- [X] T002 Create package metadata, scripts, and dependency pins in package.json for TypeScript, the selected official MCP SDK, and the selected Node test runner
- [X] T003 [P] Create compiler and test configuration in tsconfig.json and tests/tsconfig.json
- [X] T004 [P] Create the source/test directory skeleton in src/server.ts, src/mcp/, src/dsh/, src/domain/, src/errors.ts, tests/unit/, tests/contract/, and tests/integration/
- [X] T005 [P] Add local development and diagnostic conventions to README.md, including stdout/stderr separation and the no-auto-start DSH rule

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish typed targets, bounded projections, DSH transport, and error semantics before any story-specific tool is exposed.

**Critical**: No user-story implementation starts until this phase is complete.

- [X] T006 Define explicit environment and connection configuration in src/config.ts, including DSH_BASE_URL, bounded timeouts, and log level
- [X] T007 Define workspace/session/turn target types in src/domain/targets.ts and src/domain/turns.ts with explicit mutation-target validation
- [X] T008 Define pending-interaction and bounded-snapshot types in src/domain/pending-interactions.ts and src/domain/snapshots.ts
- [X] T009 Implement protocol/domain/transport error mapping in src/errors.ts with MCP JSON-RPC errors separated from valid DSH rejection results
- [X] T010 Implement the typed DSH HTTP RPC client in src/dsh/rpc-client.ts for the confirmed sessions, workspace, goal, host, and response contracts
- [X] T011 Implement the shared DSH event connection in src/dsh/event-client.ts for /api/events.mux and /api/events.host, preserving event order and cancellation
- [X] T012 Implement reconnect cursor handling and history reconciliation in src/dsh/recovery.ts; return transport-lost/unknown when the outcome cannot be proven
- [X] T013 Implement the versioned capability inventory loader and coverage assertions in src/dsh/capability-inventory.ts using specs/001-dsh-mcp-control/capability-inventory.md
- [X] T014 Implement bounded readable/structured result projection in src/mcp/result-projection.ts so default results exclude full history, raw envelopes, and unbounded traces
- [X] T015 Implement the MCP transport/server bootstrap in src/mcp/transport.ts and src/server.ts using stdio first, with diagnostics sent only to stderr and no background DSH reads before an explicit MCP operation or an active wait
- [X] T016 [P] Add reusable DSH event fixtures and disposable-session test helpers in tests/unit/fixtures.ts and tests/integration/support.ts without referencing the active user session
- [X] T017 [P] Add foundational contract tests for initialization, tools/list schema shape, target validation, explicit-call gating, and protocol-vs-domain errors in tests/contract/foundation.test.ts

**Checkpoint**: The server starts over stdio, connects only to the configured DSH endpoint, and exposes no untyped or implicitly targeted mutation path.

---

## Phase 3: User Story 1 - Directly operate the DSH main work surface (Priority: P1) 🎯 MVP

**Goal**: Expose every structured action in the versioned main-work-surface inventory, including workspace/session management, model/reasoning selection, composer controls, queue controls, and visible command actions.

**Independent Test**: Against a disposable DSH session, compare the inventory to tools/list, execute each structured action with explicit targets, and verify the corresponding DSH state/result.

- [ ] T018 [P] [US1] Implement workspace list/create/rename/delete/reorder handlers in src/mcp/actions/workspaces.ts using workspace.list, workspace.create, workspace.rename, workspace.delete, and workspace.insertBefore
- [ ] T019 [P] [US1] Implement session list/search/create/rename/fork/archive/reorder handlers in src/mcp/actions/sessions.ts using session.list, session.search, session.create, session.rename, session.fork, workspace.archiveSession, and workspace.insertSessionBefore
- [ ] T020 [P] [US1] Implement model catalog and model/reasoning selection handlers in src/mcp/actions/models.ts using session.models and session.selectModel; reject unavailable choices and require explicit confirmation before any replacement
- [ ] T021 [US1] Implement message submission in src/mcp/actions/composer.ts using session.prompt; define the logical send-to-DSH default mapping and expose queue/steer only when verified; add image-content admission only after the capability audit confirms its shape, otherwise expose an explicit unsupported result; return immediate acceptance with a stable turnRef
- [ ] T022 [US1] Implement stop/cancel and queue edit/remove/steer handlers in src/mcp/actions/interventions.ts using session.cancel and session.updateQueue
- [ ] T023 [US1] Implement command-palette and visible homepage navigation actions in src/mcp/actions/commands.ts for compact, goal, permission, model, export, feedback, and the settings entry, exposing only actions whose current DSH response contract is verified and recording unsupported outcomes otherwise
- [ ] T024 [US1] Register the action-level tools and inventory metadata in src/mcp/register-tools.ts with stable dsh.* names, input schemas, output schemas, explicit target requirements, and unsupported outcomes for unresolved homepage controls
- [ ] T025 [US1] Add capability-coverage contract tests in tests/contract/capability-coverage.test.ts that fail when a visible homepage action has no typed MCP tool or explicit unsupported entry
- [ ] T026 [US1] Add disposable-session integration checks in tests/integration/main-surface.test.ts for workspace/session/model/queue/command actions; exclude session-80e62e95-533a-48d9-b1d1-235957532eeb

**Checkpoint**: A compatible MCP host can perform every currently verified structured main-surface action without Computer Use.

---

## Phase 4: User Story 2 - Send a message and wait for one turn (Priority: P1)

**Goal**: Make send immediate and make wait event-driven for one explicit turn, with distinguishable terminal and pending-input outcomes.

**Independent Test**: Send one harmless prompt to a disposable session, receive a turnRef immediately, wait for that turn, and compare the terminal result with DSH events/history.

- [ ] T027 [US2] Complete turn-reference registration and per-turn state transitions in src/domain/turns.ts for accepted, queued, running, pending-human-input, completed, failed, cancelled, interrupted, transport-lost, and unknown
- [ ] T028 [US2] Implement event-driven wait_turn observation in src/dsh/event-client.ts and src/dsh/recovery.ts so it resolves only on the selected turn's event or recovery evidence and never polls DSH status
- [ ] T029 [US2] Register dsh.session.send_message and dsh.session.wait_turn in src/mcp/register-tools.ts after T024 with timeout, request-cancellation, and stable turnRef semantics
- [ ] T030 [US2] Add terminal-state and no-polling fixture tests in tests/contract/turn-lifecycle.test.ts covering completed, failed, cancelled, interrupted, duplicate, out-of-order, unrelated-session events, and a labeled classification set for SC-004
- [ ] T031 [US2] Add disposable-session send/wait integration checks in tests/integration/send-wait.test.ts for prompt acknowledgement, final answer preservation, bounded reasons, timeout behavior, and a repeated timing sample that verifies the SC-002 95%/2-second target
- [ ] T032 [US2] Add explicit separation tests in tests/contract/cancellation.test.ts proving MCP wait cancellation releases observation without invoking DSH cancel, while dsh.session.cancel remains an explicit mutation

**Checkpoint**: The primary select-target → send → wait → final-answer flow works without periodic DSH status polling or full event-log injection.

---

## Phase 5: User Story 3 - Inspect and intervene on demand (Priority: P1)

**Goal**: Provide bounded live snapshots/history/details and complete DSH question, approval, queue, and diagnostic interactions without expanding normal context.

**Independent Test**: During a disposable run, request a bounded snapshot and history slice, inspect one selected event, answer one pending question/approval, and verify the resulting DSH state.

- [ ] T033 [P] [US3] Implement dsh.session.snapshot and bounded history/selected-event/diagnostic tools in src/mcp/actions/inspection.ts using session.history, projections, and the shared event client
- [ ] T034 [P] [US3] Implement approval allow-once/reject and question-batch answer tools in src/mcp/actions/pending-interactions.ts using /api/respond and the confirmed response payload schemas
- [ ] T035 [US3] Implement bounded jobs/task progress and context/stat projections in src/mcp/actions/inspection.ts from session/jobs, session/projection, and host/session-status frames
- [ ] T036 [US3] Add input-required mapping and legacy fallback result shapes in src/mcp/result-projection.ts, preserving dedicated response tools for hosts without multi-round support
- [ ] T037 [US3] Add bounded-result and intervention contract tests in tests/contract/inspection-intervention.test.ts for snapshots, history limits, approval/question identity, and queue ordering
- [ ] T038 [US3] Add reconnect/recovery integration fixtures in tests/integration/recovery.test.ts for dropped streams, replayed events, history reconciliation, and unproven terminal outcomes

**Checkpoint**: Normal tool results stay compact while explicit inspection and human intervention remain complete and verifiable.

---

## Phase 6: User Story 4 - Operate DSH through MCP without browser automation (Priority: P2)

**Goal**: Verify that MCP operations use explicit DSH targets and do not depend on the
open page's browser-local selection or any browser plugin.

**Independent Test**: Keep DSH open on one disposable session, operate a different
disposable session through MCP, and compare the returned target identity with DSH state
without relying on page selection.

- [ ] T039 [US4] Record page selection and other browser-local display state as outside the MCP target model in specs/001-dsh-mcp-control/capability-inventory.md and contracts/mcp-tools.md
- [ ] T040 [US4] Add explicit-target integration checks in tests/integration/shared-page.test.ts with the open page showing a different disposable session
- [ ] T041 [US4] Add a fail-closed contract test in tests/contract/shared-page.test.ts proving MCP never claims that page selection changed
- [ ] T042 [US4] Add concurrent-operation ordering checks in tests/integration/shared-page.test.ts that report DSH acceptance, queueing, supersession, or rejection without relying on page selection or caller identity

**Checkpoint**: MCP operations remain correct and explicitly targeted even when the open
page shows another session; no tool depends on browser-local page state.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Finish host registration, security boundaries, compatibility evidence, and release validation.

- [ ] T043 [P] Update contracts/host-registration.md with actual user-level registration in at least two local Harness Agents, recording transport, protocol era, cancellation, structured-result, input-required, Tasks, and subscription evidence
- [ ] T044 [P] Add the user-level global registration command and environment documentation to README.md and contracts/host-registration.md, keeping the server on stdio and DSH on 127.0.0.1 by default
- [ ] T045 [P] Add optional loopback Streamable HTTP only if the measured host matrix requires URL transport; implement it in src/mcp/transport.ts with Origin/host checks and the same tool registry
- [ ] T046 [P] Review src/config.ts, src/errors.ts, src/dsh/, and src/mcp/ for secret/log redaction, explicit-target enforcement, no-auto-start behavior, and bounded result guarantees; record findings in specs/001-dsh-mcp-control/quickstart.md
- [ ] T047 Run the quickstart evidence in specs/001-dsh-mcp-control/quickstart.md against disposable sessions and record package versions, sanitized tools/list, actual user-level registration in the tested Harness Agents, event fixtures, and the untouched active-session check
- [ ] T048 Run the focused build, type-check, contract, and integration commands from package.json and record the exact commands/results in specs/001-dsh-mcp-control/quickstart.md
- [ ] T049 Re-capture capability-inventory.md after the first implementation pass, resolve every pending entry to structured, unsupported, or out_of_scope, and update tool registration/coverage assertions for any DSH version drift
- [ ] T050 Document the WebMCP boundary and the fact that it is not an MCP-server dependency in specs/001-dsh-mcp-control/research.md

---

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 has no implementation dependencies.
- Phase 2 depends on Phase 1 and blocks all user stories.
- User Story 1 depends on the typed RPC, projection, transport, and inventory foundation in Phase 2.
- User Story 2 depends on Phase 2 and the registration/result projection from User Story 1; its event state machine can be developed in parallel with the action handlers after Phase 2, but T029 follows T024 because both use src/mcp/register-tools.ts.
- User Story 3 depends on the event/recovery foundation from Phase 2 and can proceed in parallel with User Story 2 after the shared projection contracts are stable.
- User Story 4 depends on the inventory and registration from User Story 1 plus a read-only bridge check.
- Phase 7 depends on the stories selected for the release; T045 is conditional on the host matrix and must not be implemented speculatively.

### Parallel Opportunities

- T003-T005 and T016-T017 can run in parallel after their listed prerequisites.
- T018-T020 can run in parallel because they own separate action modules.
- T030 and T032 can run in parallel after T027-T029.
- T033-T035 can run in parallel after T011-T014.
- T043-T046 can run in parallel after the story checkpoints, except T045 remains conditional.

## Parallel Example: User Story 1

- T018: workspace actions in src/mcp/actions/workspaces.ts
- T019: session actions in src/mcp/actions/sessions.ts
- T020: model/reasoning actions in src/mcp/actions/models.ts
- T025: inventory coverage contract in tests/contract/capability-coverage.test.ts

## Parallel Example: User Story 2

- T030: lifecycle fixtures in tests/contract/turn-lifecycle.test.ts
- T032: cancellation separation in tests/contract/cancellation.test.ts

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete User Story 1 for all currently verified structured homepage actions.
3. Complete User Story 2 for the send/wait primary flow.
4. Validate against a disposable DSH session and the host matrix before adding optional transport or page-sync behavior.

### Incremental Delivery

1. Ship the stdio common set and structured homepage actions.
2. Add event-driven wait and recovery evidence.
3. Add bounded inspection and pending interactions.
4. Add explicit-target verification that remains independent of page selection.
5. Add loopback Streamable HTTP only when a tested host requires it.

## Done When

The implementation is complete when every visible homepage action is mapped to a typed
MCP tool or explicit unsupported result; send_message returns
immediately with a stable turnRef; wait_turn resolves from DSH event/recovery evidence
without periodic polling; default results remain bounded; and the current running
session remains untouched throughout validation.
