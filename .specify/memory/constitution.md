<!--
Sync Impact Report
- Version change: 1.3.0 → 1.3.1
- Modified principles: Principle II generalizes context projection to the calling Agent without prescribing a product relationship; Principle III binds coverage to the main DSH work surface; Security and Operational Boundaries reflect global MCP use and DSH-native confirmation
- Added sections: Security and Operational Boundaries; Development Workflow
- Removed sections: none
- Follow-up TODOs: none
-->

# DSH MCP Constitution

## Core Principles

### I. API-First DSH Control

The project MUST use DSH's structured control and event interfaces as the source of
truth for automation. UI automation MAY be used for visual inspection or a capability
that the structured interface genuinely cannot expose, but it MUST NOT be the default
execution path for supported DSH operations.

### II. Explicit Context Ownership

Each DSH session MUST have explicit context ownership and result-projection rules. The
default projection MUST return concise acknowledgements, bounded status updates, and
terminal outcomes without forwarding every incremental event, tool call, or historical
message into the calling Agent context. The adapter MUST support explicit requests for
selected live increments, history, diagnostics, or runtime intervention. Whether DSH
is described in product terms is outside the transport contract and MUST NOT be inferred
by the transport layer.

### III. Homepage Capability Coverage

The supported surface MUST be defined by the complete set of user-operable actions
currently available on the main DSH work surface, not by a fixed list of examples.
The adapter MUST cover every such action that can be mapped safely, including
workspace, session, model, reasoning, message, queue, result, approval, question,
and other visible interactions. It MUST document actions outside that surface or
actions that the current DSH version does not expose, and MUST not invent an upload
or other capability that the current surface does not provide.

### IV. Event-Driven Lifecycle

Long-running DSH work MUST be observed through its event stream and durable cursors,
not periodic polling. Completion, failure, cancellation, interruption, and transport
loss MUST be represented as distinct observable outcomes whenever DSH provides enough
information to distinguish them.

### V. Small, Typed, Composable Tools

The external tool surface MUST expose small, typed operations with explicit inputs,
outputs, and error semantics. Tools MUST compose around session handles and MUST NOT
leak transport-specific details unless a caller explicitly requests diagnostics.
DSH tools MUST be invoked only when the user explicitly requests DSH use or a DSH
operation. New abstractions require a current consumer and MUST remove directly
replaced paths within the same change.

## Security and Operational Boundaries

The adapter MUST treat DSH permissions as high-impact authority. Mutating calls MUST
identify their target session or workspace explicitly, while the configured user may
operate any DSH session, including one already running. The adapter MUST preserve
DSH's native ordering, approval, question, cancellation, and confirmation semantics.
Secrets, tokens, and raw credentials MUST NOT be returned in tool results or logs. The
adapter MUST record enough structured information to diagnose request, event-stream,
and terminal state failures without recording full conversation content by default.

## Development Workflow

Every feature MUST begin with a user-oriented specification and measurable acceptance
scenarios. Changes to the DSH contract, event interpretation, persistence, or
permissions MUST include focused contract or integration evidence. Before declaring
completion, the implementation MUST pass the smallest sufficient validation for the
changed behavior, and the report MUST distinguish verified facts, assumptions, and
remaining unknowns.

## Governance

This constitution governs the DSH MCP project and takes precedence over local
conventions that conflict with it. Amendments MUST document the affected principles,
the reason for the change, the migration or compatibility impact, and the validation
performed. Versioning follows semantic versioning: MAJOR for incompatible governance
changes, MINOR for new or materially expanded principles, and PATCH for clarifications
that do not change project obligations. Every specification, plan, implementation,
and review MUST check compliance with the current constitution. Unresolved conflicts
are escalated before implementation rather than hidden in compatibility branches.

**Version**: 1.3.1 | **Ratified**: 2026-08-31 | **Last Amended**: 2026-08-31
