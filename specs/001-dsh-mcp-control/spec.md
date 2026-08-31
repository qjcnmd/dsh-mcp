# Feature Specification: DSH Main Work Surface Control via Standard Local MCP

Feature Branch: 001-dsh-mcp-control

Created: 2026-08-31

Status: Draft

Input: The user wants one standard local MCP integration, globally available to any
MCP-compatible Agent that is configured to use it, so those Agents can directly
operate the complete currently user-operable DSH main work surface on the single
local DSH instance. The examples discussed are workspaces, sessions, model and
reasoning selection, messages, running state, turn completion, results, errors,
approvals, questions, and other visible controls. The examples are not exhaustive.
The first release is specification only; implementation follows after acceptance.

## User Scenarios & Testing

### User Story 1 - Directly operate the DSH main work surface (Priority: P1)

As a user of a MCP-compatible Agent, I can directly perform every action currently
available to a person on DSH's main work surface through one standard MCP integration.

Why this priority: Direct operation is the primary goal. The capability boundary is
the complete current main work surface, not a manually chosen subset.

Independent Test: Compare the named DSH version's live main work surface with the
capability inventory, exercise each mapped action in a safe test session, and verify
the same observable state change in the DSH page.

Acceptance Scenarios:

1. Given the local DSH instance is available, when the user asks an MCP-compatible
   Agent to inspect a visible work-surface state, then the corresponding action
   returns the current state and identifies the DSH target.
2. Given a visible action has a supported structured DSH operation, when the user asks
   an Agent to perform it, then the action is applied and the DSH page reflects the
   result.
3. Given a visible action has no structured operation, when the user asks for it, then
   the MCP integration reports an explicit unsupported outcome; it does not invoke
   browser automation as part of the MCP server and never claims an unverified success.

### User Story 2 - Send a message and wait for one turn (Priority: P1)

As a user, I can send a message to an explicitly selected DSH session and later wait
for that specific turn to finish, receiving its terminal state and final answer.

Why this priority: Reliable message submission and completion handling are required
for useful direct control.

Independent Test: Submit a message to a safe test session, verify immediate acceptance,
wait for the matching turn, and compare the returned outcome with the DSH page.

Acceptance Scenarios:

1. Given an explicit session ID, when the user sends a message, then the action returns
   immediately with acceptance information and a reference to the submitted turn.
2. Given a submitted turn is running, when the user waits for that turn, then the wait
   completes on a terminal event rather than requiring periodic status queries.
3. Given the turn completes, fails, is cancelled, is interrupted, or becomes pending
   on human input, when the terminal state is observed, then the result identifies the
   state, gives a concise reason when available, and includes the final answer in its
   original form when one exists.

### User Story 3 - Inspect and intervene on demand (Priority: P1)

As a user, I can request a bounded live snapshot or history slice and can perform the
DSH interventions exposed by the main work surface, including answering questions and
approvals.

Why this priority: Shared state requires visibility and intervention, while normal
responses must remain compact.

Independent Test: During a safe run, request a bounded snapshot, retrieve a bounded
history slice, and complete a pending DSH question or approval.

Acceptance Scenarios:

1. Given a session is active, when the user requests a live snapshot, then the result
   contains current state and recent progress without streaming the entire event log.
2. Given a session has history, when the user requests a bounded history slice, then
   the result contains only that slice with session identity and ordering information.
3. Given DSH requests a question answer or approval, when the user supplies the
   requested response, then the response is submitted to the same session and the
   result reports whether DSH accepted it.

### User Story 4 - Operate DSH through MCP without browser automation (Priority: P2)

As a user of a MCP-compatible Agent, I can operate an explicitly selected DSH session
through the standard MCP interface even when the open DSH page shows another session or
is not used for the operation.

Why this priority: The MCP integration must be a direct control surface rather than a
browser-plugin workflow.

Independent Test: Keep DSH open on one disposable session, operate a different
disposable session through MCP, and verify the backend state and returned target identity
without relying on page selection.

Acceptance Scenarios:

1. Given the DSH page and MCP are connected to the same instance, when MCP selects a
   session, then the page displays that session.
2. Given the page and MCP act on the same session concurrently, when DSH accepts the
   operations, then MCP reports DSH's native ordering and resulting state.

## Clarifications

### Session 2026-08-31

- Q: What is the primary relationship between an Agent and DSH? → A: The Agent
  directly operates DSH; product metaphors such as subagent are not requirements.
- Q: What is the capability scope? → A: The complete currently user-operable main
  work surface, not only the examples discussed.
- Q: How is the integration distributed? → A: One standard local MCP, globally
  available to any configured MCP-compatible Agent.
