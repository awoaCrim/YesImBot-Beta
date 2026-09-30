# message-batch-admission Specification

## Purpose

Define the optional Core input-batch seam, legacy compatibility, and the trailing-edge debounce behavior used before passive Will evaluation.

## Contracts

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

export interface MessageBatchPlugin {
  readonly priority: number;
  match(context: ChannelContext): boolean;
  setup(
    context: ChannelContext,
    flushMessages: (messages: readonly Message[]) => Promise<void>,
    extensions?: MessageBatchSetupExtensions,
  ): Awaitable<MessageBatchController>;
}
```

The original `enqueue(Message)` method and first two `setup()` arguments remain source-compatible. A legacy controller can ignore the extension and continue flushing Message arrays only.

## Requirements

### Requirement: Optional Per-Conversation Batching

Core MUST select at most one matching batch plugin by ascending priority and stable registration order. It MUST create one controller per cached ChannelRuntime and retire that Runtime when the registry revision changes.

#### Scenario: No plugin matches

- **WHEN** no batch plugin matches the conversation
- **THEN** ordinary input MUST keep the immediate Will path

### Requirement: Persist Before Admission

ChannelRuntime MUST persist and emit each accepted external input exactly once before attempting batch admission. A recognized Koishi command MUST bypass persistence, Will, and debounce before channel resolution.

#### Scenario: Unknown command-like text

- **WHEN** Commander does not resolve a message as a command
- **THEN** Messenger MUST admit it as an ordinary Message

### Requirement: Legacy Message Flush

When the selected Will has no `decideBatch()`, Core MUST preserve the legacy ordered per-Message `decide()` loop. One rejection MUST be logged and treated as wait without suppressing later messages. Any trigger starts at most one deferred turn from the latest eligible Message.

#### Scenario: Third-party single-input Will

- **WHEN** a legacy controller flushes three Messages to a Will that only implements `decide()`
- **THEN** Core MUST call `decide()` once per Message in order and start at most one turn

### Requirement: Batch-Aware Flush

When the selected Will implements `decideBatch()`, Core MUST validate pending input identity, call `decideBatch()` once with the whole ordered snapshot, and MUST NOT call single-input `decide()` for those inputs. A trigger MUST start exactly one turn from the snapshot's final input with `ifBusy: "defer"`; candidate identity is only for Will scoring and reservation ownership.

#### Scenario: Highest candidate is not the latest input

- **WHEN** an earlier participant has the highest candidate score and a later participant supplied the final input
- **THEN** Will MUST report the earlier participant as candidate
- **AND** Core MUST still use the final input as the Agent marker

### Requirement: Targeted Poke Admission

Core MAY call `enqueueEvent()` only when the selected Will implements `decideBatch()`. The debounce controller MUST accept only `notice.poke` with a non-empty typed `actorId`, `targetId === selfId`, and an available `flushInputs` extension. Rejected Events MUST NOT enter the queue or refresh its timer.

#### Scenario: Message, poke, Message

- **WHEN** a Message, a valid targeted poke, and another Message arrive inside one quiet window
- **THEN** they MUST flush as one ordered snapshot after one trailing edge

#### Scenario: Invalid poke

- **WHEN** actor identity is missing or the target is not the current Bot
- **THEN** the controller MUST return false without refreshing the timer

### Requirement: Snapshot and Stop Safety

Timeout MUST detach the current snapshot before starting its async flush. Duplicate/stale snapshots MUST not receive another Will decision. Runtime/plugin stop MUST cancel timers, clear pending references, and prevent stale callbacks from starting a turn.

#### Scenario: Runtime stops during batch evaluation

- **WHEN** stop occurs after a triggering batch creates a reservation but before Core starts the turn
- **THEN** Core MUST release the reservation
- **AND** it MUST not start the turn

### Requirement: Immediate Path Exclusions

Non-poke Event inputs, scheduled internal Events, and trusted `messenger.post()` calls MUST retain their existing immediate paths. Only an explicitly accepted poke Event can join the debounce snapshot.

#### Scenario: Non-poke Event arrives

- **WHEN** a non-poke Event is admitted while message debounce is active
- **THEN** it MUST bypass the batch controller and retain immediate Will handling
