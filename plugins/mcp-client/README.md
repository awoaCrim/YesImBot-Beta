# koishi-plugin-yesimbot-mcp-client

Expose tools from configured MCP servers to Athena channel runtimes.

## Tool Registry

On startup, the plugin connects to each configured MCP server, calls `listTools()`, converts the returned MCP tools to `AgentTool` definitions, and publishes them through `AgentPlugin.tools`.

Tool names are prefixed with the server name:

```text
<server>-<tool>
```

For example, a server named `docs` exposing `search` becomes `docs-search`.

Exposed names are restricted to `[A-Za-z0-9_-]`; unsafe characters become `_`, empty names fall back to `mcp`, and sanitized collisions receive numeric suffixes.

The published tool list is sorted by final tool name so model-call tool order remains stable across turns and future runtime creation.

## Tool List Changes

The plugin listens for MCP `notifications/tools/list_changed`. When a connected server reports a catalog change, the plugin:

1. Calls `listTools()` again for that server.
2. Rebuilds that server's cached `AgentTool` definitions.
3. Disposes the previous agent plugin factory.
4. Registers a replacement factory with the refreshed stable tool list.

This refresh affects channel runtimes created after the replacement factory is registered. Existing channel runtimes retain their previous tool snapshot. All pending confirmations are cleared on refresh, so a pre-refresh short code cannot authorize a post-refresh call.

## Remote Authentication

For `http` and `sse` servers, a Bearer token can be read from an owner-only file instead of being stored inline in Koishi configuration.

```yaml
mcpServers:
  luckin:
    type: http
    url: https://gwmcp.lkcoffee.com/order/user/mcp
    bearerTokenFile: /koishi/data/yesimbot/secrets/luckin-mcp.token
```

The file must contain a single token line, be owned by the running process, and stay unreadable by group and other users.

The following cases fail closed, skip that server, and report only the failure category:

- the file is missing, unreadable, empty, or holds more than one token line;
- file permissions are not owner-only, or the file is not a regular file;
- `bearerTokenFile` and an explicit `Authorization` header are configured for the same server.

Servers that keep using explicit `headers` without `bearerTokenFile` behave exactly as before.

## Side-Effect Confirmation

Every tool returned by `listTools()` is registered; the catalog is never reduced by a static allowlist. Each tool is classified from its upstream name and description.

- explicit read-only action vocabulary (`list`, `search`, `query`, `get`, `detail`, `查询`, `列表`, ...) is forwarded immediately;
- side-effect vocabulary (`create`, `cancel`, `pay`, `submit`, `delete`, `下单`, `支付`, `取消`, ...) requires confirmation;
- anything unknown is treated as a side effect, so a new upstream tool cannot execute unconfirmed.

A tool that requires confirmation returns an MCP text content array starting with `confirmation_required`, including a reason, parameter fingerprint, and one-time code.

```text
确认 ABCDEF
```

The pending confirmation is bound to the channel, the MCP server, the upstream tool, and a canonical hash of the call arguments; when a raw inbound message provides a sender id, that id is bound too. It expires after ten minutes and is consumed before the upstream call. If a later call has lost that trusted sender carrier, the gate returns `trusted-actor-unavailable` instead of creating a parallel actorless code.

For diagnosis, the gate emits bounded `mcp.confirmation.binding`, `mcp.confirmation.blocked`, and `mcp.confirmation.consume` debug records. They include carrier type, platform/Agent message IDs, actor binding, truncated argument/binding hashes, and match state, but never confirmation codes, message text, or full arguments.

The model-facing guidance asks the Agent to summarize the action and never to claim an order, payment, or cancellation before confirmation.

Read-only tools and the existing media artifact conversion are unchanged. Blocked results keep the MCP content-array shape so the artifact wrapper preserves the confirmation text.
