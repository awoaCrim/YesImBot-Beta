# Historical Model-History Projection Contract

## 1. Scope / Trigger

- Trigger: the Core runtime must prevent previously delivered roleplay output and internal control notes from becoming style demonstrations in later turns.
- Scope: the persisted-history projection immediately before model-message conversion.
- Non-scope: durable JSONL contents, current-turn messages, Persona/card text, Will admission, and platform delivery.

## 2. Signatures

```ts
export const INTERNAL_HISTORY_PROJECTION_PLUGIN: AgentPlugin;

export function stripInternalAssistantInputs(entries: readonly AgentEntry[]): AgentEntry[];
```

`INTERNAL_HISTORY_PROJECTION_PLUGIN.transformEntries` is the implementation seam. `ChannelRuntime` registers it before model conversion.

## 3. Contracts

- The projection is non-mutating. Untouched entries retain their original object identity where practical; changed entries are cloned.
- It applies to persisted history only. The current turn remains available to the agent's tool loop.
- For historical assistant tool calls:
  - remove `send_message` calls from the action trace. If the paired result proves that one or more messages were delivered, insert a `yesimbot.delivered-transcript` custom message carrying only the sanitized delivered strings, the delivered input count, and whether the send was partial; if none were delivered, retain no output text;
  - remove `generate_image` and `edit_image` calls, because their artifact-producing side effects are ephemeral and can resurrect an old image task;
  - remove `read` calls only when their `uri` starts with `artifact://`; ordinary `asset://` and other durable reads remain available;
  - remove `inner_thought` and `reason` fields from retained tool inputs.
- For historical tool-result messages:
  - remove results paired with historical `send_message`, `generate_image`, `edit_image`, or artifact-read calls;
  - retain results for all other tools.
- A `yesimbot.delivered-transcript` custom message is a completed historical fact, not a pending request, tool call, or reply draft. Its data may contain only sanitized user-visible message text, a delivered input count, and a partial-send flag: no `inner_thought`, `reason`, provider metadata, or `artifact://`, `asset://`, or `workspace://` URI.
- If filtering leaves an assistant or tool message with no content, omit that message entry.
- Preserve user/platform custom messages, system messages, ordinary assistant content, non-output tool calls, and non-output tool results. Delivered transcript entries may be reordered ahead of ordinary history so the model seam can aggregate them into one leading read-only context block; their internal chronological order remains stable.
- No fixed reply count, character limit, lexical ban, notification wording, or history deletion is introduced by this projection.
- A complete paired `[DELIVERED_MESSAGE]...[/DELIVERED_MESSAGE]` envelope already present in persisted assistant text is legacy output-shaped text. On read projection only, convert its sanitized body into a `yesimbot.delivered-transcript` custom message; do not normalize current-turn entries, write back JSONL, or convert the body into a tool call.
- Legacy-marker conversion is non-mutating and idempotent. Lone, nested, or incomplete markers are preserved unchanged (fail closed); an empty normalized body may remove its text part/entry under the existing empty-content rule.
- Generated transcripts are collected into one leading read-only `role: assistant` context block at the model seam. The block is an inert historical data container, not a pending assistant completion, user request, or executable tool trace. It must contain no tool calls or results, must never be projected as `role: user`, and requires no new output-marker prompt.
- Provider invariant: Gemini-style converters reject any `system` message that appears after non-system content, so the projected history must emit all system entries (e.g. the compact summary) before the transcript assistant block; `stripInternalAssistantInputs` stably hoists system entries to the front to guarantee `[system..., transcripts..., dialogue...]`.
- Durable session JSONL remains the source of truth for diagnostics, Console projection, expansion, and future migrations.

## 4. Validation & Error Matrix

| Condition                                                                                            | Required behavior                                                                                              |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Assistant message contains only `send_message` and its result proves successful delivery             | Replace the call with one `yesimbot.delivered-transcript` custom message; remove the paired result.            |
| Assistant message contains only `send_message` and no message was delivered                          | Omit the historical assistant message and its result.                                                          |
| Assistant message contains a partially successful `send_message`                                     | Project only the messages before `failedAt` into a partial transcript; never project failed or later messages. |
| Assistant message contains `send_message` plus another tool call                                     | Insert the proven delivery transcript, remove the `send_message` trace/result, and preserve the other call.    |
| Assistant message contains an image/artifact-read call plus an ordinary read or finish call          | Remove only the image/artifact-read call; preserve the ordinary call.                                          |
| Tool result contains a `send_message`, `generate_image`, or `edit_image` result                      | Remove that result; preserve other results in the same message.                                                |
| Tool result has no `toolName` but its `toolCallId` matches a removed output/image/artifact-read call | Remove it.                                                                                                     |
| Tool call/result has missing or malformed optional fields                                            | Do not throw; preserve unrelated content and apply only unambiguous filtering.                                 |
| Entry is non-message or message role is not assistant/tool                                           | Preserve it unchanged.                                                                                         |
| Current-turn entry                                                                                   | Do not pass through this persisted-history transform.                                                          |
| Persisted assistant text contains a complete legacy delivered marker                                 | Convert its body to a transcript, clone only the changed projection, and leave durable JSONL unchanged.        |
| Multiple delivered transcript entries are present in projected history                         | Move them ahead of ordinary history and convert them once into one leading read-only context block.              |
| Persisted assistant text contains a lone, nested, or incomplete marker                               | Preserve the original text and entry; do not throw or partially rewrite it.                                    |

