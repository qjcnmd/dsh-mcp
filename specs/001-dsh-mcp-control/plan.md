# Implementation Plan: DSH Main Work Surface Control via Standard Local MCP

**Branch**: `001-dsh-mcp-control` | **Date**: 2026-08-31 | **Spec**: [spec.md](./spec.md)

## Summary

Build one local, standard MCP server that exposes the complete user-operable DSH
main work surface through small typed action tools. The server will call DSH's
existing HTTP RPC interface for commands and maintain an internal subscription to
DSH's event streams for state projection, turn completion, and recovery.

The first interoperability baseline is MCP `2026-07-28`, which the official
specification and release page show as the latest version on 2026-08-31. The
implementation must still let the selected official SDK handle legacy
`2025-11-25` initialization-era peers without putting a second protocol into DSH
handlers. The default local transport is stdio. A loopback Streamable HTTP entry
point may be added by the same server when a tested host requires URL-based
registration. MCP Tasks, progress notifications, subscriptions, input-required
multi-round results, and WebMCP remain negotiated or separate surfaces; none is a
correctness dependency for DSH waiting.

## Technical Context

**Language/Version**: TypeScript on the Node.js LTS available at implementation
 kickoff; pin exact versions after verifying the current official MCP TypeScript
 SDK release and Windows stdio behavior.

**Primary Dependencies**: Official `@modelcontextprotocol/sdk` (exact stable
 version selected at implementation kickoff), including its modern 2026-07-28 and
 legacy protocol support, the Node.js HTTP and streaming primitives
 already compatible with the installed DSH package, and schema validation using the
 SDK's supported JSON Schema path. No dependency is added until its current API,
 license, maintenance status, and Windows behavior are checked.

**Storage**: No new durable database. The adapter keeps bounded in-memory
 projections and reconnect cursors; any durable cursor or diagnostic artifact must
 be explicitly justified during implementation. DSH remains the source of truth for
 history, permissions, and execution state.

**Testing**: Node/TypeScript unit tests for pure mapping and projection logic; MCP
 contract tests against the selected official SDK; integration tests against a
 disposable local DSH test session and a controlled event-stream fixture. The
 currently running DSH session is excluded from all validation.

**Target Platform**: Windows desktop, single local DSH process at the configured
 loopback endpoint, with user-level MCP registration for compatible local hosts.

**Project Type**: Local MCP server/adapter.

**Performance Goals**: `send_message` acknowledgement within the DSH RPC response
 time and normally under 2 seconds; `wait_turn` adds no periodic DSH status polling
 and returns once the selected turn reaches an observed terminal or pending-input
 state.

**Constraints**: One current local DSH instance; no automatic DSH start/restart;
 explicit session/workspace targets for mutations; concise default results; no full
 event-log injection into the Agent context; preserve DSH ordering, approval,
 question, queue, steering, and cancellation semantics; no host-specific protocol
 forks.

**Scale/Scope**: One local DSH instance shared by multiple Harness Agents, all sessions
 visible to the configured user, and every user-operable action on the supported DSH
 homepage/main work surface, including visible display and navigation controls. Settings
 editing, skill management, credential management, and other separate pages remain
 outside this feature unless a visible homepage control has a verified DSH contract.

## Constitution Check

*Gate evaluated before Phase 0 and re-evaluated after Phase 1.*

| Principle | Plan response | Status |
|---|---|---|
| I. API-First DSH Control | The MCP adapter uses DSH structured RPC/events for supported operations; when no safe contract exists it returns unsupported. Browser automation may be chosen by an external Harness Agent, but is not an MCP server dependency. | PASS |
| II. Explicit Context Ownership | Tool results use bounded structured projections; `wait_turn` returns one selected turn's terminal/pending result; full events/history require explicit inspection. | PASS |
| III. Homepage Capability Coverage | A versioned capability inventory is generated from the named DSH homepage and checked against every visible action; unsupported entries are explicit. | PASS |
| IV. Event-Driven Lifecycle | One internal DSH event subscription and cursor/recovery layer drives `wait_turn`; MCP progress/Tasks/notification are optional presentation enhancements. | PASS |
| V. Small, Typed, Composable Tools | One action-level MCP tool per supported visible operation, with explicit target IDs, output schemas, and domain-vs-protocol error separation. | PASS |
| Security and Operational Boundaries | DSH remains the authority for permissions and confirmations; no secrets/raw credentials in normal results; no automatic DSH lifecycle control. | PASS |
| Development Workflow | This plan follows the accepted spec, records official research, defines contracts, and reserves focused integration evidence for implementation. | PASS |

