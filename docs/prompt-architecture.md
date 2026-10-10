# Main-Agent prompt ownership

This document describes normal main-Agent ownership. Delivery evidence has a separate Core-owned contract; it does not require editing Persona/card content.

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

The role handoff is Core-owned. A `ChannelPlugin` can expose `roleProfile: MainAgentRoleProvider`; its `resolve(context)` returns `MainAgentRoleProfile` (`characterDefinition` and/or `roleInstructions`). Core resolves this before plugin setup, and sets `rolePromptsManaged` only for opted-in providers. These plugins must then omit their own card append/prefix, while retaining other capabilities and greeting initialization.

The main Agent receives the selected Persona and card material. Standalone Roleplay still supplies a complete leading card section when Core is not managing it. Dialogue examples remain labeled as illustrative behavior, not current events.

Provider resolution/setup use registration snapshots. If registration changes during these awaits, Core retries before initializing stale plugins. Stopping Roleplay while its card is loading invalidates that pending registration. Already-persisted greeting/history is canonical: if a role changes after initialization has started, retrying does not undo that history or seed a second greeting. A new role can therefore coexist with an older historical greeting, just as after an ordinary role change; the old greeting is not the current identity definition.

## Editing and lifecycle

Edit the primary role document to change identity/personality/voice. Edit supplementary card fields for additional background or examples. Do not maintain parallel personality summaries in `personality`, `system_prompt` and `post_history_instructions` when the primary document already contains them. `post_history_instructions` is retained as card material but does not imply an actual history-tail injection.

Core's prompts and tools are frozen for the runtime lifetime. Plugin registration changes participate in runtime invalidation; editing prompt files alone is not a per-turn hot-reload contract. After reviewing and backing up actual files, recreate the affected runtime through the established service lifecycle. No production files are migrated or deployed automatically by this refactor.

See [the Anon reference draft](./prompts/chihaya-anon/README.md) for a full primary Persona plus minimal supplementary card fields. It is deliberately opt-in, not a copy of current production data.

## Unified reply authorship

Core accepts one complete ordered reply phase before its first send. The main model keeps its normal role/profile and submits `send_message.parts`; there is no separate expression model, polishing stage or preparation handoff. The main model therefore owns content, meaningful text boundaries and optional sticker position in the same call.

A short complete reply may be one text; independent actions or supplements may be separate. Text-only, sticker-only, sticker-text, text-sticker and text-sticker-text are all legal. No automatic suffix, forced caption/count, frequency ratio, random placement or length/punctuation/blank-line splitter exists. Modern safety maxima are 12 texts, one sticker, 13 units, 32KiB and 64 physical sends. Complete exact blocks stay within one text unit and must survive raw/literal/element preflight. A preliminary acknowledgement may be a complete continue=true phase before further tool work.

Core preflights the whole accepted phase, then serializes delivery with real platform IDs, pacing and cancellation. Stop on the first failure without regeneration/resend; partial segments prove effects, not a whole failed unit. The versioned replyReceipt mirrors Core's independent actual-delivery journal, so a committed complete prefix remains readable even when SDK abort loses its normal tool result. Default/native history, compact/continuity and expansion resolve the same full canonical proof, using actual observation times and whole invocation provenance without rewriting signed live calls. Malformed/conflicting modern proof never falls back to arguments or drafts.

Local proof writes have bounded deadlines. Write failure stops later output; a timed-out already-started append can still complete, but cannot authorize a resend or sequence reuse. Remote acceptance plus disk/process failure may leave a proof gap; this is not an atomic remote/local transaction or persistent outbox. Session changes never resurrect cleared history or a settled Will tracker. Old receipts and committed summaries remain readable without migration.

`session.compact.assistantAsFacts` remains a legacy opt-in that quotes assistant history as a delivered record in compartment input; it no longer starts any auxiliary per-message extraction, cache or derived historical view. Original JSONL, committed summaries, other user speech and active signed tool continuations are never rewritten.

## Verification limits

Synthetic tests verify role placement, one-time injection, default/custom/card precedence, managed-provider exclusion, field gating and delivery/protocol compatibility. They do not prove that every model response will follow a character perfectly. Validate role quality through representative conversations after an explicitly approved rollout; preserve source context when investigating regressions instead of adding a new lexical ban for every awkward reply.
