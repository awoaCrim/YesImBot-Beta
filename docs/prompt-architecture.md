# Main-Agent prompt ownership

This document describes normal main-Agent ownership and its optional delegated expression paths. History extraction and delivery evidence have separate Core-owned contracts; neither requires editing Persona/card content.

## Model-visible layout

Core builds a stable leading system section in this order:

1. Runtime contract: how context is perceived, evidence/action boundaries, delivery through real tools, and ending a silent turn.
2. One continuous role section: the primary Persona, supplementary character-card material, examples and common role boundaries.
3. Interaction policy: current sender versus quoted sender, group/direct participation, ambiguous short messages, historical output and already-completed tasks.
4. Capability/evidence/security boundaries. Enabled plugins may append their own capability-specific boundaries after Core.

Optional operator `AGENTS.md` and channel runtime metadata remain separate Core system blocks. Tools are supplied separately, with their input/output contracts. History, recalled memory, continuity cards, skill/catalog data and other per-turn references remain in the existing request pipeline; this change does not globally reorder dynamic plugin hooks or reinterpret provider messages.

A continuous role section means all card fields are adjacent to the Persona in the actual assembled request, not merely stored in adjacent source files. Roleplay must not also prepend a duplicate character definition on every `prepareStep`.

## One detailed owner per rule

| Concern | Detailed owner |
| --- | --- |
| Current identity, personality, motivations, relationships, voice | Primary `PERSONA.md`, or a standalone character card |
| Background/scenario and illustrative dialogue | Supplementary card material in the same role section |
| Autonomy, no invented user thoughts/actions, gradual relationships, non-stereotyped reactions | Common role boundaries, without copying them into each tool |
| Current message attribution, participation, ambiguity, no repeated completed-task delivery | Core interaction policy |
| Evidence, source trust, actual execution results, private instructions | Core runtime/security policy |
| Sending, message splitting, `continue`, destination, raw/element syntax, partial failure | `send_message` description/schema |
| Optional internal judgment field | Conditional `send_message.inner_thought` contract; never a second visible output format |
| Sandbox/host permissions, memory privacy, sticker send restrictions | Owning capability/tool; do not weaken real safety constraints for brevity |
| Learned styles and reflections | Bounded historical reference, subordinate to identity, evidence and the current request |
| Compaction/continuity generation | Separate auxiliary-model prompts, not the main Agent's persona |

A brief tool-specific reminder is acceptable when needed for correct invocation. Removing every repeated word is not the objective. Avoid repeating complete personality or behavioral paragraphs across Persona, card fields, Core policy and tools.

## Persona and card precedence

- A custom nonempty `PERSONA.md` is the primary identity and behavior document; card fields supplement it.
- With a card but without a custom Persona, the card is the primary character. Do not inject the fallback Athena identity alongside it.
- Without either, Core uses its default Persona in memory.
- A legacy file exactly matching the trimmed built-in default is treated as fallback when a card is configured; the file itself is not rewritten. This is exact default recognition, not semantic identity detection.
- Arbitrary user text is never automatically deduplicated or rewritten. If custom Persona and card disagree, the primary document wins by the prompt's explicit instruction; this is not a formal guarantee of model compliance. Operators should reconcile contradictions rather than relying on repeated priority statements.
- Multiple nonempty role providers for one channel are configuration ambiguity and must be rejected explicitly rather than silently blending characters.

The role handoff is independent of the polisher registry. A `ChannelPlugin` can expose `roleProfile: MainAgentRoleProvider`; its `resolve(context)` returns `MainAgentRoleProfile` (`characterDefinition` and/or `roleInstructions`). Core resolves this before plugin setup, and sets `rolePromptsManaged` only for opted-in providers. These plugins must then omit their own card append/prefix, while retaining other capabilities and greeting initialization.

Delegated mode continues to keep character prompts out of the main Agent, and standalone Roleplay still supplies a complete leading card section when Core is not managing it. Dialogue examples remain labeled as illustrative behavior, not current events.

Provider resolution/setup use registration snapshots. If registration changes during these awaits, Core retries before initializing stale plugins. Stopping Roleplay while its card is loading invalidates that pending registration. Already-persisted greeting/history is canonical: if a role changes after initialization has started, retrying does not undo that history or seed a second greeting. A new role can therefore coexist with an older historical greeting, just as after an ordinary role change; the old greeting is not the current identity definition.

## Editing and lifecycle

Edit the primary role document to change identity/personality/voice. Edit supplementary card fields for additional background or examples. Do not maintain parallel personality summaries in `personality`, `system_prompt` and `post_history_instructions` when the primary document already contains them. `post_history_instructions` is retained as card material but does not imply an actual history-tail injection.

Core's prompts and tools are frozen for the runtime lifetime. Plugin registration changes participate in runtime invalidation; editing prompt files alone is not a per-turn hot-reload contract. After reviewing and backing up actual files, recreate the affected runtime through the established service lifecycle. No production files are migrated or deployed automatically by this refactor.

See [the Anon reference draft](./prompts/chihaya-anon/README.md) for a full primary Persona plus minimal supplementary card fields. It is deliberately opt-in, not a copy of current production data.

## Optional facts-driven expression and history

The message-polisher plugin has `mode: rewrite | compose`, default **rewrite** for existing configurations. Both delegated paths remove Persona/card material from main; operator AGENTS, execution/evidence/security policy and tools remain. Rewrite keeps facts plus a same-count draft and original-draft fallback. Compose main only supplies outward facts, an exchange intent and optional exact verbatim payload; it does not draft role dialogue or control bubble organization. The dedicated expression model receives the complete live Persona/card and chooses 1–12 messages within 32 KiB. Failures send nothing: never dump facts/intent or switch back to main-generated dialogue. Core retains targets/raw-element/continue and checks accepted capability/profile revision again before delivery.

The live expression profile uses the same custom/default/card-only precedence as normal assembly. A standalone card must not receive fallback Athena alongside it. Main delegated assembly does not read PERSONA at all; the send profile does. The reference context is bounded **current-turn** user and sanitized non-send tool output, not private reasoning, assistant tool arguments or full history. Token checks protect outward numeric/mention/resource/element anchors plus exact verbatim, not all incidental reference text. Natural-language equivalence remains model-guided.

Separately, enable Core `session.compact.assistantAsFacts: true` with `auxiliaryModel` to remove historical own dialogue exemplars from every retained window. The utility route extracts assistant-attributed objective records; missing models, invalid output, cancellation or oversize sources yield unavailable metadata, never original-text fallback or a main-model call. Existing summaries are not migrated. Original JSONL, other user speech and active signed tool continuations remain untouched. New compression/continuity and explicit expansion consume the same proof-bound cached factual view; page offsets refer to that view.

Polished receipts record actual **complete** delivered bodies rather than a draft. Partial failed items or segments without valid platform IDs cannot become proven full replies. Historical native new receipts use a transcript without rewriting signed call arguments. Disabling factual history restores legacy projection; the older compartment policy still excludes assistant when its inclusion option is false, while actual-body receipts remain authoritative wherever speech is rendered.

Both features add model cost/latency and are opt-in. See [message-polisher configuration](../plugins/message-polisher/README.md). No production settings, role files or old history are changed automatically.

## Verification limits

Synthetic tests verify role placement, one-time injection, default/custom/card precedence, delegated exclusion, field gating and delivery/protocol compatibility. They do not prove that every model response will follow a character perfectly. Validate role quality through representative conversations after an explicitly approved rollout; preserve source context when investigating regressions instead of adding a new lexical ban for every awkward reply.
