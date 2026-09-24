# Sticker Agent Tool Capability Contract

## Scenario: Disable automatic sticker collection while keeping sticker use

### 1. Scope / Trigger

This contract applies when a deployment wants the Agent to use an existing sticker library without collecting images from incoming messages. The behavior is controlled by the `yesimbot-sticker-manager` plugin configuration and must not change administrator import commands or sticker delivery.

### 2. Signatures

- Configuration: `StickerConfig.enableSteal: boolean`.
- Schema default: `StickerConfigSchema({}).enableSteal === true`.
- Agent tool factory: `createStickerTools({ ..., config })`.
- Existing administrator commands remain available, including:
  - `yesimbot.sticker.add <category> <file>`
  - `yesimbot.sticker.import <sourceDir>`
  - `yesimbot.sticker.migrate-v3`
  - `yesimbot.sticker.migrate`

### 3. Contracts

- `enableSteal: true` exposes the legacy Agent tool set, including `sticker_steal`.
- `enableSteal: false` does not expose `sticker_steal`.
- With `enableSteal: false`, the Agent still receives `sticker_send`, `sticker_categories`, and `sticker_search`; `sticker_tags` remains conditional on `tagMode`.
- With `enableSteal: false`, the Agent system prompt and category-tool description must not instruct it to collect incoming images.
- `sticker_send` continues to read existing records, send through the existing `StickerSender`, and record usage.
- The setting does not delete or migrate existing database rows/files.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| `enableSteal` omitted and schema is applied | Treat as `true` for backward compatibility |
| `enableSteal: true` | Include `sticker_steal` and its prompt guidance |
| `enableSteal: false` | Omit `sticker_steal` and collection guidance |
| `enableSteal: false`, `tagMode: false` | Expose send/categories/search only |
| `enableSteal: false`, `tagMode: true` | Expose send/categories/search/tags |
| Administrator invokes `add` or `import` while disabled | Command remains registered and usable |
| Agent invokes `sticker_send` while disabled | Existing send and usage-count behavior is unchanged |

### 5. Good / Base / Bad Cases

- **Good**: `enableSteal: false`; the Agent searches the imported library and calls `sticker_send`; no incoming asset is persisted.
- **Base**: `enableSteal: true` or an old configuration without the field; existing collection behavior remains available.
- **Bad**: Hide the tool only in the prompt while still registering `sticker_steal`; the model can still call the write-capable tool.
- **Bad**: Disable the entire plugin or wrap `sticker_send` and administrator import commands in the same switch; existing libraries become unusable.

### 6. Tests Required

- Schema test: omitted field defaults to `true`; explicit `false` remains `false`.
- Tool-factory test: `true` preserves `sticker_steal`; `false` omits it.
- Tool-factory test: disabled mode retains send/categories/search and optional tags.
- Disabled-mode test: category/search execute and `sticker_send` still sends and records usage.
- Plugin test: disabled mode removes collection prompt text while retaining administrator `add`/`import`/migration command registration.

### 7. Wrong vs Correct

#### Wrong

```ts
// Prompt-only hiding: the write-capable tool is still available to the Agent.
return [stealTool, sendTool, categoriesTool, searchTool];
```

#### Correct

```ts
return [...(config.enableSteal ? [stealTool] : []), sendTool, categoriesTool, searchTool, ...(tagsTool ? [tagsTool] : [])];
```

The runtime tool set is the enforcement point; the Prompt is only kept consistent with that set.

## Scenario: Optional proactive sticker use during an external reply

### 1. Scope / Trigger

This contract applies when the Agent has decided that the current turn should produce an external reply and the sticker manager is available. It makes an existing sticker a possible social response, but it does not require a sticker on every turn and does not add an automatic Core-side send.

### 2. Signatures

- Prompt formatter: `formatStickerPrompt(config: StickerConfig): string`.
- Sticker tool factory: `createStickerTools(options: StickerToolsOptions): AgentTool[]`.
- `sticker_send` input fields are optional: `sticker_id?: string`, `category?: string`, `index?: number`, and, when `tagMode` is enabled, `tags?: string[]`.
- `send_message` accepts `continue?: boolean`; `continue: true` sends the text and keeps the Agent loop running, while the default/false value is terminal.
- `sticker_send` remains `terminal: true` and sends through `StickerSender.send()`.

