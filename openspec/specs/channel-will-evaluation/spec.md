# channel-will-evaluation Specification

## Purpose

Define passive participation decisions, optional whole-batch willingness, reservation settlement, and the trusted active-post bypass.

## Requirements

### Requirement: Fixed Core Will Selection

Core MUST provide one fixed default WillEngine. Without a matching WillPlugin, a new ChannelRuntime MUST use that default. The default MUST trigger direct messages and explicit current-Bot mentions, and MUST wait for ordinary shared messages and non-message Events.

#### Scenario: No Will plugin matches

- **WHEN** Core creates a Runtime without a matching WillPlugin
- **THEN** the fixed default MUST trigger a direct message and wait for an ordinary shared message

### Requirement: Optional Will Capabilities

`WillEngine.decide(input, state)` remains required. Core MAY consume these optional capabilities without requiring legacy engines to change:

```ts
interface WillEngine {
  decide(input: Message | Event, state: WillState): Awaitable<"wait" | "trigger">;
  decideBatch?(inputs: readonly MessageBatchInput[], state: WillState): Awaitable<WillBatchDecision>;
  settleReservation?(reservationId: string, outcome: WillReservationOutcome): Awaitable<void>;
  observe?(result: TurnResult): Awaitable<void>;
}
```

A routing engine, the Core default, and a third-party single-input engine MUST keep their existing ordered `decide()` behavior.

#### Scenario: Legacy engine omits batch methods

- **WHEN** a third-party WillEngine implements only `decide()`
- **THEN** Core MUST continue calling that method in the existing ordered path

### Requirement: Per-Conversation Per-Author State

Highest-candidate willingness MUST isolate state by ChannelResources path, Bot `selfId`, and author ID. Every batch input MUST update only its own author. No score may leak between conversations, Bots, or participants.

#### Scenario: Two authors share one batch

- **WHEN** two authors contribute inputs to the same conversation batch
- **THEN** each base gain MUST update only that author's state

### Requirement: Approved Batch Scoring

Highest-candidate mode MUST process the whole snapshot in chronological order using clamped input timestamps. For every accepted Message or targeted poke it MUST apply base interaction gain to confirmed state. Keyword matching MUST use NFKC, locale-independent lowercase, collapsed whitespace, and current-body text with quote/reply subtrees and persisted quote contents excluded.

Images, `@all`, and `@here` MUST receive no extra directed gain. A group quote receives `quoteGain` only when `quote.author.id === selfId`; no text/message-ID/isBot inference is allowed. A poke author MUST come from typed `actorId` and MUST target `selfId`.

Direct, current-Bot mention, self quote, and targeted poke gains MUST remain temporary. When several directed signals occur for one author, the candidate MUST use their maximum rather than their sum.

#### Scenario: Message contains several directed signals

- **WHEN** one participant directly addresses, mentions, and quotes the current Bot in the same batch
- **THEN** its candidate MUST use only the strongest configured directed gain
- **AND** confirmed state MUST not persist that temporary gain

### Requirement: Highest Candidate and Single Sampling

After accumulating every author, Will MUST compute candidate score from confirmed base minus held reservation amount plus the strongest temporary directed gain. An author with any unresolved reservation MUST be ineligible for another reservation but MUST continue accumulating base gains. Will MUST select by highest score, then latest relevant timestamp, then latest input order, and call the random source exactly once for the winner.

A batch MUST return at most one reservation and Core MUST start at most one deferred turn. No non-winning author may be charged.

#### Scenario: Two candidates exceed threshold

- **WHEN** two participants are eligible to trigger in one snapshot
- **THEN** Will MUST sample only the deterministically highest candidate
- **AND** Core MUST start at most one deferred turn

### Requirement: Strict Half-Life Mode

`decayMode: half-life` MUST use:

```text
score(t) = score(t0) × 2^(-(t - t0) / decayHalfLifeSeconds)
```

The approved profile uses `decayHalfLifeSeconds: 600`. The old hot/warm weighted decay remains the default for legacy configurations.

#### Scenario: One half-life elapses

- **WHEN** 600 seconds elapse from a score of 80 under the approved half-life mode
- **THEN** the decayed score MUST be 40 before the next gain

### Requirement: Reservation Before Start

A triggering batch MUST durably create one reservation before returning trigger. `amount` MUST be `min(replyCost, availableBase)` and creation MUST not subtract confirmed score. Persistence failure MUST prevent Agent start.

Core MUST correlate the reservation with the independent deferred turn. The first current-conversation `send_message.onDelivered` carrying a non-empty platform message ID MUST commit it. Partial delivery commits. Cross-channel delivery, zero IDs, tool success without delivery, or model text alone MUST not commit.

Terminal done without delivery, failed, aborted, consume failure, and start failure MUST release. Settlement MUST be idempotent; delivery observed before a later failing terminal event wins.

#### Scenario: Turn completes silently

- **WHEN** a reserved turn reaches its terminal state without a current-conversation delivery ID
- **THEN** Core MUST release the reservation without subtracting reply cost

### Requirement: Active Post Bypass

`ctx.yesimbot.messenger.post()` MUST bypass Will decisions and reservations while retaining the normal FIFO, Agent, tool, delivery, and archive paths.

#### Scenario: Trusted active post

- **WHEN** an authorized caller invokes `messenger.post()` with triggering enabled
- **THEN** Core MUST start the active path without calling `decide()` or `decideBatch()`

### Requirement: Legacy Configuration Compatibility

Existing willingness users MUST default to `batchDecision: per-input`, `decayMode: weighted`, and `persistState: false`. Routing MUST ignore willingness state. Switching back to routing MUST leave any willingness state file inert rather than deleting or applying it.

#### Scenario: Existing willingness configuration is loaded

- **WHEN** an existing configuration omits all new willingness options
- **THEN** it MUST retain per-input weighted in-memory behavior

### Requirement: Routing Rollback Isolation
Configuration validation for willingness-only fields MUST run only when `engine: willingness` is active. Selecting `engine: routing` MUST NOT initialize, validate, read, or mutate retained willingness state.
#### Scenario: Routing retains a stale willingness block
- **WHEN** configuration selects routing and an unused willingness block is invalid under current willingness rules
- **THEN** routing MUST still initialize and remain usable as the rollback switch
