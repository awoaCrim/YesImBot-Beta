# channel-will-evaluation Specification

## Purpose

Define default passive participation, optional third-party Will capabilities, reservation settlement, and the trusted active-post bypass. The bundled routing/willingness policy plugin has been removed; its scoring, decay, keyword, and persistence settings are not Core configuration.

## Requirements

### Requirement: Fixed Core Will Selection

Core MUST provide one fixed default WillEngine. Without a matching WillPlugin, a new ChannelRuntime MUST use that default. The default MUST trigger direct messages and explicit current-Bot mentions, and MUST wait for ordinary shared messages and non-message Events. Quotes, images, @all/@here, and mentions of other Bots MUST NOT independently trigger the default.

#### Scenario: No Will plugin matches

- **WHEN** Core creates a Runtime without a matching WillPlugin
- **THEN** the fixed default MUST trigger a direct message or explicit current-Bot mention and wait for other ordinary shared inputs

### Requirement: Optional Will Capabilities

`WillEngine.decide(input, state)` remains required. Core MAY consume these optional capabilities without requiring single-input engines to change:

```ts
interface WillEngine {
  decide(input: Message | Event, state: WillState): Awaitable<"wait" | "trigger">;
  decideBatch?(inputs: readonly MessageBatchInput[], state: WillState): Awaitable<WillBatchDecision>;
  settleReservation?(reservationId: string, outcome: WillReservationOutcome): Awaitable<void>;
  observe?(result: TurnResult): Awaitable<void>;
}
```

Core MUST retain registration, priority selection, scope matching, disposal, and the existing ordered decide path. Removing a bundled implementation MUST NOT remove these third-party extension contracts or historical decision/debug records.

#### Scenario: Engine omits batch methods

- **WHEN** a third-party WillEngine implements only `decide()`
- **THEN** Core MUST continue calling that method in the existing ordered path

### Requirement: Default Will and Debounce

Ordinary messages MUST retain their configured trailing-edge debounce. A batch MUST keep its existing per-input decision ordering and addressed-trigger request selection. Under the default Will engine, non-message events MUST NOT enter or refresh the message batch timer merely because a controller supports targeted poke.

#### Scenario: Mention followed by ordinary chatter

- **WHEN** a debounce batch contains a triggering current-Bot mention followed by an ordinary shared message
- **THEN** Core MUST still trigger from the addressed request rather than silently replacing it with the waiting chatter

### Requirement: Optional Reservation Settlement

When an optional engine returns a reservation, Core MUST correlate it with the deferred turn. The first current-conversation send_message.onDelivered carrying a non-empty platform message ID MUST commit it. Partial delivery commits. Cross-channel delivery, zero IDs, tool success without delivery, or model text alone MUST NOT commit.

Terminal done without delivery, failed, aborted, consume failure, and start failure MUST release. Repeated or late settlement MUST preserve the existing idempotency and delivery-first behavior. The optional engine owns its state/persistence; Core MUST NOT introduce a bundled willingness state store.

#### Scenario: Turn completes silently

- **WHEN** a reserved turn reaches its terminal state without a current-conversation delivery ID
- **THEN** Core MUST release the reservation

### Requirement: Active Post Bypass

`ctx.yesimbot.messenger.post()` MUST bypass Will decisions and reservations while retaining the normal FIFO, Agent, tool, delivery, and archive paths. Passive policy retirement MUST NOT remove schedule/plugin-initiated active notifications or weaken their independent delivery permissions.

#### Scenario: Trusted active post

- **WHEN** an authorized caller invokes messenger.post() with triggering enabled
- **THEN** Core MUST start the active path without calling decide() or decideBatch()

### Requirement: Explicit Retirement Boundary

Existing deployments MUST explicitly remove old will-policy configuration and dependencies before activation. Source changes MUST NOT silently rewrite operator configuration, delete willingness state, or pretend that an existing Runtime snapshot has already switched engines.

#### Scenario: Old configuration remains

- **WHEN** setup detects an enabled, disabled, cloned, or nested retired plugin entry or application dependency
- **THEN** setup MUST stop with a migration hint before changing application files or installing/starting the application
