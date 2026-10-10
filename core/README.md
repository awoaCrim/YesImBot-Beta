# koishi-plugin-yesimbot

`koishi-plugin-yesimbot` composes the Koishi facade, model registry, live Session
Messenger, channel resources, and the per-channel runtime.

## Public API

`ctx.yesimbot` exposes these domain entries:

- `model`
- `messenger.use()` / `messenger.post()`
- `agent.use()` / `agent.will()`
- `resource.get()` / `resource.use()`

It also exposes the lifecycle `stop()` inherited from the Koishi service.

The official `message-polisher` plugin and public `polisher.use()` / `polisher.profile()`
API have been removed, including delegated preparation and rewrite/compose callbacks.
Before deploying this source to an existing Koishi instance, remove its enabled
message-polisher configuration and any third-party polisher integration. This source
change does not edit production configuration or deploy automatically.

Named channel plugins implement `setup(scope, bot)` and return an AgentPlugin
snapshot (or `null`). Will plugins implement `match(session)` and
`setup(scope)`, and are selected only while the live Session is available.
Resource readers implement `init(resources, uri, options)`; these are the only
initialization seams exposed to plugin implementations.

`ChannelScope` is the public current-channel context:

```ts
type ChannelScope = { type: "shared"; platform: string; channelId: string } | { type: "direct"; platform: string; selfId: string; channelId: string };
```

Core derives shared `[platform, channelId]` and direct
`[platform, selfId, channelId]` tuples only inside its storage and runtime
implementations. It does not expose a channel identity, tuple key, directory
helper, storage implementation, runtime owner, concrete stores, or delivery
adapter.

The package root exports `Config`, `ChannelScope`, message/event records,
`Translator`, resource contracts, Agent/WillPlugin/WillEngine contracts, model
contracts, and `YesImBotService`. Channel and runtime owners, concrete stores,
and delivery adapters remain private.

## Messenger and runtime

Messenger is the sole live Session ingress. It performs allowlist and shared
assignee admission, resolves one stable ChannelResources owner, invokes one
platform Translator or the built-in pass-through translator, and routes the
resulting Session-free record to the private Runtimes owner. Passive output uses
the originating `Session.send()`; active output uses the matching Bot through
`messenger.post()`.

Translator owns platform-specific image and file persistence while the Session
is live. Messenger owns passive `Session.send()` and active `Bot.sendMessage()`
delivery. A failed delivery calls the producing runtime's explicit `fail()` and
creates one same-channel `delivery.failed` event; it never re-enters `post()`.

Runtimes keeps one private `ChannelRuntime` per persistent tuple: shared
`[platform, channelId]`, direct `[platform, selfId, channelId]`. Shared Bot
changes stop and replace the transient runtime while preserving Channel,
Conversation, resources, and plugin-owned files. There is no public reset,
reload, RuntimeManager, or ChannelRuntime API.

Each ChannelRuntime owns its immutable scope, FIFO, Agent, Will snapshot,
Conversation storage, prompt, model input, output queue, and delivery feedback.
It holds no live Koishi Session. Model, prompt, tools, and AgentPlugin resources
are snapshots for the runtime lifetime and take effect on replacement.

## Model input

Core reads explicit `asset://`, `artifact://`, and registered resource URIs
through `ResourceReader.init()`. When a model supports image input and
`imageInput: true`, images explicitly read with `read` are projected into the
current model call; history is never re-requested from a platform API. Set
`imageInput: false` to disable projection.

## Prompt composition

Core composes its stable system prompt in Chinese from `src/runtimes/prompt.ts`:
runtime contract, one continuous role section, interaction policy, then
capability/evidence/security boundaries. Optional `AGENTS.md` operator policy and
`<runtime_context>` remain separate blocks. Enabled plugins append their own
capability rules; history and dynamic reference data remain in the message pipeline.

