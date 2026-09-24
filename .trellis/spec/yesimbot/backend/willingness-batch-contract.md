# Batch Willingness and Delivery Settlement

## Scenario: Probabilistic per-author participation over a debounced conversation batch

### 1. Scope / Trigger

Use this contract whenever a YesImBot change touches any of these boundaries:

- `WillEngine` admission or decision APIs;
- `MessageBatchPlugin` / debounce behavior;
- `notice.poke` or quoted-message metadata;
- per-conversation willingness scoring or persistence;
- `send_message` delivery observation;
- reply-cost reservation, confirmation, release, or recovery.

The primary invariant is: **one ordered conversation batch updates each author independently, samples only its highest candidate once, starts at most one deferred Agent turn, and confirms at most one recorded reply cost only after a real current-channel delivery.**

### 2. Signatures

Core extensions are optional so legacy plugins remain source-compatible:

```ts
export type MessageBatchInput = Message | Event;

export interface MessageBatchSetupExtensions {
  flushInputs(inputs: readonly MessageBatchInput[]): Promise<void>;
}

export interface MessageBatchController {
  enqueue(input: Message): void;
  enqueueEvent?(input: Event): boolean;
  stop?(): Awaitable<void>;
}

export interface WillBatchDecision {
  readonly decision: "wait" | "trigger";
  readonly candidate?: {
    readonly inputId: string;
    readonly authorId: string;
    readonly score: number;
    readonly probability: number;
  };
  readonly reservationId?: string;
}

export type WillReservationOutcome =
  | { readonly kind: "commit"; readonly turnId: string; readonly messageId: string }
  | {
      readonly kind: "release";
      readonly turnId?: string;
      readonly reason: "done-without-delivery" | "failed" | "aborted" | "consume-failed" | "start-failed";
    };

export interface WillEngine {
  decide(input: Message | Event, state: WillState): Awaitable<"wait" | "trigger">;
  decideBatch?(inputs: readonly MessageBatchInput[], state: WillState): Awaitable<WillBatchDecision>;
  settleReservation?(reservationId: string, outcome: WillReservationOutcome): Awaitable<void>;
}
```

Platform metadata additions are also optional:

```ts
interface MessageQuote {
  readonly messageId: string;
  readonly elements: readonly Element[];
  readonly author?: { readonly id: string; readonly isBot?: boolean };
}

interface PokePayload {
  readonly actorId?: string;
  readonly targetId: string;
  readonly action: string;
}
```

Durable state lives at `<ChannelResources.path>/willingness.json`:

```ts
interface WillingnessFileV1 {
  version: 1;
  updatedAt: number;
  bots: Record<
    string,
    {
      authors: Record<
        string,
        {
          confirmedScore: number;
          lastMessageAt: number | null;
          lastDecayAt: number | null;
        }
      >;
      reservations: Record<
        string,
        {
          id: string;
          authorId: string;
          amount: number;
          createdAt: number;
          sourceEventIds: string[];
        }
      >;
    }
  >;
}
```

### 3. Contracts

#### Admission and ordering

- Persist each canonical Message/Event once before willingness admission.
- Ordinary Messages enter the selected message-batch controller.
- An Event enters the batch only when the selected Will implements `decideBatch()`, the controller implements `enqueueEvent()`, and the controller accepts a typed `notice.poke` with a non-empty `actorId` and `targetId === selfId`.
- Non-poke Events and trusted `messenger.post()` stay on the immediate path.
- A message-only batch plugin and a Will that only implements `decide()` keep their legacy behavior.
- A triggered reservation-bearing turn always uses `ifBusy: "defer"`; it must never join an existing turn.

#### Batch scoring

- Process inputs by clamped timestamp, preserving arrival order for equal timestamps.
- Update only `Message.data.user.id` or the typed poke `actorId`.
- Use an own-property lookup for author state; never read inherited properties such as `toString` as stored state. Reject/skip prototype-mutating keys such as `__proto__`, `prototype`, and `constructor`.
- Apply strict half-life mode as `score * 2^(-elapsedSeconds / halfLifeSeconds)`; never move decay time backwards.
- Add persistent base gain for every accepted input. Image content adds no extra gain in highest-candidate mode.
- Normalize current-body text with NFKC, locale-independent lowercase, whitespace collapse, and trim. Skip quote/reply subtrees and persisted quote contents.
- `@all` and `@here` are ordinary. A quote signal exists only when the conversation is non-direct and `quote.author.id === selfId`.
- Direct, self-mention, self-quote, and targeted-poke gains are temporary; use their maximum, not their sum.
- Choose the highest final candidate, then latest candidate timestamp, then latest input order. Call the random source exactly once for that winner.

#### Reservation and delivery

- The winning trigger mutation must atomically persist one reservation before Core starts the Agent.
- Store `amount = min(replyCost, availableBase)` and use that recorded amount at settlement; pending reservations do not modify `confirmedScore`.
- A pending author still accumulates base score but cannot create another reservation. Other authors remain eligible.
- The first non-empty message ID from `send_message.onDelivered` for the same turn and current conversation commits the reservation. Partial multi-segment success therefore commits.
- Cross-channel delivery, zero returned IDs, model text without `send_message`, and all-failed sends do not commit.
- Done without delivery, failed, aborted, consume failure, start failure, or runtime cancellation releases the reservation without subtracting score.
- Delivery wins over a later terminal failure. Commit/release of a missing reservation is an idempotent no-op.
- Runtime may retry a transient settlement failure. If delivery-time retries exhaust, terminal cleanup must make a fresh bounded attempt instead of reusing a permanently rejected Promise.

#### Persistence and compatibility