- Q: Which DSH host is supported? → A: Only the single current local DSH instance.
- Q: How are actions exposed? → A: One action-level tool per visible operation.
- Q: How are sends and waits separated? → A: Sending returns immediately; waiting is a
  separate action for a specified turn.
- Q: What is the default runtime projection? → A: Concise status and terminal result by
  default; live snapshots, history, and diagnostics are on demand.
- Q: What is returned at terminal state? → A: Terminal state, concise reason, and the
  final answer in original form when available.
- Q: Which inputs and controls are included? → A: All controls actually present on the
  current main work surface, including approvals, questions, display/navigation controls,
  and other visible homepage actions; do not invent file upload capability that the
  surface does not provide.
- Q: How are concurrent changes handled? → A: Follow DSH's native ordering and report
  whether each operation was accepted, queued, changed, or rejected.
- Q: How are unavailable models or reasoning choices handled? → A: Report the
  unavailability and ask before using a replacement.
- Q: What happens after transport failure? → A: Reconnect and recover the query using
  DSH history and event position; report uncertainty when completion cannot be proven.
- Q: Must the first release switch the open DSH page to the session selected through MCP? → A: No. The first release operates DSH through standard MCP and DSH structured/event interfaces; page selection synchronization is not required.
- Q: If MCP cannot perform an operation, may the configured Agent independently use browser automation as a fallback? → A: Yes. That fallback is outside the MCP server contract; the MCP path itself remains browser-independent and reports only verified MCP/DSH outcomes.
- Q: Does complete homepage coverage include display and navigation controls as well as execution controls? → A: Yes. View options, Chat/Trajectory selection, copy, export, feedback, and the settings entry are included when visible on the homepage.
- Q: When may an Agent call DSH? → A: Only after the user explicitly requests DSH use
  or a DSH operation.
- Q: What happens for a pending question or approval? → A: Return pending state and
  request details; a later action submits the answer.
- Q: What confirmation is used for high-impact actions? → A: Preserve DSH's native
  confirmation and authorization semantics.
- Q: When DSH requests confirmation or approval for a high-impact action, who supplies the final decision? → A: The configured Agent returns the pending DSH request to the user, and the action continues only after the user's explicit response is submitted through MCP.
- Q: May MCP observe DSH in the background when the user has not requested DSH use? → A: No. MCP remains idle until the user requests a DSH operation or an already submitted turn needs event-driven waiting.
- Q: What is the delivery stage? → A: Complete the specification first; implementation
  and global MCP registration are later phases.

## Requirements

### Functional Requirements

- FR-001: The integration MUST maintain a capability inventory for the complete main
  DSH work surface of the supported DSH version; every visible user action MUST be
  mapped to a typed MCP action or an explicit unsupported outcome.
- FR-002: The integration MUST implement one standard local MCP server that can be
  registered by any MCP-compatible Agent; it MUST NOT require host-specific protocol
  forks.
- FR-003: The integration MUST be available through the user-level configuration used
  for global MCP availability and MUST connect only to the single current local DSH
  instance.
- FR-004: The integration MUST expose action-level tools for workspace inspection and
  explicit workspace targeting, plus every supported visible workspace action.
- FR-005: The integration MUST expose action-level tools for session listing,
  inspection, explicit session targeting, creation, rename, fork, archive, and every
  other supported visible session action.
- FR-006: The integration MUST expose the visible model and reasoning controls and
  MUST return the effective selection after a successful change.
- FR-007: The integration MUST expose message composition and submission modes that
  the main work surface supports, including queueing or steering where available.
- FR-008: The integration MUST expose visible queue, stop, cancel, approval, question,
  and other running-session controls that the current surface supports.
- FR-009: Message submission MUST return immediately with acceptance information and a
  stable reference to the submitted turn.
- FR-010: Waiting MUST target a specified submitted turn and MUST finish when that turn
  reaches a distinguishable terminal outcome or when recovery cannot establish one.
- FR-011: Normal waiting MUST consume DSH's event-bearing interface and MUST NOT use
  periodic polling as its normal mechanism.
- FR-012: Terminal outcomes MUST distinguish completed, failed, cancelled,
  interrupted, pending-human-input, and transport-lost states whenever DSH evidence
  distinguishes them.
- FR-013: A terminal result MUST include the outcome, a bounded reason when available,
  and the final answer in original form when available; intermediate events and full
  tool traces MUST remain out of the default result.
- FR-014: The integration MUST provide explicit actions for bounded live snapshots,
  bounded history, selected event details, and diagnostics.
