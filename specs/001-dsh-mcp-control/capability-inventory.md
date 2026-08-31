# DSH Main Work Surface Capability Inventory

Capture date: 2026-08-31  
DSH package: @deepseek-ai/dsh 0.1.1-rc.2  
Endpoint: http://127.0.0.1:3080/  
Inventory target: the currently rendered DSH main work surface, plus the structured
operations and event frames that directly back those controls.

The page capability check exposed a WebMCP capability, but its tool description was
exactly “No WebMCP tools are available in this document.” The page therefore does not
currently provide a WebMCP action surface for this adapter.

The live page used for this capture had workspaces wiki, test, dsh, and Harness.
The selected session was session-80e62e95-533a-48d9-b1d1-235957532eeb
(执行全核心集中收敛 G5：修复), which was running during the audit. No message,
model, permission, queue, cancel, rename, fork, archive, or other operation was
sent to that session.

## Support labels

- **structured**: a DSH RPC, event stream, or /api/respond contract was found.
- **local-ui**: the control is frontend-local state and is not a DSH operation.
- **external-fallback**: a Harness Agent may independently choose a UI fallback when
  MCP cannot perform a requested action; this is outside the MCP server contract.
- **out-of-scope**: visible but outside the main work surface boundary for this
  feature.
- **pending**: the live surface or exact response semantics still require a safe
  implementation-time check.

## Inventory

| ID | Surface control | User operation | DSH evidence | Adapter status | Target/result notes |
|---|---|---|---|---|---|
| WS-001 | Workspace/session list | List workspaces and sessions | workspace.list, session.list; schemas in dsh-host-apiproxy/lib/types/api/workspace.schema.js and sessions.schema.js | structured | Return bounded rows, IDs, workspace membership, running/blank state. |
| WS-002 | View options | Group by workspace or single list; sort manual or recent | Browser-local view state in dsh-client-ui-workspace/lib/client.js | unsupported | Page-only display state has no MCP operation in the current DSH contract. |
| WS-003 | Workspace row | Select/open a workspace for new-session flow | New-session picker passes workspaceId to session.create | structured | Mutations require an explicit workspaceId. |
| WS-004 | Add workspace | Adopt an existing directory | workspace.create({path}) | structured | Directory selection itself may require host-side path input. |
| WS-005 | Workspace actions | Rename workspace | workspace.rename | structured | Explicit workspaceId; return accepted workspace view. |
| WS-006 | Workspace actions | Delete workspace | workspace.delete | structured | High-impact; preserve DSH confirmation/authorization semantics. |
| WS-007 | Workspace drag order | Reorder workspaces | workspace.insertBefore | structured | Return complete durable workspace order. |
| WS-008 | Workspace row | Create a session in a workspace | session.create({workspaceId}) | structured | Return created sessionId; no implicit current-session target. |
| WS-009 | Session tree | Open/select a session | SessionRuntime.open() and persisted dsh.sessions.current; no DSH RPC found | unsupported | MCP operations use explicit sessionId targets; changing the page's local selection is not an MCP capability. |
| WS-010 | Search sessions | Search visible session content | session.search({query}) | structured | Return bounded results and snippets. |
| WS-011 | Session actions | Rename a session | session.rename | structured | Explicit sessionId; return normalized title and sequence. |
| WS-012 | Session actions | Fork a session | session.fork | structured | Optional completed-event anchor; return child session ID. |
| WS-013 | Session actions | Archive a session | workspace.archiveSession | structured | Return updated archived set. |
| WS-014 | Session drag order | Reorder a session within a workspace | workspace.insertSessionBefore | structured | Explicit workspace/session IDs and optional anchor. |
| WS-015 | New-session hero | Choose workspace, enter initial prompt, select preset/mode | session.create, session.prompt; visible fields include workspace, mode, prompt | pending | Exact preset/mode persistence must be checked against the live create path. |
| WS-016 | Conversation tabs | Switch Chat/Trajectory view | Frontend-local tab state; data comes from history/events | unsupported | MCP can return bounded chat/history/trace data, but page tab selection is local. |
| WS-017 | Session log | Open session log | session.history; event stream carries ordered session events | structured | Return bounded history/event slices, not the entire log by default. |
| WS-018 | Load earlier | Load older messages/events | session.history({sessionId,beforeSeq,maxMessages}) | structured | Preserve ordering and hasMore. |
| WS-019 | Model menu | Read available providers/models/reasoning efforts | session.models | structured | Return current selection, groups, failures, and routability. |
| WS-020 | Model menu | Select model and reasoning effort | session.selectModel | structured | Return effective provider/model/reasoningEffort; unavailable choices are errors, not silent replacements. |
| WS-021 | Access mode | Read-only, Workspace Write, or Full access | Composer command /permission; resulting permission/preset, sandbox/mode, and approval/policy events | structured | Preserve DSH's Full-access confirmation and authorization behavior. Exact command IDs need implementation-time capture. |
| WS-022 | Command menu | compact | Slash command submitted through session.prompt; compaction result appears in session events/projections | structured | Return command admission; completion is observed from the turn/event lifecycle. |
| WS-023 | Command menu | export | Session-log/download surface; exact download route is host-owned | pending | Need one safe implementation-time check of the download contract before exposing it. |
| WS-024 | Command menu | feedback | Slash command/feedback surface; exact persistence route is host-owned | pending | Keep as explicit pending capability until its current response is captured. |
| WS-025 | Command menu | goal | goal.create/edit/pause/resume/complete/clear; command menu also exposes goal state | structured | Scope to goal controls rendered on the main page; settings/goal documents remain separate. |
| WS-026 | Command menu | model | Opens the same model directory as WS-019/020 | structured | Do not duplicate model semantics in a second adapter path. |
| WS-027 | Message composer | Send text | session.prompt({sessionId,content, optional mode:"queue"|"steer"}) | structured | The logical send mode maps to the verified DSH default prompt path; queue/steer are exposed only when confirmed. Return immediately with DSH acceptance and a stable turnRef. |
| WS-028 | Message composer | Send image content when the composer accepts it | session.prompt image content parts; session.attachment reads durable image refs | pending | The current DOM had no visible file button; paste/drop and exact attachment admission need a safe test-session check. |
| WS-029 | Message composer | Stop generation | session.cancel | structured | Explicit session target; does not implicitly cancel queued messages. |
| WS-030 | Queue dock | Edit a queued message | session.updateQueue({action:{kind:"edit",content}}) | structured | Return acceptance/rejection and the targeted queue item. |
| WS-031 | Queue dock | Remove a queued message | session.updateQueue({action:{kind:"remove"}}) | structured | Explicit queue item ID. |
| WS-032 | Queue dock/composer | Steer queued messages into the running turn | session.updateQueue({action:{kind:"steer"}}) and session/queue events | structured | Preserve DSH's best-effort steer-unavailable behavior. |
| WS-033 | Running session | Read current running/idle/error state | host/session-status, host/agent-error, session/projection, session/jobs frames | structured | Bounded snapshot only; no full-event-log injection. |
| WS-034 | Turn lifecycle | Observe completed/failed/cancelled/interrupted/pending-input | /api/events.mux and /api/events.host, including turn/end, approval/question frames | structured | wait_turn must wait on these events and recovery, not periodic DSH status polling. |
| WS-035 | Approval panel | Allow once or reject a pending approval | /api/respond client response using approvalResponsePayload | structured | Target sessionId + approvalId; return DSH resolution event. |
| WS-036 | Question panel | Answer a question batch | /api/respond client response using questionResponsePayload | structured | Target the pending question RPC identity; answer the whole batch. |
| WS-037 | Question panel | Observe cancelled/interrupted/answered question state | question/requested and question/resolved event frames | structured | Map pending input to a resumable terminal wait result. |
| WS-038 | Task status button | Read task/job progress | session/jobs event frame and job projection | structured | Return bounded counts/items; do not copy the complete task transcript. |
| WS-039 | Message actions | Copy a message/answer | Browser clipboard action | unsupported | MCP may return the selected message body on request; clipboard mutation is not an MCP capability. |
| WS-040 | Message actions | Mark answer good/bad | Feedback control/plugin surface | pending | Exact durable operation must be captured before claiming support. |
| WS-041 | Message actions | Branch from a completed message | session.fork with an event anchor | structured | Only completed-turn anchors are valid. |
| WS-042 | Tool rows/details | Inspect a selected tool call/result | session.history entries with optional tool views and session/projection | structured | Bounded selected detail; never stream all tool traces by default. |
| WS-043 | Tool rows/details | Open a referenced local path | host.openPath | structured | Return whether the host accepted the open request; do not expose arbitrary paths without target validation. |
| WS-044 | Context meter/stats | Inspect context usage and turn statistics | Session projections/events; no separate mutating RPC | structured | Return bounded metrics on explicit request. |
| WS-045 | Subagent indicator/tree | List or inspect visible child sessions | subagent.list, subagent.history | structured | Include only when the main page exposes the child-session control. |
| WS-046 | Subagent controls | Prompt or interrupt a visible child session | subagent.prompt, subagent.interrupt | structured | Explicit parent/child address; preserve parent availability rules. |
| WS-047 | Settings button | Open/edit global settings | settings.* exists, but settings is a separate page | pending | The visible homepage entry is in scope; exact MCP action and separate-page boundary require an implementation-time contract check. |
| WS-048 | DSH page selection sync | Make an MCP session selection appear selected in the open page | No structured DSH operation confirmed; selection is browser-local | out-of-scope | MCP does not depend on or claim page-selection synchronization. |