## Architecture

### Boundary A: MCP host transport

The server exposes the same tool registry through stdio first. If a concrete host
cannot register local stdio but can reach a URL, add a loopback-only Streamable HTTP
transport using the official SDK and document its process ownership, origin checks,
and authentication boundary. The transport layer performs MCP version/capability
negotiation (including modern per-request metadata and server/discover), request
cancellation, and any supported subscriptions; it does not interpret DSH events.

### Boundary B: action and projection layer

Each action handler validates its typed input, requires an explicit workspace or
session target for mutations, invokes one DSH operation, and maps the DSH response to
an MCP result containing structured data plus a compact readable summary. The handler
reports whether DSH accepted, queued, changed, superseded, or rejected the request.

`send_message` returns immediately with a stable `turnRef`. `wait_turn` accepts that
reference, subscribes to the internal event projection, and returns only the selected
turn's state. When a host supports modern MCP input-required results, the adapter may
also return the negotiated `input_required` shape; the stable DSH action-level answer
and approval tools remain available for hosts that do not implement that round trip.
A client cancellation stops observation and releases the subscription; it does not
implicitly call DSH cancel. Explicit DSH stop/cancel remains its own tool.

For a host whose tool-call timeout is too short for a turn, the adapter may expose the
same event-driven wait through the negotiated MCP Tasks result. The task worker waits
on the adapter projection; a client polling `tasks/get` never causes polling of DSH.

### Boundary C: DSH adapter and event projection

The DSH adapter owns HTTP unary RPC calls, the `/api/events.mux`/`/api/events.host`
server-sent event streams, event ordering, reconnect cursors, and recovery queries. It
normalizes DSH events into a small internal state model without copying full message
or tool traces into the MCP result. On reconnect it uses DSH history and the last
known event position; if evidence cannot prove the outcome it returns an explicit
uncertain/transport-lost result.

### Capability inventory

Before implementation, capture the named DSH version's main work surface and record
for every visible user action: capability ID, page region, action label, DSH source
operation/event, MCP tool name, target requirements, result projection, and unsupported
  or pending status. The inventory is versioned with the adapter and is the source
for tool registration and coverage tests.

## Implementation Phases

### Phase 0: research and boundary confirmation

Completed in [research.md](./research.md). Re-check the official MCP release status,
SDK version, and host capability matrix at implementation kickoff because these are
time-sensitive. Reconfirm DSH's current main-work-surface inventory and event/turn
identifiers with read-only evidence before writing handlers.

### Implementation kickoff baseline (2026-08-31)

The local runtime is Node.js v24.19.0 with npm v11.17.0. The selected official
TypeScript server package is `@modelcontextprotocol/server@2.0.0` (MIT, Node.js
20+), which is the v2 package line for the 2026-07-28 protocol baseline. The
package exports `serveStdio` and `StdioServerTransport`; the stdio transport reads
JSON-RPC from the process stdin and writes JSON-RPC to stdout. Its stdio serving
helper defaults to serving legacy 2025-era openings and can be configured to
reject them, so the adapter keeps one tool registry across the negotiated era.

The project pins `@modelcontextprotocol/server@2.0.0`, `zod@4.5.4`,
`typescript@7.0.2`, `vitest@4.1.11`, `tsx@4.23.13`, and `@types/node@26.4.0`.
Windows-specific behavior is intentionally limited to Node's process stdio
binding; diagnostics remain on stderr and no shell-specific transport is added.
The contract suite will exercise a real Windows pipe before release evidence is
recorded.

### Phase 1: domain model and contracts

Produce [data-model.md](./data-model.md), the tool and lifecycle contracts under
[contracts/](./contracts/), and the end-to-end validation guide
[quickstart.md](./quickstart.md). Contracts define the stable adapter surface; they
do not expose raw DSH transport details unless diagnostics are explicitly requested.