### 3. Contracts

- The sticker prompt MUST tell the Agent that, when preparing an external reply, it may autonomously or randomly decide whether to send one existing sticker. It MUST also say that skipping the sticker is valid and that the Agent must not call the tool merely to satisfy a rule.
- `sticker_send` MUST preserve its no-filter behavior: when `sticker_id`, `category`, `index`, and `tags` are all absent, it selects an existing sticker through `store.random()`.
- If a turn needs both visible text and a sticker, the Agent MUST first call `send_message` with `continue: true`, then call terminal `sticker_send`. The sticker tool call ends the turn.
- If a turn needs only text, the Agent uses the existing terminal `send_message` behavior. If it needs only a sticker, it may call `sticker_send` directly.
- Omitting `sticker_send` is always allowed when the Agent chooses not to add a sticker. Prompt and tool descriptions are guidance; they do not guarantee a fixed sticker frequency.
- `enableSteal: false` only removes `sticker_steal`; it MUST NOT remove or disable proactive use of already stored stickers through `sticker_send`.
- No scheduler, runtime hook, Messenger callback, or other Core automatic side effect may be added to force sticker delivery. Platform delivery remains owned by the terminal `sticker_send` tool.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Agent is preparing an external reply | Prompt/tool guidance exposes sticker use as optional, not mandatory |
| Agent chooses not to send a sticker | No `sticker_send` call is required; normal text delivery remains valid |
| All sticker selectors omitted | Select an existing sticker randomly; return the existing `sticker_not_found` if the library is empty |
| Text and sticker are both selected | `send_message({ ..., continue: true })` precedes terminal `sticker_send` |
| Sticker only | Direct terminal `sticker_send` is valid |
| Text only | Existing terminal `send_message` behavior is unchanged |
| `enableSteal: false` | Keep `sticker_send`, categories, search, and optional tags; omit only `sticker_steal` |
| Sticker send fails | Preserve the existing `{ok:false,error}` result and do not mark usage as sent |

### 5. Good / Base / Bad Cases

- **Good**: The Agent decides that a light reaction fits, calls `send_message` with `continue: true` for the text, then calls `sticker_send` without selectors; the existing sender delivers a random stored sticker and the terminal invariant is satisfied.
- **Base**: The Agent replies with text only and ends through `send_message`, or sends only a sticker through `sticker_send`; no extra automatic action occurs.
- **Bad**: A runtime scheduler or Messenger hook sends a sticker after every reply, because that removes the model's choice and bypasses the terminal tool contract.
- **Bad**: The Agent calls terminal `sticker_send` first and then attempts `send_message`, because the terminal call ends the turn and the text may never be delivered.
- **Bad**: Treating the prompt as a guarantee that every turn will contain a sticker, or disabling `sticker_send` together with `enableSteal`, because both change the agreed optional-use semantics.

### 6. Tests Required

- Plugin prompt test asserts optional choice, valid omission, random/no-selector guidance, and the `send_message(continue=true)` → `sticker_send` order.
- Tool-factory test asserts `sticker_send.description` contains optional-use and random-selection guidance, `terminal === true`, and the same continuation order.
- Existing tool tests continue to assert no-selector random selection, sender invocation before `markUsed`, failure behavior, and `enableSteal: false` retaining the send tool.
- A protocol-level regression test should model the two valid sequences (text-only and text-plus-sticker) and reject sticker-first/text-after-terminal ordering if the Agent loop is changed.
- Run the Sticker manager focused tests, TypeScript check, lint, format, and package build; static checks do not claim that a model will select a sticker on every live turn.

### 7. Wrong vs Correct

#### Wrong

```ts
// Do not add an unconditional platform side effect after every text reply.
await bot.sendMessage(channelId, text);
await stickerSender.send(randomSticker);
```

This forces a sticker, bypasses the Agent's terminal-tool decision, and changes behavior for turns that should remain text-only.

#### Correct

```ts
// The Agent chooses; text must remain non-terminal when a sticker follows.
await callTool("send_message", { messages: [text], continue: true });
await callTool("sticker_send", {}); // terminal; no selectors means random existing sticker
```

The existing tool executor owns delivery and usage accounting; the Agent may omit the second call when a sticker is not appropriate.

