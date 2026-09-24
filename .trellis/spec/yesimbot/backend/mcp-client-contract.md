# MCP Client Confirmation and Secret Contract

## 1. Scope / Trigger

This contract applies when `koishi-plugin-yesimbot-mcp-client` connects to a remote MCP server, reads a Bearer credential, exposes a dynamic tool catalog, or gates a side-effecting tool call.

It is required because the flow crosses the transport, AgentTool, raw YesImBot message, runtime lifecycle, and production configuration boundaries. The security boundary is the plugin's call to `client.callTool()`: a side-effect call must be rejected before that call unless the current-turn confirmation matches.

## 2. Signatures

> **Koishi configuration gotcha:** within `plugins.group`, a key beginning with `~` is skipped by the loader. A production-enabled MCP entry must therefore use `yesimbot-mcp-client:<suffix>` without the leading `~`; the plugin schema uses `type: "http"` for the SDK Streamable HTTP transport (not `streamablehttp`).

```ts
connectMcpServer(
  ctx: Context,
  name: string,
  server: McpServer,
): Promise<{ client: Client; transport: McpClientTransport }>

readBearerTokenFile(path: string): Promise<string>

ConfirmationStore.register(input: ConfirmationRegistration): PendingConfirmation
ConfirmationStore.consume(key: string): PendingConfirmation | undefined

AgentTool.execute(input: unknown, options: AgentToolExecuteContext): Promise<unknown>
```

`AgentToolExecuteContext.messages` is the current-turn raw `AgentMessage[]`; it is not guaranteed to contain only AI SDK `role: "user"` messages.

## 3. Contracts

### Transport and configuration

- `http` uses `StreamableHTTPClientTransport`; `sse` uses `SSEClientTransport`.
- `bearerTokenFile` is optional for remote servers and is mutually exclusive with an explicit `Authorization` header.
- The token file must be a regular file, owned by the running process, unreadable by group/other, non-empty, and contain one token line. The token value may appear only in the outgoing request header, never in task artifacts or logs.
- Connection diagnostics may report protocol, server name, and field names. Header/env values, explicit credentials, and upstream error echoes must be redacted.
- Deployment inspection must never print the full `koishi.yml` or unrestricted container logs: parse and report only the bounded MCP subtree, status fields, hashes, and redacted log categories. Existing Koishi configuration may contain unrelated provider keys, passwords, or webhook tokens.

### Tool and result boundaries

- Every tool returned by `listTools()` remains registered as `<server>-<tool>` after safe-name normalization; no static allowlist removes catalog entries.
- A tool is read-only only when its name/description contains an explicit read-only action vocabulary and no side-effect or ambiguous action signal. Unknown and ambiguous vocabulary is side-effecting (fail-closed).
- A blocked result is `Array<{ type: "text"; text: string }>` beginning with `confirmation_required`; it must remain an MCP content array so the existing artifact wrapper does not erase the confirmation code.
- A confirmed call consumes the pending entry before invoking the upstream tool. Upstream failure does not restore the entry.

### Confirmation state and messages

- A pending entry is bound to channel, MCP server, upstream tool, canonical argument hash, and—when available—the sender id from the raw inbound message.
- For one channel/server/tool/sender binding, a changed argument hash replaces the old pending entry and code; it does not create an independently confirmable old order.
- Codes are six characters, expire after ten minutes, and are single-use. Catalog refresh, plugin stop, and channel-runtime snapshot disposal clear the relevant in-process store.
- Confirmation parsing accepts an exact `确认 <短码>` from the newest user message in the current turn. It must support both AI `role: "user"` content and raw `role: "custom", type: "yesimbot.message"` content (`data.elements`). Raw element text is decoded through the shared YesImBot `formatElements` helper.
- When raw `data.user.id` is present, the same sender id is required for confirmation; a different sender remains blocked. A normalized `AgentUserMessage` without trusted actor identity falls back to the channel binding.

## 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Token file missing, unreadable, non-regular, empty, multi-line, wrong owner, or group/other-readable | Refuse that server connection; report only a category; never echo content |
| Token file plus explicit `Authorization` | Refuse connection; do not choose a source silently |
| Header/env or upstream connection error contains a configured credential | Redact configured values before throwing/logging |
| Tool has side-effect vocabulary, ambiguous action vocabulary, or no proven read-only action | Return `confirmation_required`; upstream call count remains zero |
| Arguments cannot be canonicalize/hash | Return bounded `confirmation_unavailable`; upstream call count remains zero |
| Arguments change before confirmation | Replace old pending entry/code; old code cannot authorize old arguments |
| Wrong/expired/replayed code, different channel/tool/sender, or runtime/catalog lifecycle boundary | Block; do not call upstream |
| Valid exact current-turn confirmation | Consume first, then allow exactly one upstream call |
| MCP catalog refresh succeeds | Clear pending stores before publishing replacement tools |

## 5. Good / Base / Bad Cases

- **Good:** A raw `yesimbot.message` carries `确认 ABCDEF` in `data.elements`, its `data.user.id` matches the pending sender, the canonical argument hash is unchanged, and the code is live. The plugin consumes the entry and makes one `client.callTool()` call.
- **Base:** A synthetic/normalized `role: "user"` message has exact `确认 <code>` but no trusted actor id. Channel, server, tool, hash, TTL, and one-use checks still apply.
- **Bad:** A tool named `orderAction`, `couponOperation`, or an unknown tool is treated as read-only because it contains a noun; or an old code is retained after arguments/catalog/runtime change. These paths must remain blocked.

## 6. Tests Required

- `plugins/mcp-client/tests/confirmation-gate.test.ts`: read-only/side-effect/ambiguous classification; raw `yesimbot.message` parsing; sender mismatch; canonical hash stability; changed-argument replacement; exact one-use behavior; channel/runtime/catalog isolation; content-array visibility through `toModelOutput`.
- `plugins/mcp-client/tests/tools-refresh.test.ts`: successful catalog refresh publishes replacement tools and invalidates pre-refresh confirmations.
- `plugins/mcp-client/tests/token-file.test.ts`: owner-only file checks; header conflict; explicit/header/env/error redaction; transport header construction without logging values.
- Package checks: focused Vitest, `tsc --noEmit -p plugins/mcp-client/tsconfig.json`, `oxfmt --check`, `oxlint`, package `pkgroll`, `node --check dist/index.cjs`, and scoped `git diff --check`.
- Deployment checks, when a user-supplied token exists, must not print the token, call side-effect tools, send synthetic production messages, or restart NapCat.

## 7. Wrong vs Correct

### Koishi activation key

#### Wrong

```yaml
plugins:
  group:yesimbot:
    ~yesimbot-mcp-client:zldehp: {}
```

The group loader skips this key, so the MCP client never reaches `start()` or `listTools()`.

#### Correct

```yaml
plugins:
  group:yesimbot:
    yesimbot-mcp-client:zldehp:
      mcpServers:
        luckin:
          type: http
          url: https://gwmcp.lkcoffee.com/order/user/mcp
          bearerTokenFile: /koishi/data/yesimbot/secrets/luckin-mcp.token
```

## 8. Wrong vs Correct

### Wrong

```ts
// The model can invent this field, and the artifact wrapper may hide the object.
return { confirmed: true, action: input };
```

### Correct

```ts
// The plugin verifies current raw message state and bindings before this boundary.
const output = [{ type: "text", text: "confirmation_required\n确认 ABCDEF" }];
return output;
```

The confirmation code is evidence of a verified current-turn message only after channel/tool/hash/TTL/sender checks pass. Prompt instructions are UX guidance, not the authorization boundary.
