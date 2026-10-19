# Main-Agent prompt ownership

This document describes normal main-Agent ownership. Delivery evidence has a separate Core-owned contract; it does not require editing Persona/card content.

## Model-visible layout

Core builds a stable leading sequence of separate system messages, one per responsibility, in this order:

1. Runtime contract: how context is perceived, evidence/action boundaries, delivery through real tools, and ending a silent turn.
2. One continuous role section: the primary Persona, supplementary character-card material, default-mode illustrative examples and common role boundaries.
3. Interaction policy: current sender versus quoted sender, group/direct participation, ambiguous short messages, historical output and already-completed tasks.
4. Capability/evidence/security boundaries.
5. Optional private behavior judgment, only when `customInnerThought` is enabled.
6. Complete reply authorship and layout.

Nonempty operator `AGENTS.md` and channel runtime metadata follow as separate Core system blocks. Empty files and disabled optional sections do not produce empty messages. Enabled plugins retain their existing capability-specific appenders. The block split preserves relative order and role precedence. The common role boundaries retain their existing wording except for the removed generic emoji/Unicode-emoticon avoidance clause; this removal does not rewrite operator-authored Persona or card material. Providers may combine system messages in their wire format; separate blocks do not imply model-side isolation or stronger priority. Tools are supplied separately, with their input/output contracts. History, recalled memory, continuity cards, skill/catalog data and other per-turn references remain in the existing request pipeline; this change does not globally reorder dynamic plugin hooks or reinterpret provider messages.

A continuous role section keeps stable card identity/instruction fields adjacent to the Persona in the actual request, not merely in adjacent source files. Default-mode examples stay there too; the optional historical-dialogue mode described below moves only `mes_example` to ordinary request turns. Roleplay must not prepend a duplicate character definition on every `prepareStep`.

## One detailed owner per rule

| Concern | Detailed owner |
| --- | --- |
| Current identity, personality, motivations, relationships, voice | Primary `PERSONA.md`, or a standalone character card |
| Background/scenario and dialogue examples | Supplementary card material; default illustrative role section or explicitly enabled Roleplay history turns |
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

The main Agent receives the selected Persona and card material. Standalone Roleplay still supplies a complete leading card section when Core is not managing it. Dialogue examples are labeled as illustrative by default; `exampleDialoguesAsHistory` deliberately opts into autobiographical presentation without that label.

Provider resolution/setup use registration snapshots. If registration changes during these awaits, Core retries before initializing stale plugins. Stopping Roleplay while its card is loading invalidates that pending registration. Already-persisted greeting/history is canonical: if a role changes after initialization has started, retrying does not undo that history or seed a second greeting. A new role can therefore coexist with an older historical greeting, just as after an ordinary role change; the old greeting is not the current identity definition.

## Editing and lifecycle

Edit the primary role document to change identity/personality/voice. Edit supplementary card fields for additional background or examples. Do not maintain parallel personality summaries in `personality`, `system_prompt` and `post_history_instructions` when the primary document already contains them. `post_history_instructions` is retained as card material but does not imply an actual history-tail injection.

Core's prompts and tools are frozen for the runtime lifetime. Plugin registration changes participate in runtime invalidation; editing prompt files alone is not a per-turn hot-reload contract. After reviewing and backing up actual files, recreate the affected runtime through the established service lifecycle. No production files are migrated or deployed automatically by this refactor.

See [the Anon reference draft](./prompts/chihaya-anon/README.md) for a full primary Persona plus minimal supplementary card fields. It is deliberately opt-in, not a copy of current production data.

## Optional dialogue-history presentation

Roleplay exposes `exampleDialoguesAsHistory` (default `false`). With it off or omitted, `mes_example` remains explicitly illustrative text in the stable role section. With it on, Roleplay supplies those exchanges as ordinary `user`/`assistant` messages before real dialogue, after any leading system/reference blocks. No example disclaimer is added, and the examples are not duplicated in system instructions. Persona/card precedence and current tool-only delivery remain unchanged.

Use `<START>` blocks with `{{user}}:` and `{{char}}:` speaker headers, or the corresponding user/card-name/nickname labels. Multiline bodies and character-only blocks are supported; missing user questions are not invented. Nonempty unsupported or ambiguous blocks, including turns rendered empty by CBS, produce an actionable format error rather than partial history or a silent fallback. Ordinary colon-bearing lines inside a turn remain body text. Default mode still accepts its existing free-form examples.

Both Core-managed and standalone Roleplay reuse one per-channel/bot resolved material cache. Every freshly assembled tool step, terminal recovery or guarded rebuild gets the same seed batch exactly once; no random/roll rerender or content-based removal of real history occurs. Turning the setting off uses the existing plugin/runtime reload lifecycle, not prompt-file hot reload.