## Scenario: Sticker delivery under the explicit Core terminal protocol

### 1. Scope / Trigger

This contract applies when Core requires every Agent turn to end with a terminal tool (`requireTerminalTool: true`) while the sticker manager still sends through its plugin-owned `StickerSender`.

### 2. Signatures

- `sticker_send: AgentTool<SendStickerInput, ToolResult>` MUST declare `terminal: true`.
- `StickerSender.send(input: { bytes: Uint8Array; mediaType: string }): Promise<void>` remains the plugin-to-platform delivery seam.
- `projectStickerElements()` and `projectStickerHistoryElements()` remain projection hooks; they are not delivery APIs.

### 3. Contracts

- A platform Sticker response MUST use the `sticker_send` tool. Its tool call performs `StickerSender.send()` and is eligible to terminate the Core turn.
- Plain assistant text containing `<sticker .../>` MUST NOT be treated as platform delivery. Sticker element projection may convert it to an artifact-backed image for persistence/history only.
- `sticker_search` MUST direct the Agent to call `sticker_send`; it MUST NOT advertise direct `<sticker/>` output as an alternative delivery path.
- The `stickerElement` configuration controls projection compatibility, not whether plain text can bypass the Core delivery protocol.
- `sticker_send` MUST preserve the existing order: read the selected Sticker, call `sender.send()`, then call `store.markUsed()`.
- The plugin-side sender does not automatically emit Core `send_message` delivery notices; adding such a callback requires a separate cross-layer contract.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| `sticker_send` is registered | Tool has `terminal === true` |
| Agent returns plain `<sticker/>` text | No `StickerSender.send()` call; Core may report a text-only protocol violation |
| Agent calls `sticker_send` and a Sticker exists | `StickerSender.send()` is called and the tool call satisfies the terminal invariant |
| No Sticker matches the request | Return the existing `sticker_not_found` / index error; do not call sender or mark usage |
| `StickerSender.send()` fails | Preserve the existing `{ok:false,error}` result contract; do not mark usage |

### 5. Good / Base / Bad Cases

- **Good**: The prompt says “发送表情包必须调用 `sticker_send`”; the Agent calls it; the existing sender sends the bytes; the turn can finish without a second `finish` call.
- **Base**: `stickerElement` remains enabled for history projection, but no prompt or search result describes it as a platform-send shortcut.
- **Bad**: Keep direct `<sticker/>` output in the prompt after Core has switched to explicit terminal tools; this creates a successful-looking history projection with no platform message.
- **Bad**: Execute `sticker_send` as a side effect but omit `terminal: true`; the send may happen, yet the Agent turn can still fail as `non-terminal-tool`.

### 6. Tests Required

- Tool factory test asserts `sticker_send.terminal === true`.
- Disabled-collection test asserts `sticker_send` still calls `sender.send()` and `markUsed()` and that `sticker_search` does not advertise `<sticker/>` delivery.
- Plugin prompt test asserts the prompt requires `sticker_send` and excludes the old direct-output wording.
- Existing Sticker element tests continue to cover projection and history round-trip without asserting platform delivery.

### 7. Wrong vs Correct

#### Wrong

```ts
const sendTool: AgentTool<SendStickerInput, ToolResult> = {
  name: "sticker_send",
  execute: sendSticker,
};

// The prompt still says direct <sticker/> output sends a platform message.
```

#### Correct

```ts
const sendTool: AgentTool<SendStickerInput, ToolResult> = {
  name: "sticker_send",
  terminal: true,
  execute: sendSticker,
};

// Prompt: platform delivery must call sticker_send;
// <sticker/> is projection/history syntax only.
```

## Scenario: Optional sticker use with a hard per-turn send limit

### 1. Scope / Trigger

This contract applies when a Sticker manager AgentPlugin offers `sticker_send` as an optional response action and must prevent more than one actual sticker delivery during a single Agent turn. Persona-specific preferences are supplied by the active Persona/card; the generic Sticker manager prompt must remain persona-neutral and must not hardcode a character name.

### 2. Signatures

- `StickerToolsOptions.sentTurnIds: Set<string>` belongs to one AgentPlugin instance and is passed to `createStickerTools()`.
- `AgentToolExecuteContext.turnId: string` identifies the current Agent turn.
- `AgentPlugin.onTurnFinish(result, context)` receives the completed turn id and owns per-turn cleanup.
- `sticker_send` continues to call `StickerSender.send()` and then `StickerStore.markUsed()`.