### Phase 2: implementation sequencing

1. Scaffold the TypeScript MCP server and stdio entry point using the selected
   official SDK, targeting MCP 2026-07-28 and its legacy compatibility boundary.
2. Implement the DSH HTTP RPC client with typed request/response envelopes and
   clear connection/protocol/domain error mapping.
3. Implement the DSH event-stream client, bounded projection, cursor tracking,
   reconnect/recovery, and turn state machine.
4. Build the versioned capability inventory and register action-level tools from it.
5. Implement send, wait, snapshot/history/diagnostic inspection, and explicit
   question/approval/queue/stop/cancel interventions.
6. Keep page selection and other browser-local display state out of the MCP target
   model; record an explicit unsupported or out-of-scope result when no DSH contract
   exists, without adding a browser plugin or visual automation dependency.
7. Add modern input-required mapping, an optional Tasks façade for hosts with short
   call timeouts, and optional loopback Streamable HTTP only after the negotiated host
   behavior and security/operational boundary are tested.
8. Run the focused contract and integration evidence in quickstart.md, excluding
   the user's currently running session.

## Project Structure

### Documentation (this feature)

```text
specs/001-dsh-mcp-control/
├── spec.md
├── research.md
├── plan.md
├── data-model.md
├── quickstart.md
├── capability-inventory.md
├── contracts/
│   ├── mcp-tools.md
│   ├── lifecycle-and-events.md
│   └── host-registration.md
└── tasks.md
```

### Source Code (implementation phase)

```text
src/
├── config.ts
├── server.ts
├── mcp/
│   ├── actions/
│   ├── register-tools.ts
│   ├── result-projection.ts
│   └── transport.ts
├── dsh/
│   ├── rpc-client.ts
│   ├── event-client.ts
│   ├── capability-inventory.ts
│   └── recovery.ts
├── domain/
│   ├── targets.ts
│   ├── turns.ts
│   ├── pending-interactions.ts
│   └── snapshots.ts
└── errors.ts

tests/
├── contract/
├── integration/
└── unit/
```

**Structure Decision**: A single local server keeps the MCP registry and DSH
adapter in one deployable process, while separate `mcp`, `dsh`, and `domain`
boundaries prevent protocol-generation changes from entering DSH state semantics.
The capability inventory is shared by registration and coverage tests, so a new
visible DSH action cannot silently remain unexposed.

## Verification Strategy

- Contract checks validate `tools/list`, input/output schemas, structured results,
  business-error `isError`, protocol errors, explicit targets, and stable turn refs.
- Event-fixture tests validate completed, failed, cancelled, interrupted,
  pending-human-input, transport-lost, duplicate, out-of-order, and reconnect
  recovery paths.
- Integration tests use a disposable DSH session and compare MCP-visible state with
  DSH structured reads/event evidence; the existing running session is never a test target.
- Host matrix checks register the same server in at least two independent local MCP
  hosts and record transport, modern/legacy era, structured-result, input-required,
  cancellation, Tasks, progress, subscriptions, and elicitation support separately.
- Coverage checks fail when a visible homepage action has no typed MCP tool or explicit
  unsupported entry.

## Open Items Carried to Implementation

- Reconfirm the current latest specification and select the official SDK release that
  implements the required modern baseline plus the needed legacy boundary on
  implementation start.
- Verify the exact DSH turn identifier, event cursor/resume fields, and every current
  homepage control against the installed DSH version.
- Verify each intended host's current global registration syntax and transport
  support; a local stdio registration does not imply ChatGPT cloud reachability.
- Decide whether loopback Streamable HTTP is needed after testing the actual host set.

## Complexity Tracking

No constitution violations are planned.

## Post-Design Constitution Re-evaluation

The Phase 1 artifacts preserve the five core principles: structured DSH RPC remains
the execution path, projections are bounded, the capability inventory drives coverage,
turn waiting is event-driven, and the external surface remains typed and composable.
Host-specific registration details and optional MCP extensions are isolated in their
own contract and do not change DSH authorization or lifecycle semantics. **PASS.**