## 5. Good / Base / Bad Cases

- Good: a later turn receives recent user messages, stable persona instructions, compact facts, and retained research/tool results without copying a previous five-bubble performance.
- Base: an ordinary `read`, search, or `finish` tool loop remains structurally paired and available to the model; only reads of ephemeral `artifact://` outputs are hidden.
- Bad: delete JSONL records, remove user messages, redact output by punctuation/length heuristics, drop all evidence of a successfully delivered reply so the model can mistake the request as unanswered, or leave an unmatched historical tool result after removing its assistant call.

## 6. Tests Required

- Unit test that `inner_thought` and `finish.reason` are removed without mutating the durable input.
- Unit test that a successful mixed assistant/tool pair projects delivered strings as a typed transcript, removes `send_message` and its result, and retains `finish` or another non-output tool.
- Unit test that a partially successful send projects only messages before `failedAt`, while a zero-delivery failure projects no message text.
- Regression test that a completed `generate_image` / `edit_image` trace and reads of its `artifact://` output do not reappear in a later ordinary-turn model prompt, while ordinary durable reads remain available.
- Unit test that ordinary assistant content and non-assistant entries preserve identity/content.
- Regression tests for complete, empty, malformed, nested, and repeated legacy-marker projection, including input identity and idempotence.
- Regression test that multiple delivered transcripts are aggregated once into one leading model context block, with no duplicate conversion for later transcript entries.
- Focused `vitest` run for `core/tests/internal-history.test.ts` and related runtime tests.
- Core TypeScript check, formatting, lint, build, and the full Core suite with unrelated pre-existing failures reported separately.
- Production smoke: inspect compiled marker, restart only `yesimbot-koishi`, verify container health and HTTP assets, and do not send a synthetic production chat message.
- Behavioral claims require post-activation natural traffic; static projection tests alone do not prove personality fidelity.

## 7. Wrong vs Correct

### Wrong

Remove or rewrite old JSONL entries, or add a rule such as “never send more than N messages” to hide the observed voice regression.

### Correct

Keep the complete durable history, but project historical model messages structurally: remove completed `send_message` action traces and private control notes while retaining proven delivered speech as a typed transcript converted to read-only system context. This lets the model know what it already said without giving it an executable tool call, assistant few-shot example, or resource URI to replay. The projection changes model visibility, not user data or delivery behavior.

## 8. Boundary Rebuild Invariant

`buildBoundaryModelMessages()` has two distinct inputs and must not collapse them into one projection pass:

```text
sanitized persisted entries
  ├─ entries predating the active turn → transformEntries() → projected history
  └─ entries appended by the active turn → raw live history/current input
```

The runtime records active-turn message entries through the append pipeline. At each provider boundary it must:

1. read and sanitize durable entries without mutating them;
2. exclude all active-turn live entry IDs from the `transformEntries()` input;
3. keep active-turn live entries in append order, preserving assistant `tool-call` and tool `tool-result` pairs;
4. put only the current batch in `current`, and put earlier active-turn entries in `history` without duplication;
5. when `historyMode: "event"` is selected, omit old conversation history but retain active-turn live continuation context.

A historical projection may reorder or replace old entries, such as moving a compact summary before retained history. That ordering must remain intact; raw active-turn entries are appended after projected history and are never normalized as historical delivered output. This boundary prevents a successful `send_message({ continue: true })` from being rebuilt as an orphan assistant tool-call.

### Boundary validation matrix

| Condition                                                           | Required behavior                                                                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Current-turn assistant tool-call has a persisted paired tool-result | Both entries bypass historical projection and remain ordered in the next provider prompt.                                    |
| Historical `send_message` result is projected away                  | The historical action/result is removed or replaced according to the projection contract; current-turn pairs are unaffected. |
| Current-turn tool loop has multiple continuation steps              | Each earlier assistant/tool pair appears exactly once in later boundaries.                                                   |
| `historyMode: "event"`                                              | Old persisted conversation entries are absent, but current-turn tool context remains.                                        |
| Projection emits a compact summary in a different order             | The projected order is preserved before raw current-turn continuation entries.                                               |

The regression tests should assert both the provider prompt structure and the absence of `turn.failed`/`AI_MissingToolResultsError`; a test that only inspects the durable JSONL does not cover this boundary.
