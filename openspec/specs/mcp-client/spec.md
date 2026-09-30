# mcp-client Specification

## Purpose

Define how `koishi-plugin-yesimbot-mcp-client` connects MCP servers, exposes MCP tools through the agent plugin system, refreshes tool catalogs, and cleans up resources.

## Requirements

### Requirement: Stable MCP Tool Registry
The MCP client plugin MUST expose MCP server tools through stable `AgentPlugin.tools` declarations rather than recreating tools through `extendTools` on every turn.

#### Scenario: Initial tool discovery
- **WHEN** the MCP client starts and connects to configured servers
- **THEN** it MUST call `listTools()` for each connected server
- **AND** it MUST convert returned MCP tools to named `AgentTool` definitions
- **AND** it MUST publish those tools through a named AgentPlugin object registered with `ctx.yesimbot.agent.use`

#### Scenario: Tool name prefix
- **WHEN** an MCP server named `docs` exposes a tool named `search`
- **THEN** the exposed agent tool name MUST be `docs-search`
- **AND** the prefixed name MUST be used for conflict detection by the agent runtime

#### Scenario: Stable tool order
- **WHEN** MCP tools are published to the AgentPlugin object
- **THEN** the plugin MUST sort the exposed tool list by final agent tool name
- **AND** later runtime snapshots created from the same catalog MUST expose tools in the same order

### Requirement: MCP Tool Catalog Refresh
The MCP client plugin MUST react to MCP tool catalog change notifications by refreshing the cached server tool registry and replacing its registered AgentPlugin object.

#### Scenario: Server reports tool list change
- **WHEN** a connected MCP server sends `notifications/tools/list_changed`
- **THEN** the plugin MUST call `listTools()` again for that server
- **AND** it MUST rebuild that server's cached tool definitions
- **AND** it MUST dispose the previously registered AgentPlugin object
- **AND** it MUST register a replacement object through `ctx.yesimbot.agent.use`

#### Scenario: Refresh affects future runtimes
- **WHEN** the MCP client replaces its AgentPlugin object after a tool list change
- **THEN** channel runtimes created after the refresh MUST see the refreshed tool list
- **AND** already-created channel runtimes MUST retain their existing snapshot

#### Scenario: Refresh failure
- **WHEN** refreshing a server's tool list fails
- **THEN** the plugin MUST log the failure
- **AND** it MUST NOT publish a partial empty replacement for that server solely because refresh failed

#### Scenario: Refresh invalidates pending confirmations
- **WHEN** a server successfully refreshes its tool catalog and the replacement AgentPlugin is published
- **THEN** the plugin MUST clear every pending confirmation
- **AND** a short code issued before the refresh MUST NOT authorize a call after the refresh
- **AND** the post-refresh call MUST remain blocked until a new confirmation is issued

### Requirement: MCP Resource Cleanup
The MCP client plugin MUST clean up its registered AgentPlugin object and MCP resources on stop.

#### Scenario: Plugin stop
- **WHEN** the MCP client stops
- **THEN** it MUST dispose the registered AgentPlugin object
- **AND** it MUST close connected MCP clients
- **AND** it MUST close connected transports
- **AND** it MUST clear internal client and transport registries


### Requirement: MCP inline media becomes artifact references
The MCP client plugin MUST recognize supported inline image blocks, validate and persist their bytes through its current channel-bound artifact writer, and return compact safe metadata plus the canonical `artifact://<tool-name>/<uuid-v7>` URI. It MUST NOT return Base64 image data, provider-specific media parts, source URLs, or opaque serialized media blocks to Agent history or model input.

#### Scenario: MCP tool returns an inline image
- **WHEN** an MCP tool returns a supported inline image block within the configured image limits
- **THEN** the plugin MUST persist the decoded bytes through its current channel-bound artifact writer
- **AND** it MUST return a compact `artifact://` reference

#### Scenario: MCP tool returns an unknown media block
- **WHEN** an MCP tool returns a non-text block that is not a supported inline image
- **THEN** the plugin MUST return a bounded safe description
- **AND** it MUST NOT `JSON.stringify` the opaque block into model input

#### Scenario: MCP tool returns a remote URL
- **WHEN** an MCP tool returns a remote media URL or resource link
- **THEN** the plugin MUST return a safe reference description
- **AND** it MUST NOT fetch that URL automatically

