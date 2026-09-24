# Agent Message Protocol and Delivery State Contract

## 1. Scope / Trigger

Use this contract when changing the YesImBot Agent loop, model tool-choice wiring, terminal tool semantics, plain assistant text handling, or the boundary between a tool result and a real platform delivery.

The invariant is: **model-authored platform messages go through `send_message`; every Core turn ends through a terminal tool or fails as a protocol violation; plain assistant text is never delivery evidence.**

This contract does not authorize changes to Persona/card, Will admission/scoring, OneBot/NapCat transport, durable JSONL migration, or production deployment without separate approval.

## 2. Signatures

```ts
export interface AgentConfig {
  // Existing fields omitted.
  toolChoice?: "required";
  requireTerminalTool?: boolean;
}

export type AgentProtocolViolation = "text-only" | "non-terminal-tool" | "empty-or-no-terminal-tool";

export class AgentProtocolError extends AgentRuntimeError {
  readonly violation: AgentProtocolViolation;
}

export function resolveToolChoice(chat: Pick<ChatModelRef, "entry" | "tools">): "required" | undefined;
```

`AgentTool.terminal` remains `boolean | ((input: unknown) => boolean)`. A predicate is evaluated against the validated model input; invalid calls never qualify.

`send_message` remains the only Core tool that invokes `bot.sendMessage()`. Its `onDelivered` callback is the delivery observation boundary.

## 3. Contracts

### Capability gate

- Pass `toolChoice: "required"` only when the resolved model configuration explicitly has `entry.toolCall === true` and the effective provider tool set is empty.
- `false`, `undefined`, unknown capability, or mixed provider-defined/function tools must not force tool choice.
- The gate must not infer capability from a provider name. A compatible fallback still sets `requireTerminalTool: true` in Core.
- `toolChoice: "required"` means the provider must request some available tool. It is not proof of a terminal action or platform delivery.

### Agent terminal invariant

- `terminal: true` and a predicate returning `true` are terminal actions. `send_message({ continue: true })` is not terminal.
- The terminal matcher used by the stop condition and final validation must have the same semantics.
- Track valid terminal calls across all steps in one Agent turn. Intermediate tools continue the loop; provider-defined tools without Core terminal metadata do not satisfy the invariant.
- When `requireTerminalTool` is enabled and the loop ends without a valid terminal call, throw `AgentProtocolError` before emitting `turn.done`:
  - non-empty assistant text → `text-only`;
  - only valid intermediate tools → `non-terminal-tool`;
  - no text and no valid tool completion → `empty-or-no-terminal-tool`.
- Persist the existing `turn.failed` event/result and do not automatically retry protocol violations. Diagnostic assistant text may remain in durable history, but it is inert and not an external response.

### Delivery state

- A terminal tool call and a platform delivery are separate facts.
- Only a non-empty message ID observed by the current channel's `send_message.onDelivered` callback can commit delivery or a Will reply-cost reservation.
- Plain text, `tool.done` with `ok: true`, an empty ID list, `turn.done`, or a cross-channel callback cannot commit delivery.
- Preserve the existing `TurnDeliveryTracker`, reservation settlement, partial-send commit, and delivery-wins-over-later-failure behavior. Do not create a second delivery state machine.

### Finish and history

- `finish` is an argument-free terminal tool. Its executor does not consume a `reason`; new schema must not require one.
- Prompt text must state that external output goes through `send_message`; historical delivered output is supplied separately as typed read-only transcript context, not as ordinary assistant text.
- Existing successful/partial send projection uses `yesimbot.delivered-transcript` custom messages converted to one read-only `role: assistant` historical context message. Legacy marker text already present in persisted history may be converted only at the read projection boundary; durable JSONL and current-turn entries remain unchanged. The projected content contains no executable tool call/result and is never converted to `role: user`.

## 4. Validation & Error Matrix

