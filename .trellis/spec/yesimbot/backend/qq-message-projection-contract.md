# QQ Message Projection

## 1. Scope / Trigger

Read before changing Core `formatInput`, quote/reply rendering, or the channel-type explanation in `core/src/runtimes/prompt.ts`. Source changes and deployment are separate operations; validation must not overwrite the running Core build without rollout approval.

## 2. Signatures

Existing interfaces remain unchanged:

```ts
formatInput(input: Message | Event): UserModelMessage;
formatCurrentInput(input: Message | Event): UserModelMessage;
formatElements(elements: readonly Element[]): string;

interface MessageQuote {
  readonly messageId: string;
  readonly elements: readonly Element[];
  readonly author?: { readonly id: string; readonly isBot?: boolean };
}
```

ChannelContext uses `channel | guild | direct`, not `shared`.

## 3. Contracts

- Core explains both `channel` and `guild` as shared/multi-person contexts and `direct` as private. Do not migrate stored channel keys to match obsolete prompt wording.
- Current-message observation headers retain current sender, time and message ID.
- Historical `formatInput(input)` remains the unmarked projection for persisted conversation messages.
- `formatCurrentInput(input)` is the model-input projection for messages supplied as the current turn. It preserves the observation header outside a `[CURRENT_MESSAGE] ... [/CURRENT_MESSAGE]` body boundary; it does not mutate or rewrite the durable custom message.
- `core.model-input` must use `ModelMessageContext.current` to select current custom messages by message ID. Historical custom messages use `formatInput`; only current custom messages use `formatCurrentInput`, including current runtime events and joined batches.
- A normalized quote always gets its own `[QUOTED_MESSAGE id=… sender=…]` block. `sender` is the quoted author's ID, JSON-encoded exactly like the existing ID attributes; omit it for absent/empty author IDs. Never infer it from the current sender or self ID.
- If normalized quote elements are nonempty, they are the canonical content. Suppress inline `quote`/`reply` elements only when their `attrs.id` exactly equals the normalized message ID; apply recursively without mutating stored/replayed elements.
- This intentionally prioritizes normalized content if same-ID inline and normalized representations differ. Do not silently broaden matching to unrelated or missing IDs.
- Keep inline content when normalized elements are empty. Legacy inline-only messages remain renderable without invented author metadata.
- Do not pass duplicate-suppression state into rendering the normalized quote's own contents or the public `formatElements` helper.
- These are model-input changes, not admission changes. Will continues consuming the original records; no probability, reservation, delivery or persona behavior is changed by this contract.

## 4. Validation & Error Matrix

| Input | Projection |
|---|---|
| Known quote author, including bot | Explicit quoted sender separate from current sender |
| Missing/empty author | No quoted sender attribute |
| Matching inline placeholder | Canonical quote content and author remain visible |
| Nested matching quote/reply | One canonical copy, current body preserved |
| Other/missing inline ID | Preserve inline content; do not reattribute it |
| Empty normalized elements | Preserve available inline content |
| Quote/author IDs containing quotes or newlines | JSON-escaped attributes, no new observation line |
| JSONL replay | Same output; input remains unchanged |

## 5. Good / Base / Bad Cases

- Good: Alice quotes Bob and @mentions the bot; Alice stays the current sender, Bob is the quoted sender, and the @ plus current question remain in the body.
- Base: ordinary direct/group messages and legacy inline quotes retain their current representation.
- Bad: treating any inline quote anywhere as a reason to suppress the complete normalized quote; renaming channel persistence keys instead of correcting their prompt explanation.

## 6. Tests Required

- `core/tests/messages.test.ts`: authors, escaping, placeholders, nested matching, unrelated IDs, empty normalized content, legacy messages, replay and nonmutation; current-message body boundary keeps sender/ID in the observation header.
- `core/tests/runtimes.test.ts`: the model-input plugin marks only `context.current` custom messages, leaving historical custom messages unmarked.
- `core/tests/prompt.test.ts`: all three actual channel types and quote-sender semantics; current sender attribution and `@`-without-topic behavior.
- `core/tests/platforms.test.ts`: OneBot translation → message creation → model projection, including an inline reply placeholder plus quoted asset and author.
- Core, Will-policy and message-debounce regression suites; scoped formatting/lint, Core type-check and isolated build. Compare pre-existing lint warnings separately.
- Check config/Persona/card and running dist hashes, container start time and restart count when deployment is not authorized. Passing deterministic tests does not establish model behavior or canon fidelity.

## 7. Wrong vs Correct

Wrong: `quote && !containsQuoteElement(body)` drops content/author even for an empty inline placeholder or an unrelated nested quote.

Correct: always render the normalized quote, add only known author metadata, and suppress only its matching inline copies when canonical content exists. Preserve the original message record for other consumers.