## Source evidence index

- RPC client roster: C:\nvm4w\nodejs\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-client-connection\lib\client.js:6282-6315.
- Session schemas and payloads: ...\dsh-host-apiproxy\lib\types\api\sessions.schema.js:30-285.
- Workspace schemas and payloads: ...\dsh-host-apiproxy\lib\types\api\workspace.schema.js:6-84.
- Approval/question response contracts: ...\dsh-host-apiproxy\lib\types\api\approvals.schema.js:1-17 and questions.schema.js:1-22.
- Mux/host event unions: ...\dsh-host-apiproxy\lib\types\api\events.schema.js:13-67.
- Workspace/session visible menu labels and handlers: ...\dsh-client-ui-workspace\lib\client.js:448-520 and :680-780.
- Composer controls, queue actions, image admission, stop, command palette, and approval/question UI: ...\dsh-client-ui-conversation\lib\client.js:115-270, :3560-4100, and :5925-6125.
- Browser-local session selection: ...\dsh-client-runtime\lib\client.js:8967-8990 and :9165-9185.

## Inventory decisions for implementation

1. Generate MCP registration from structured rows; register explicit unsupported
   outcomes for browser-local controls that have no DSH contract.
2. Treat WS-009 and WS-048 as explicit non-capabilities: MCP targets sessions by ID
   and never claims that the open page changed selection.
3. Keep WS-023, WS-024, and WS-040 pending until one safe test-session audit
   captures their current result/download semantics.
4. Use the event rows (WS-033 through WS-037) as the only normal source for wait_turn;
   RPC history is recovery and explicit inspection, not a polling loop.
5. Re-capture this inventory whenever the installed DSH package changes from
   0.1.1-rc.2.