- Namespace durable state by conversation path and `selfId`; authors are independent inside that namespace.
- Serialize mutations, write a unique sibling temp file with exclusive creation, atomically rename, and replace the in-memory snapshot only after rename succeeds.
- Author timestamps are either both null or both finite timestamps; `lastDecayAt` cannot precede `lastMessageAt`.
- Reservation ownership must use an own-property check, not the JavaScript `in` operator.
- On recovery, apply elapsed decay and atomically remove unfinished reservations without deducting them.
- Malformed, unknown-version, unsafe-key, dangling-reservation, or inconsistent-timestamp state resets to controlled empty state and logs a bounded warning.
- Validate willingness-only configuration only when `engine === "willingness"`; `engine: routing` is an inert rollback switch even if a retained willingness block is stale or invalid.

### 4. Validation & Error Matrix

| Condition                                                                                                 | Required behavior                                                             |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `maxScore <= 0`, non-finite number, negative gain/cost/multiplier, invalid half-life, threshold above max | Reject active willingness configuration before Runtime use                    |
| `persistState: true` without `batchDecision: highest-candidate`                                           | Reject active willingness configuration                                       |
| Highest-candidate mode with any force flag                                                                | Reject active willingness configuration                                       |
| Routing engine with an invalid unused willingness block                                                   | Keep routing usable; do not initialize or mutate willingness state            |
| Poke missing actor or targeting another account                                                           | Do not admit to debounce; highest-candidate extraction returns no participant |
| Quote author missing or not `selfId`                                                                      | Treat as ordinary input                                                       |
| State author has only one timestamp or decay precedes message time                                        | Treat file as invalid and reset safely                                        |
| Reservation author exists only through the prototype chain                                                | Treat file as invalid                                                         |
| Reservation creation write/rename fails                                                                   | Reject batch decision; do not start Agent                                     |
| First current-channel delivery succeeds, later segment fails                                              | Commit once using the first delivered message ID                              |
| Delivery settlement transiently fails three times                                                         | Retry from terminal cleanup; keep the logical outcome as commit               |
| Turn ends without current-channel delivery                                                                | Release once                                                                  |
| Runtime restarts with unfinished reservations                                                             | Remove reservations without changing confirmed scores, after elapsed decay    |

### 5. Good / Base / Bad Cases

**Good**

- Alice sends ordinary messages, Bob sends a self-mention, and Carol sends the final batch message. All three base scores update, Bob wins, one random sample runs, one reservation belongs to Bob, and the Agent marker remains Carol's final input.
- A two-segment reply sends the first segment successfully and the second fails. The first real message ID confirms the recorded cost exactly once.
- A persisted score of 12 at `t0` loads at `t0 + 600s` as 6, while an unfinished reservation is removed without subtraction.

**Base**

- A legacy routing engine receives the same debounce snapshot and Core calls `decide()` in order, preserving prior behavior.
- A message-only batch plugin ignores the optional Event extension and continues receiving only Messages.
- A valid platform user ID named `toString` is stored as an own author key rather than resolving `Object.prototype.toString`.

**Bad**

- Sampling once per input and OR-ing the results in highest-candidate mode.
- Adding mention, quote, direct, and poke gains together or persisting them into base score.
- Treating `tool.done.ok` as delivery; partial delivery can return a failed tool result after a real message was already sent.
- Using `authorId in authors` for reservation ownership.
- Caching a rejected settlement Promise forever, which leaves the author blocked until Runtime recreation.
- Validating an unused willingness block while routing is selected, which breaks the rollback switch.

### 6. Tests Required

- Exact ordinary-message scores/probabilities for the approved 1–5 profile and approximately 81% for each first strong signal.
- Multiple inputs in one batch call the random source once and start at most one deferred turn.
- Mixed authors update independently; highest candidate wins; latest input remains the Agent marker.
- Directed signals use max and do not persist; image, `@all`, `@here`, other-user quote, and missing-author quote equal ordinary input.
- Keyword NFKC/case normalization and quote/reply exclusion.
- Typed poke actor/target extraction and message → poke → message one-timer ordering.
- Strict 600-second half-life, out-of-order timestamps, reload decay, and reservation recovery.
- SelfId and conversation isolation, valid prototype-shaped own keys, unsafe-key rejection, timestamp-pair validation, and own-property reservation ownership.
- Atomic temp write/rename failure leaves the previous snapshot and prevents Agent start.
- First/partial/multiple delivery commit, silent/all-failed/cross-channel/zero-ID/failed/aborted/consume/start release, transient settlement retry, and idempotent repeated settlement.
- Routing, default Will, single-input willingness, message-only batch plugin, non-poke Event, `messenger.post()`, media, archive, and command-bypass regressions.

### 7. Wrong vs Correct

#### Wrong

```ts
for (const input of batch) {
  if ((await will.decide(input, state)) === "trigger") trigger = true;
}

if (toolDone.result.ok) commitReplyCost();

if (reservation.authorId in bot.authors) commit();

tracker.settlement ??= settleWithRetry(); // a rejected Promise is retained forever
```

#### Correct

```ts
const decision = await will.decideBatch?.(batch, state); // one winner, one sample
if (decision?.decision === "trigger") {
  agent.run(batch.at(-1)!, { ifBusy: "defer" });
}

onDelivered(({ turnId, channelId, messageId }) => {
  if (channelId === currentChannel && messageId) commit(turnId, messageId);
});

if (Object.hasOwn(bot.authors, reservation.authorId)) commit();

const active = tracker.settlement;
if (active) await active.catch(() => undefined);
if (!tracker.settled) await settleWithFreshBoundedRetry();
```

This separation keeps policy scoring, debounce boundaries, Agent lifecycle, platform delivery, and durable accounting independently testable while preserving legacy paths.