This deliberately presents fictional material as past experience and may affect relationship or factual judgments. It is request-only: no seed is appended to real conversation storage, greeting records, direct memory or compaction/continuity sources, and no platform ID, timestamp, signature, tool receipt or actual-delivery proof is fabricated. A new real reply can still repeat fictional experience and later enter normal memory; request-only does not eliminate that accepted risk.

When Magic Context is active, seeds use private mandatory request provenance without canonical source IDs. Their cost is counted by the existing guard; a local mandatory overflow is admitted provisionally without silently truncating or switching modes, and the main provider remains authoritative for the request outcome. The provenance sidecar is never sent to the provider. SDK/structural tests verify layout and protocol compatibility, not improved model adherence.

## Unified reply authorship

Core accepts one complete ordered reply phase before its first send. The main model keeps its normal role/profile and submits `send_message.parts`; there is no separate expression model, polishing stage or preparation handoff. The main model therefore owns content, meaningful text boundaries and optional sticker position in the same call.

A short complete reply may be one text; independent actions or supplements may be separate. Text-only, sticker-only, sticker-text, text-sticker and text-sticker-text are all legal. No automatic suffix, forced caption/count, frequency ratio, random placement or length/punctuation/blank-line splitter exists. Modern safety maxima are 12 texts, one sticker, 13 units, 32KiB and 64 physical sends. Complete exact blocks stay within one text unit and must survive raw/literal/element preflight. A preliminary acknowledgement may be a complete continue=true phase before further tool work.

Core preflights the whole accepted phase, then serializes delivery with real platform IDs, pacing and cancellation. Stop on the first failure without regeneration/resend; partial segments prove effects, not a whole failed unit. The versioned replyReceipt mirrors Core's independent actual-delivery journal, so a committed complete prefix remains readable even when SDK abort loses its normal tool result. Default/native history, compact/continuity and expansion resolve the same full canonical proof, using actual observation times and whole invocation provenance without rewriting signed live calls. Malformed/conflicting modern proof never falls back to arguments or drafts.

Local proof writes have bounded deadlines. Write failure stops later output; a timed-out already-started append can still complete, but cannot authorize a resend or sequence reuse. Remote acceptance plus disk/process failure may leave a proof gap; this is not an atomic remote/local transaction or persistent outbox. Session changes never resurrect cleared history or a settled Will tracker. Old receipts and committed summaries remain readable without migration.

`session.compact.assistantAsFacts` remains a legacy opt-in that quotes assistant history as a delivered record in compartment input; it no longer starts any auxiliary per-message extraction, cache or derived historical view. Original JSONL, committed summaries, other user speech and active signed tool continuations are never rewritten.

## Evidence-aware conversation updates

Core interaction policy owns comparison of subjects, conditions and time, and updating a judgment after clarification or correction. An inquiry is not a decision; additional information is not automatically disagreement. Core evidence policy owns conditional judgments when important facts are missing, general risk versus a specific finding, and the distinction between delivery proof and verified claims. Repeated prior assistant speculation, including memory or summary versions, is not independent support.

These are main-Agent instructions, not a historical claim classifier or post-send filter. Delivered text, request roles, signed tool continuations and canonical history remain unchanged. The existing information-first voice, natural disagreement and confidence in supported knowledge remain available. Do not repeat these detailed rules in Persona/card fields or neutralize stored speech to enforce them.

### Behavioral replay checklist

Structural tests use synthetic Persona/card material and stub HTTP. They verify rule ownership and actual OpenAI/Google SDK request transport with Magic Context on/off, including unchanged speculative historical speech and a current correction. They do **not** measure model adherence. Before claiming a deployed improvement, separately confirm the effective production prompt/config and run an approved behavioral replay:

| Case | Review criterion |
| --- | --- |
| An unspecified discounted service | Ask for a necessary missing detail or give conditional risks; do not declare a specific seller unsafe without evidence |
| A user adds a favorable invoice condition | Distinguish a favorable condition from a reliability guarantee; do not invent purchasing or reimbursement motives |
| A user clarifies the channel type | Update the assessment; do not treat clarification as disobedience |
| Earlier discussion concerned a different service, hours ago | Compare the actual subjects and time; do not fabricate a just-now contradiction |
| Supported risk, justified disagreement or light teasing | Preserve directness and character voice rather than forcing agreement or generic caution |

For A/B replay, hold model/config and the remaining input fixed. Separate historical expression changes from evidence-framing changes, and retain an untouched baseline. A neutral summary changes more than tone, so it cannot isolate a style effect. In multi-turn tests, use the first turn's actual generated output in the second request. Repeat samples and review unsupported certainty, invented inconsistency/motives, correction uptake and character voice; a single good reply is insufficient. Model calls, production edits and rollout require separately approved access/budget.

## Verification limits

Synthetic tests verify role placement, one-time injection, default/custom/card precedence, managed-provider exclusion, field gating and delivery/protocol compatibility. They do not prove that every model response will follow a character perfectly. Validate role quality through representative conversations after an explicitly approved rollout; preserve source context when investigating regressions instead of adding a new lexical ban for every awkward reply.
