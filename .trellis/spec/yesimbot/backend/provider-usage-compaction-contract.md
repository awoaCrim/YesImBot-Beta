# Provider-Reported Prompt Compaction Contract

## 1. Scope / Trigger

This contract governs Core `ChannelRuntime` automatic conversation compaction after a completed model request. It applies when changing `turn.step` usage handling, compaction scheduling, or the legacy session-compaction settings. The provider-reported input-token count—not request serialization size, user-turn count, or elapsed time—is the automatic trigger.

## 2. Signatures

- Agent Runtime emits `TurnStepEvent`: `{ type: "turn.step", turnId: string, step: number, usage?: Partial<LanguageModelUsage> }`.
- Core reads `event.usage?.inputTokens` and uses the fixed `PROMPT_LIMIT_INPUT_TOKENS = 100_000`.
- Automatic compaction calls `Conversation.compact("prompt-limit", { model, signal, force: true })` through `ChannelRuntime`'s single-flight compaction task.
- `checkIntervalMinutes`, `turnThreshold`, and `responseIdleMinutes` remain accepted only for old-config compatibility; none schedules compaction.

## 3. Contracts

1. Evaluate each completed `turn.step` independently, including tool-continuation steps.
2. Register a pending trigger only for a finite numeric input-token count strictly greater than `100_000`. Missing, non-finite, negative, and exactly `100_000` values do not trigger.
3. Do not compact in an active Agent turn. Wait for `agent.wait()`, then execute at a Core FIFO boundary and confirm the Agent is idle. Do not put the idle wait inside the Core FIFO task.
4. Use reason `prompt-limit` and `force: true`; `force` bypasses only `minMessages`, not existing compact failure limits or cancellation.
5. `compactionTask` remains single-flight. A successful compact already in flight covers pending prompt usage. If an existing compact returns busy, does not compact, or rejects, retain the pending trigger and retry the forced prompt-limit attempt after idle. Clear a pending trigger after a successful compaction, an automatic attempt, or runtime stop.
6. Keep logs bounded to metadata such as turn ID, step, input token count, fixed threshold, reason, and error name. Never log message bodies, images, or serialized provider requests for this policy.
7. No automatic trigger may depend on user-turn counts or periodic timers. The old config fields must remain inert; do not reintroduce a request-size/base64 estimate or pre-request hard gate.

## 4. Validation & Error Matrix

| Condition                                                               | Required behavior                                               |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| `inputTokens` absent, invalid, negative, or `<= 100_000`                | Do not register a trigger or compact                            |
| `inputTokens > 100_000`, Agent active                                   | Retain pending trigger; finish the turn/tool continuation first |
| Agent idle at FIFO boundary                                             | Start one forced `prompt-limit` compact                         |
| Existing compact succeeds                                               | Treat pending trigger as covered; do not start a duplicate      |
| Existing compact is busy, does not compact, or rejects                  | Preserve pending trigger and retry after Agent idle             |
| Automatic compact fails or hits the existing failure limit              | Log bounded result; do not loop on the same provider response   |
| Runtime stops before idle                                               | Drop pending trigger and do not start compaction                |
| 50 user turns or one/more legacy intervals pass without oversized usage | Do not compact                                                  |

## 5. Good / Base / Bad Cases

- **Good**: Gemini's response includes `usageMetadata.promptTokenCount`; AI SDK maps it to `usage.inputTokens`; Core registers after the completed step and compacts only after Agent idle.
- **Base**: Another provider omits input usage. Core performs no automatic compaction and does not estimate tokens from message bytes.
- **Bad**: A completed step reports `100_000` and code uses `>=`, or a tool-continuation step compacts before the Agent turn is idle.

## 6. Tests Required

- Core runtime tests assert the `100_000` boundary, missing/invalid usage, over-limit `prompt-limit` + `force`, waiting for idle, step coalescing, stop behavior, successful in-flight compact deduplication, and retry after a manual compact returns busy or rejects.
- A regression asserts 50 user turns and legacy intervals do not call compact or read `userTurnsSinceLastCompact()`.
- Config tests assert legacy fields still parse and remain deprecated/inert.
- Google provider tests assert Gemini `usageMetadata.promptTokenCount` maps to `result.usage.inputTokens.total`.

## 7. Wrong vs Correct

### Wrong

```ts
if ((await conversation.userTurnsSinceLastCompact()) >= config.turnThreshold) {
  await conversation.compact("turn-limit", input);
}
```

This makes round count an automatic trigger and can compact without evidence of an oversized provider request.

### Correct

```ts
if (typeof event.usage?.inputTokens === "number" && Number.isFinite(event.usage.inputTokens) && event.usage.inputTokens > 100_000) {
  registerPendingPromptLimit(event);
  // Wait for Agent idle outside the FIFO; force compact at the next safe FIFO boundary.
}
```

This reacts only to completed provider usage and preserves the full Agent/tool continuation before summarizing history.
