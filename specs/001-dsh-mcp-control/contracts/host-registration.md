# Host Registration Contract

MCP standardizes the protocol and transport behavior, not the user-level config file
or global-registration UX of every host. The adapter therefore ships one server
definition plus host-specific documentation examples; it does not fork the protocol
or tool registry.

## Required local definition

The implementation must provide one local command that starts the server over stdio,
for example the package's installed executable or node entry point. The definition
must accept configuration through explicit environment variables or arguments:

~~~text
DSH_BASE_URL=http://127.0.0.1:3080
DSH_CONNECT_TIMEOUT_MS=<bounded value>
DSH_LOG_LEVEL=<error|warn|info>
~~~

The command must write MCP protocol traffic only to stdout and diagnostics only to
stderr. It must return a clear connection error when DSH is unavailable and must not
start or restart DSH.

## User-level global registration

For each intended local MCP host, document the host's current user-scope registration
syntax using that host's official documentation. The examples must point to the same
server command and environment, and must record whether the host supports:

- stdio process launch;
- loopback Streamable HTTP;
- modern/legacy protocol era;
- structured tool results;
- input-required multi-round results;
- request cancellation;
- Tasks, progress, subscriptions/listen, list-changed, and elicitation.

“Global” means user-level registration in a host that supports that scope; MCP itself
does not make one config file universal across different Harness Agents or other hosts.

## Optional loopback Streamable HTTP

Add a URL entry point only when a tested host requires it. It must:

- bind to loopback by default;
- use the official SDK's Streamable HTTP transport;
- validate Origin and host policy;
- make process ownership and shutdown behavior explicit;
- avoid exposing the DSH port or credentials to the network;
- preserve the exact same tool names and schemas as stdio.

The older HTTP+SSE transport is not a new implementation target. A future remote or
ChatGPT-cloud connection is a separate deployment decision requiring a reviewed
reachability, authentication, and tunnel boundary.

## Host matrix record

The implementation handoff must include a table with one row per tested host:

| Host | Scope | Transport/era | Structured/input-required | Cancel | Tasks/progress/subscriptions | Elicitation | Evidence date |
|---|---|---|---|---|---|---|---|
| Harness Agent A | user-level | measured | measured | measured | measured | measured | implementation date |
| Harness Agent B | user-level | measured | measured | measured | measured | measured | implementation date |
| Additional host | user-level | measured | measured | measured | measured | measured | implementation date |

Unmeasured cells remain unknown; they are not inferred from another host.