### Requirement: MCP artifact guidance preserves remote tool descriptions
The MCP client plugin MUST add one Runtime-level system prompt stating that MCP media results are immutable `artifact://` references and that the Agent calls Core `read` only when the media content is needed. It MUST state that media is not inline Base64 and that remote URLs are not automatically available. The plugin MUST preserve each remote MCP tool's original description rather than appending that common guidance to every tool description.

#### Scenario: An MCP Runtime is initialized
- **WHEN** the MCP client contributes one or more remote tools to a channel Runtime
- **THEN** the Runtime system prompt MUST contain the MCP artifact guidance once
- **AND** each remote tool description MUST retain its server-provided text

### Requirement: Remote MCP bearer tokens come from owner-only files
The MCP client plugin MUST support resolving `Authorization: Bearer <token>` for `http` and `sse` servers from an operator-provided `bearerTokenFile` instead of an inline configuration value. It MUST read the file as a single trimmed token, MUST require owner-only permissions (no group or other access) on a regular file owned by the running process, and MUST reject missing, empty, unreadable, or multi-line files. It MUST reject a server that configures both `bearerTokenFile` and an explicit `Authorization` header. It MUST NOT write the token or any other header/environment value into logs, error messages, or tool output.

#### Scenario: Token file is valid
- **WHEN** a remote server is configured with `bearerTokenFile` pointing at a readable owner-only file
- **THEN** the plugin MUST send `Authorization: Bearer <trimmed file content>` to that server
- **AND** it MUST NOT require the token to appear in the Koishi configuration

#### Scenario: Token file is unusable
- **WHEN** the token file is missing, unreadable, empty, multi-line, writable by group or other, or owned by another user
- **THEN** the plugin MUST refuse to connect that server
- **AND** the reported reason MUST describe only the failure category
- **AND** it MUST NOT contain the file content

#### Scenario: Two Authorization sources are configured
- **WHEN** a remote server configures both `bearerTokenFile` and an explicit `Authorization` header
- **THEN** the plugin MUST refuse to connect that server
- **AND** it MUST NOT choose one source silently

#### Scenario: Connection diagnostics are inspected
- **WHEN** the plugin logs remote connection setup, header configuration, or stdio environment configuration
- **THEN** every log entry MUST contain field names or configured-state only
- **AND** no log entry, thrown error, or tool result may contain a token value

### Requirement: Complete MCP catalogs stay registered behind a hard confirmation gate
The MCP client plugin MUST register every tool returned by `listTools()` for a connected server and MUST NOT drop tools through a static allowlist. Before calling upstream `client.callTool()`, it MUST classify each tool from its upstream name and description, allow explicitly read-only tools through, and require confirmation for every tool that either has a side-effect signal or cannot be proven read-only.

#### Scenario: A catalog contains side-effect tools
- **WHEN** a connected server exposes order, payment, cancellation, or other state-changing tools
- **THEN** those tools MUST still be registered with their stable exposed names
- **AND** a first invocation without a valid confirmation MUST NOT reach `client.callTool()`

#### Scenario: Unknown tool vocabulary
- **WHEN** a tool name and description match neither known read-only nor known side-effect vocabulary
- **THEN** the plugin MUST treat the tool as requiring confirmation
- **AND** it MUST NOT remove the tool from the published catalog

#### Scenario: A read-only tool is invoked
- **WHEN** a tool is classified read-only
- **THEN** the plugin MUST forward the call upstream without a confirmation round trip

### Requirement: One-time short-code confirmation gates upstream side effects
The MCP client plugin MUST bind a pending confirmation to the executing channel, MCP server, upstream tool name, and canonical argument hash. When a raw `yesimbot.message` provides a sender id, it MUST bind that id as well. It MUST accept only an exact `确认 <short code>` message from the newest user message of the current turn. Short codes MUST default to six characters and a ten-minute lifetime, MUST be consumed before the upstream call, and MUST fail closed on a wrong code, changed arguments, expiry, a different channel, a different sender when bound, a repeated use, or a process restart.

#### Scenario: A side-effect call is attempted without confirmation
- **WHEN** a side-effect tool is invoked and the current turn has no matching confirmation
- **THEN** the plugin MUST return an MCP text content array beginning with `confirmation_required`
- **AND** it MUST include the short code, the parameter fingerprint, and the validity window
- **AND** it MUST NOT call `client.callTool()`