A custom nonempty `PERSONA.md` is the primary role document. An opted-in character
provider supplies card material to the same Core role section, rather than adding
a second per-step character prefix. Card-only setups do not also receive default
Athena. Missing/empty Persona without a card uses the inline default; a legacy
file exactly matching that default is treated as fallback when a card is present.
Existing files are never rewritten. New Persona files are created as empty editable
templates, keeping the default in memory. Multiple nonempty role providers for one
channel are rejected rather than silently combined.

`customInnerThought` (default `false`) exposes an optional `send_message.inner_thought`
field for a concise internal judgment. It is not an externally visible monologue
or a required output tag. Its detailed contract lives in the tool definition;
provider-native reasoning and existing history remain unchanged. Message splitting,
`continue`, element syntax and escaping also belong to `send_message`, not Persona.

Prompts are frozen for each runtime, not reloaded from disk every turn. See
[main-Agent prompt ownership](../docs/prompt-architecture.md) for precedence,
plugin-managed role sections and an opt-in Anon reference draft.

## Output and delivery

Model text output is never delivered. It is recorded in history and logged as the
model's internal working space, which removes the whole class of `保持沉默` /
`无需回复` literals reaching a channel.

The main model submits a complete ordered reply through `send_message.parts`.
Core owns preflight, pacing and FIFO delivery; there is no second expression model.
Plugin-owned sending tools may still deliver their own supported content:

- Each text part is one meaningful communication unit; sticker parts use an exact
  ID viewed in an earlier completed step. Text-only, sticker-only and either mixed
  order are supported. Splitting is explicit, not inferred from punctuation or blank lines.
- `channel` defaults to the current channel. Text-only replies may target another
  channel; replies containing a sticker stay in the current channel.
- `mode` selects `element` (default, Koishi element parsing plus resource URI
  resolution) or `raw` (literal text, no parsing or escaping).
- `continue` (default `false`) decides whether the turn ends. A preliminary
  acknowledgement can use `true` before further tool work; splitting a single
  reply into parts does not require continuation.
- Core checks the whole phase before sending. Failure stops later output without
  resending its prefix. Real platform IDs and `replyReceipt` describe actual effects;
  only journal-proven complete units become historical speech, including after SDK cancellation.

The ordinary legacy text-array sender remains available to direct callers, but is
not the main runtime's parts bypass. Old actual-body receipts remain readable;
new sends do not invoke polishing or generate `deliveredMessages` through it.
See [reply delivery details](../docs/prompt-architecture.md#unified-reply-authorship).

`finish` ends a turn without sending anything. Because delivery requires an
explicit tool call, plain model text is not a delivered reply. Core requires a
terminal tool to finish a turn; the runtime may repair a missing terminal call.

Silent scheduled posts (`delivery: "silent"`) block `send_message` for that
turn, so a background task cannot leak its working notes into the channel.

## Storage and records

Each channel root is named `shared-<platform>-<channelId>` or
`direct-<platform>-<channelId>-<selfId>` with safely encoded segments. Its
`channel.json` Manifest is authoritative. `sessions/messages.jsonl`, `assets/`,
and plugin-selected child directories live below that root. Trusted plugins
obtain the root through `resource.get(scope)` and select their own child paths.

Records and Manifests are versionless. JSONL read-back parses each line with
`JSON.parse`, skips lines with invalid JSON syntax after logging a warning, and
returns all successfully parsed values without Core schema validation. Core does
not read, migrate, or provide compatibility aliases for prior layouts or
records.

## Configuration

`allowedChannels` is a deny-by-default Messenger boundary. Rules are ORed;
fields within one rule are ANDed. `platform` and `channelId` accept an exact
string or `*`. Omit `isDirect` to match both direct and shared channels.

```yaml
allowedChannels:
  - platform: onebot
    channelId: "123456"
  - platform: discord
    channelId: "dm-123"
    isDirect: true
```

Declare model image capability in the model override in `models.json`. When
`imageInput: true`, the runtime projects only images explicitly read by the
model through `read`. Set `imageInput: false` to disable model image input.
This setting does not impose a download policy on Translators.