### 3. Contracts

- Before selecting or reading a Sticker, `sticker_send` MUST reject a turn whose `turnId` is already in `sentTurnIds` with `{ ok: false, error: "sticker_send_limit_reached" }`.
- A rejected same-turn call MUST NOT call `StickerSender.send()` or `StickerStore.markUsed()`.
- The tool MUST add the current `turnId` to `sentTurnIds` immediately after `StickerSender.send()` resolves successfully and before calling `markUsed()`.
- If selection, reading, or `StickerSender.send()` fails, the turn MUST NOT be claimed; a later call in the same turn may retry under the existing error contract.
- If `markUsed()` fails after delivery, the tool MAY return its existing error result, but the turn MUST remain claimed and no second Sticker may be sent.
- `onTurnFinish` MUST delete the completed `turnId`; claims MUST NOT restrict a later turn or grow without bound.
- The limit is an execution invariant, not a prompt-only suggestion. `terminal: true` alone does not enforce it when multiple tool calls occur in one final provider step.
- The generic Sticker manager prompt/tool descriptions MUST stay persona-neutral and describe only the reusable tool protocol and limit. Anon-specific “likes to use stickers/images when appropriate” behavior belongs exclusively in the Anon Persona/card.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| First successful `sticker_send` in a turn | Sender is called once; turn is claimed before usage accounting |
| Second `sticker_send` with the same `turnId` | Return `sticker_send_limit_reached`; do not select, send, or mark usage |
| `sticker_send` in a different turn | Existing selection, delivery, and usage behavior remains available |
| Selection/read fails before delivery | Preserve the existing error; do not claim the turn |
| `StickerSender.send()` rejects | Preserve the existing error; do not claim the turn or mark usage |
| `markUsed()` rejects after sender success | Preserve the existing error; keep the turn claimed |
| `onTurnFinish` runs | Delete only the completed `turnId`; same id may be used by a later independent turn |
| Generic plugin prompt is assembled | It contains no role preference or hardcoded character name; active Persona remains responsible for character preference |

### 5. Good / Base / Bad Cases

- **Good**: The Agent decides a sticker fits, sends any required text with `continue: true`, calls `sticker_send` once, and the second same-turn call is rejected without another platform side effect.
- **Base**: The Agent omits `sticker_send` when a sticker is not appropriate, or sends one sticker in a later turn after the previous claim was cleaned up.
- **Bad**: Rely only on `terminal: true` or prompt wording to prevent duplicate same-step calls; both calls can still reach the executor.
- **Bad**: Claim before selection or before `sender.send()`; a failed attempt would incorrectly consume the turn.
- **Bad**: Claim only after `markUsed()`; a usage-accounting failure after a real send would permit a duplicate platform delivery.
- **Bad**: Put a role-specific sticker preference or “千早爱音” in the generic Sticker manager prompt; this couples a reusable plugin to one Persona and duplicates role-specific data in the wrong layer.

### 6. Tests Required

- Tool test: first send succeeds, same-turn second send returns the exact limit error without sender or usage calls.
- Tool test: a different `turnId` can send; selection failure and sender failure do not claim the turn.
- Tool test: sender success followed by `markUsed()` failure still blocks a second same-turn send.
- Plugin test: `onTurnFinish` removes the claim so the same id can be used by a later independent turn.
- Prompt tests: optional use, omission, one-per-turn limit, text-before-sticker order, and absence of hardcoded character names.
- Run focused Sticker manager tests, TypeScript check, lint, format, and package build.

### 7. Wrong vs Correct

#### Wrong

```ts
// terminal=true is not a per-turn quota.
const sent = await sender.send(sticker);
await store.markUsed(scopeKey, sticker.id);
```

#### Correct

```ts
if (sentTurnIds.has(execution.turnId)) {
  return { ok: false, error: "sticker_send_limit_reached" };
}

await sender.send(sticker);
sentTurnIds.add(execution.turnId);
await store.markUsed(scopeKey, sticker.id);
```

The execution guard owns the hard limit; the Persona owns role-specific preference, and the generic plugin prompt only explains the reusable protocol.