- FR-015: The integration MUST support reconnect-and-recover behavior after transport
  loss using DSH history and event positions, and MUST report uncertainty rather than
  infer success when evidence is incomplete.
- FR-016: Mutating actions MUST identify an explicit session or workspace target. The
  configured user MAY operate any DSH session, including a running one.
- FR-017: Concurrent operations MUST follow DSH's native ordering and MUST report the
  observed acceptance, queueing, state change, or rejection.
- FR-018: MCP operations MUST use the standard MCP interface and DSH structured or
  event interfaces without depending on browser automation or browser plugins, and
  without requiring page selection synchronization; results MUST identify the explicit
  DSH target and MUST NOT claim that the open page changed selection.
- FR-019: The integration MUST preserve DSH authorization, approval, question,
  confirmation, queue, steering, and cancellation semantics.
- FR-020: If a requested model or reasoning choice is unavailable, the integration
  MUST report the problem and obtain confirmation before applying a replacement.
- FR-021: DSH tools MUST be called only after the user explicitly requests DSH use or
  a DSH operation.
- FR-022: The integration MUST NOT invent file-upload or other input capabilities that
  are absent from the current main work surface; attachment behavior follows the
  capability inventory for the supported DSH version.
- FR-023: If the existing DSH process is unavailable, the integration MUST report a
  clear connection error and MUST NOT start or restart DSH automatically.
- FR-024: Secrets, credentials, and unrelated full conversation content MUST NOT be
  returned in normal tool results or diagnostic logs.
- FR-025: MCP-compatible Agents using the same registration MUST observe the same DSH
  sessions and state; caller names do not need to appear in normal results or the DSH
  page.
- FR-026: The integration MUST expose every visible homepage control, including display
  and navigation actions, through a typed MCP action backed by DSH or an explicit
  unsupported result; browser plugins and visual UI automation are not dependencies of
  the MCP server's first-release execution path.

### Key Entities

- Workspace: A selectable DSH workspace with a stable identifier and display state.
- Session: A DSH conversation and execution context with workspace, selection,
  running state, queue, history, and visible projection.
- Turn Reference: The stable reference to one submitted turn used by send, wait,
  status, inspection, and recovery actions.
- Capability Inventory: The versioned mapping of main-work-surface actions to tools,
  or unsupported status.
- Runtime Snapshot: A bounded view of current session state and recent progress.
- Pending Interaction: A DSH question or approval request awaiting an explicit answer.
- Terminal Outcome: The observed end state and final answer for one turn, or a clear
  statement that the end state could not be established.

## Success Criteria

### Measurable Outcomes

- SC-001: For the supported DSH version, 100% of actions visible and user-operable on
  the main work surface have a typed MCP tool or explicit unsupported status.
- SC-002: In at least 95% of normal local trials, a supported message submission
  returns acceptance information within 2 seconds.
- SC-003: In 100% of test runs where DSH emits a terminal event, waiting returns one
  matching terminal outcome for the specified turn without periodic polling.
- SC-004: At least 95% of test runs classify the observable terminal state correctly
  whenever the underlying DSH evidence is sufficient.
- SC-005: Default send, status, and wait results do not include the full event stream or
  full history; those are returned only after an explicit inspection request.
- SC-006: 100% of mutating tool calls in acceptance tests include an explicit target,
  and no operation changes a different target than the one reported by DSH.
- SC-007: In 100% of primary-flow acceptance tests, MCP completes operations against
  the explicit target even when the open DSH page shows another session or is not used.
- SC-008: At least two independent MCP-compatible Agents can register the same MCP
  server and observe the same local DSH sessions and state.
- SC-009: A user can complete the primary flow of selecting a target, sending a
  message, waiting for its turn, and receiving the final answer without visual UI
  automation.

## Assumptions

- The first release targets the currently installed local DSH version and one local
  DSH process at a time.
- DSH remains the source of truth for permissions, session history, queue semantics,
  approvals, questions, model availability, confirmation, and execution state.
- User-level MCP registration is the intended distribution point for global
  availability; each compatible Agent supplies its own registration syntax.
- The main work-surface inventory will be captured against the named DSH version and
  revisited when DSH is upgraded.
- Actions without a safe DSH or MCP contract are reported as unsupported. The MCP server
  remains browser-independent; a configured Agent may choose an external browser
  fallback when MCP cannot perform a requested operation, without changing the MCP
  result contract.
- Normal operation uses concise results; the user can request selected detail.
- Transport recovery may prove that a turn ended, but if available evidence cannot prove
  its outcome the integration reports that uncertainty.
- The service lifecycle is an implementation detail; users experience one configured
  standard MCP capability rather than managing per-Agent protocol variants.