#### Scenario: The user confirms the pending action
- **WHEN** the newest user message in the current turn is exactly `确认 <short code>` for a live pending confirmation with unchanged arguments
- **THEN** the plugin MUST consume that pending confirmation
- **AND** it MUST perform exactly one upstream `client.callTool()` for that pending confirmation

#### Scenario: A confirmation no longer matches
- **WHEN** the short code is wrong, was already used, has expired, belongs to another channel or tool, or the arguments changed
- **THEN** the plugin MUST block the call and MUST NOT reach `client.callTool()`
- **AND** the user MUST confirm the action again with the current short code

#### Scenario: Changed arguments replace the pending action
- **WHEN** the same channel, server, and tool are invoked with different arguments before confirmation
- **THEN** the previous pending action and short code MUST be replaced
- **AND** the previous short code MUST NOT authorize the earlier arguments

#### Scenario: A different sender attempts confirmation
- **WHEN** a raw `yesimbot.message` provides a sender id that differs from the pending action's sender id
- **THEN** the plugin MUST block the call and MUST NOT reach `client.callTool()`

#### Scenario: Pending state does not survive a restart
- **WHEN** the plugin stops, or a runtime rebuild drops in-process state
- **THEN** previously issued short codes MUST NOT authorize any later call

#### Scenario: Tool arguments cannot be bound
- **WHEN** call arguments cannot be canonicalized into a stable hash
- **THEN** the plugin MUST refuse the call with a bounded non-confirmable result
- **AND** it MUST NOT call `client.callTool()`

### Requirement: Trusted confirmation carriers are diagnosable without weakening authorization
The MCP client plugin MUST keep the newest current-turn confirmation carrier aligned with the actor used for binding. It MUST distinguish raw `yesimbot.message` carriers from normalized `role:user` messages, preserve platform message ids only for raw carriers, and MUST NOT borrow an actor from an older carrier when the newest carrier has no trusted identity. If a matching pending confirmation is already bound to a concrete actor but the newest carrier has no trusted actor, the plugin MUST fail closed without creating a parallel actorless pending code. Bounded debug diagnostics MAY expose carrier type, platform/Agent message ids, actor ids, truncated argument/binding hashes, and match state, but MUST NOT expose confirmation codes, message text, or full arguments.

#### Scenario: Multiple current-turn carriers
- **WHEN** the current turn contains multiple raw `yesimbot.message` carriers
- **THEN** the plugin MUST preserve their order for diagnostics
- **AND** authorization MUST use only the newest carrier
- **AND** the actor binding MUST come from that same newest carrier

#### Scenario: Normalized confirmation loses the trusted actor
- **WHEN** a matching pending confirmation is bound to a concrete actor
- **AND** the newest current-turn confirmation is a normalized `role:user` message without a trusted actor
- **THEN** the plugin MUST return a bounded `confirmation_unavailable` result with reason `trusted-actor-unavailable`
- **AND** it MUST NOT create a new actorless pending code
- **AND** it MUST NOT call `client.callTool()`

#### Scenario: Confirmation diagnostics
- **WHEN** the confirmation gate records a binding, block, or consume decision
- **THEN** the debug record MUST identify the carrier and binding metadata without logging the confirmation code, message text, or full arguments

### Requirement: Confirmation blocks stay compatible with the artifact wrapper
Blocked and allowed tool results MUST keep the MCP content-array shape so the existing artifact conversion still renders them as model text. The plugin MUST NOT replace a confirmation block with a plain object, and it MUST keep the remote tool description and the single Runtime guidance injection behavior unchanged.

#### Scenario: A side-effect call is blocked
- **WHEN** the wrapper returns `confirmation_required` to a Runtime that wraps MCP tools with artifact conversion
- **THEN** the converted model text MUST still contain the short code
- **AND** the confirmed execution MUST keep returning the upstream MCP content array

#### Scenario: Runtime guidance is published
- **WHEN** a Runtime receives MCP tools
- **THEN** the artifact guidance MUST appear once
- **AND** the confirmation guidance MUST be added as part of that same single injection
- **AND** each remote tool description MUST retain its server-provided text
