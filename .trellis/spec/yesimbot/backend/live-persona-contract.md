# Live Persona and Character Card Maintenance

## 1. Scope / Trigger

Read before modifying the production Persona, PNG character-card metadata, or QQ style examples. This is distinct from frozen offline persona experiments. Obtain authorization for live prompt changes; do not promote a research file just because its name is PERSONA.md.

## 2. Interfaces and Paths

- Core: `buildCoreSystemPrompt({ basePath, channel, selfId, ... })` reads `PERSONA.md` and optional `AGENTS.md`.
- Roleplay: `loadCharacterCard(path)` accepts base64 JSON from PNG `ccv3` or `chara` tEXt chunks; `createRoleplayPlugin()` composes instructions, examples and character definition.
- Live container base: `/koishi/data/yesimbot`.
- Inspect mounts rather than assuming the source-volume path: this deployment maps `/opt/yesimbot/data/koishi` to `/koishi/data`.
- Roleplay caches the card at startup. Updating a PNG on disk alone does not update the running plugin.

## 3. Contracts

- Review the combined Core/Persona/AGENTS/card envelope, not just one text file. Do not let card defaults and examples negate the detailed Persona's intended emotional range.
- Keep identity, timeline, relationships, greetings, model configuration and Will settings outside an expression-only change unless separately approved.
- Synthetic examples must be labeled as authored demonstrations, not canon quotations or actual shared history. Use the existing example-dialogue provenance wrapper; never seed them into persisted conversation messages.
- When examples are anchored to canon dialogue, keep the provenance file (original line, source, confidence) outside the card, state that status in `system_prompt`, and do not present unverified lines as official. Whether the examples are stored in the source language or a Chinese retelling is a persona decision, not a safety rule: measured leak of the source language into visible replies came from the Japanese-monologue wording, not from Japanese examples (1/9 attempts with Chinese examples, 0/12 with Japanese ones). Whichever language the card uses, the visible-reply language rule must be stated independently.
- The notify plugin owns authenticated event transport and the untrusted-data boundary, not Anon's user-visible relay policy. Do not add fixed model-facing relay instructions, bubble caps, character limits, banned words, or other output-shape rules to the injected event text. After changing Persona, card, or `AGENTS.md`, run an authorized observational canary when behavior needs verification, as described in [Automation Notification Contract](./automation-notification-contract.md).
- If a non-visible field (for example `inner_thought`) is written in another language, bind that language to that field only and state the visible-language rule in both `system_prompt` and `post_history_instructions`. Tool-call inputs stay in the agent's own history and `renderEntryForBudget()` stringifies them into the compaction ledger, so an unqualified "think in Japanese" instruction spreads through summaries and later turns.
- Instruction weight is positional, not rhetorical. `appendSystemPrompt` runs once at runtime init (and `post_history_instructions` is prepended too, because Google rejects system messages after history), so a one-off prompt edit may decay as the conversation grows; measured: the Japanese-monologue rule held 22/22 in fresh sessions but 0/16 in the long live session. Treat those measurements as diagnostics, not as a reason to add fixed numeric output limits, lexical bans, or repeated hard-coded reminders. Prefer the existing Persona/card evidence, current conversation, and runtime data flow; any new behavior rule requires explicit approval.
- The example set's emotional distribution is part of the voice contract. Use sourced or clearly labeled demonstrations to broaden the observed range, but do not turn measured style metrics into hard-coded prompt constraints.
- Treat one `send_message` call's `messages` array as one response unit: unless the content itself requires a change in narrative distance, keep speaker identity, register, narrative distance, and emotional intensity coherent across the batch. External, tool, search, and image results are source material and must be rendered through the current persona and conversation register rather than copied as a generic article or report followed by roleplay.
- Change only approved card fields; increment character_version for a substantive card revision. Preserve non-card PNG chunks byte-for-byte. If both supported metadata chunks exist, update both consistently without silently converting card schemas.
- Back up the live pair, compare source hashes before writing, preserve permissions/ownership, and guard rollback against concurrent user edits.
- Apply Persona/card as a coordinated maintenance operation. A controlled stop/update/start avoids mixing a fresh Persona with an older cached card. Health failure restores the scoped pair, not the whole working tree.
- Do not clear chat or memory to hide old style. Ordinary historical influence is an evaluation limitation, not permission to erase user data.
- Sandbox reply checks need a one-shot channel with a unique user id. On a shared test channel another attached client (for example an open Console page) may consume the reply, so a missing message there does not prove a transport failure.

## 4. Validation Matrix

| Check | Requirement |
|---|---|
| Persona sections | Only intended sections differ; background/relationship sections remain intact |
| PNG | Signature and all CRCs valid; non-card chunks unchanged |
| Card | Existing loader accepts it; unrelated fields and first_mes unchanged |
| Prompt composition | User/character placeholders resolve; examples stay in system instructions, not storage |
| Service | Correct live hashes, running state, HTTP page/assets healthy; protected config/Core/AGENTS unchanged |
| Behavior claims | Static checks establish loading/integrity, not personality fidelity |
| Form regression | On a one-shot channel, measure bubbles/turn, chars/bubble, stacked `！？`, self-reference and implementation chatter against the pre-change live distribution; treat the numbers as observational evidence, not hard-coded prompt rules |
| Notification canary | After a persona/card change, `completed`, `failed` and an adversarial event still get relayed with real `messageIds` |

## 5. Good / Base / Bad Cases

Good: diversify emotional examples while preserving initiative, self-interest and accurate task completion.
Base: ordinary facts, memories and greetings survive a style revision.
Bad: forcing silence to reduce exclamation counts; treating shortness as canon fidelity; applying an offline no-tool limitation to production; silently changing model or reply probability.

## 6. Required Tests

- Local metadata/section invariants and PNG round-trip checks.
- Existing roleplay loader/CBS/greeting/plugin tests plus direct/group combined-prompt fixtures with synthetic storage.
- Scope-appropriate type/lint/format checks for any test/helper changes.
- Post-deployment live-file hashes and health checks. Record an activation timestamp so later conversation sampling is not mislabeled as post-change evidence.

## 7. Wrong vs Correct

Wrong: `write(PERSONA.md); declare success` while roleplay still caches a conflicting card.

Wrong: label canon-anchored examples as invented, or drop the honesty/task boundary because "canon Anon would not read product copy".

Wrong: `用日文思考` with no field boundary, then discover Japanese monologue in the compaction ledger and in later replies.

Correct: inspect both sources, make a scoped reversible pair, test actual composition, activate through the supported lifecycle, and distinguish successful activation from unproven behavioral improvement.