| Condition                                                                   | Required behavior                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `entry.toolCall === true`, no provider-defined tools                        | Pass `toolChoice: "required"`; still require a terminal tool in Core                              |
| Capability false/undefined/unknown                                          | Omit forced choice; retain terminal invariant                                                     |
| Provider-defined tools mixed with Core function tools                       | Omit forced choice unless a separately verified provider contract is added                        |
| Valid terminal tool call                                                    | Stop/finish normally according to existing `stopWhen` semantics                                   |
| `send_message({ continue: true })`                                          | Execute delivery, continue the loop, do not count as terminal                                     |
| Plain text, empty output, or intermediate-only output without terminal tool | Emit `turn.failed` with `AgentProtocolError`; no `turn.done`; no automatic retry; no Bot delivery |
| Invalid/malformed terminal call                                             | Do not execute or count it as terminal                                                            |
| `send_message` tool receipt with zero IDs                                   | Do not treat as delivery; release any pending reservation at terminal cleanup                     |
| Current-channel `onDelivered` with non-empty ID                             | Record delivery and settle reservation using the existing tracker                                 |
| Legacy complete marker in persisted assistant text                          | Remove only the outer tags at read projection; preserve inert body and input immutability         |
| Lone, nested, or incomplete marker                                          | Preserve the original text; fail closed                                                           |

## 5. Good / Base / Bad Cases

### Good

- A declared function-calling model receives `toolChoice: "required"`, calls `read`, then calls `send_message`; the turn ends normally and a current-channel non-empty delivery callback records the actual message ID.
- A model returns plain text. Core records bounded diagnostics, emits `turn.failed` with `text-only`, calls `bot.sendMessage()` zero times, and does not retry.
- A historical assistant entry contains a complete legacy delivered marker. The model-history projection exposes the body as inert text, the original entry and durable JSONL remain unchanged, and a second projection is identical.

### Base

- An unknown-capability model is not forced by the provider, but Core still rejects a text-only successful turn through the terminal invariant.
- `finish` is called with an empty object and ends silently. Old persisted `finish.reason` fields are removed by historical input sanitization.

### Bad

```ts
if (toolResult.ok || assistantText) {
  markDelivered();
}
```

This confuses tool completion or internal text with platform delivery and can commit a reply reservation without a message ID.

## 6. Tests Required

- Agent runtime test that captures the actual provider `toolChoice` and distinguishes required from default auto behavior.
- Agent runtime tests for text-only, empty-only, intermediate-only, invalid terminal calls, cross-step terminal calls, `continue: true`, no `turn.done`, stable error category, and no automatic retry.
- Core runtime tests for capability gating, `requireTerminalTool` wiring, plain-text zero Bot calls, finish schema, current-channel/non-empty delivery evidence, zero-ID/partial delivery, and reservation release/commit.
- Prompt tests for tool-only delivery and marker prohibition, including argument-free `finish` wording.
- History projection tests for successful/partial/zero delivery, legacy marker unwrap, malformed marker preservation, idempotence, identity/non-mutation, and durable JSONL non-mutation.
- Exact-version provider request probe with fake fetch; for Google `ai@6.0.259` / `@ai-sdk/google@3.0.110`, required choice must serialize to Gemini `functionCallingConfig.mode: "ANY"` and parse a function call.
- Run affected package tests, TypeScript checks, format, lint, and build. Report unrelated pre-existing failures separately; do not claim live platform delivery from a tool receipt or static test.

## 7. Wrong vs Correct

### Wrong

- Enable forced tool choice for every Google/Anthropic/OpenAI model solely from the provider name.
- Treat a plain assistant response, `tool.done.ok`, or `turn.done` as a successful reply.
- Convert plain text to `send_message` automatically.
- Remove or rewrite durable JSONL to hide legacy markers.
- Replace the existing delivery tracker with a second reservation state machine.

### Correct

```ts
const toolChoice = chat.entry.toolCall === true && Object.keys(chat.tools ?? {}).length === 0 ? "required" : undefined;

createAgent({
  model: chat.model,
  ...(toolChoice ? { toolChoice } : {}),
  requireTerminalTool: true,
});

onDelivered(({ channelId, messageId }) => {
  if (channelId === currentChannel && messageId) {
    deliveryTracker.record(messageId);
  }
});
```

The provider hint improves compliance when supported, while the runtime terminal invariant and callback-level delivery evidence remain authoritative.
