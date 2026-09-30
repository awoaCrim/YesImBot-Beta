# durable-willingness-state Specification

## Purpose

Define the atomic per-conversation store for confirmed willingness and unfinished reply-cost reservations.

## Requirements

### Requirement: Versioned Namespaced State

Persistent willingness MUST use `<ChannelResources.path>/willingness.json` with `version: 1`. The file MUST contain independent Bot namespaces keyed by `selfId`; each Bot contains author state and reservations. Author state MUST contain confirmed score, last message time, and last decay time.

#### Scenario: Two Bots share one conversation resource path

- **WHEN** state exists for two `selfId` values in one willingness file
- **THEN** each Bot MUST read and mutate only its own namespace

### Requirement: Serialized Atomic Mutation

Every mutation MUST run through one Promise tail per file path. The store MUST clone and validate the complete next snapshot, write a unique sibling temp file with exclusive creation, atomically rename it over the destination, and update its in-memory snapshot only after rename succeeds. Temp files MUST be removed in `finally`.

#### Scenario: Rename fails

- **WHEN** publishing a mutation fails before atomic rename completes
- **THEN** the previous destination and in-memory snapshot MUST remain readable and unchanged

### Requirement: Reservation Representation

A pending reservation MUST record immutable ID, author ID, amount, creation time, and source input IDs. At most one pending reservation may own an author. Pending amount MUST reduce available score without modifying confirmed score.

Commit MUST subtract the recorded amount from the current confirmed score and delete the reservation. Release MUST only delete it. A missing reservation on repeated commit/release MUST be a no-op.

#### Scenario: Settlement is repeated

- **WHEN** Core repeats commit or release for an already-settled reservation ID
- **THEN** the store MUST leave confirmed score and reservations unchanged

### Requirement: Recovery

On Runtime creation after restart/reload, the engine MUST load the matching `selfId`, apply configured decay from stored real timestamps, and atomically delete unfinished reservations without subtracting their amount. Recovery of one Bot namespace MUST not alter another namespace.

#### Scenario: Restart finds an unfinished reservation

- **WHEN** Runtime initialization loads a reservation that has no confirmed delivery outcome
- **THEN** recovery MUST delete that reservation without subtracting its amount

### Requirement: Safe Corruption Handling

Unknown versions, truncated JSON, non-finite/negative numbers, unsafe identifiers, invalid timestamps, duplicate reservation owners, or dangling reservation ownership MUST fail closed to controlled empty state. The plugin MUST emit a bounded warning and continue startup. A later valid mutation MAY atomically replace the invalid file.

#### Scenario: State file is truncated

- **WHEN** startup cannot parse the willingness file as a valid supported snapshot
- **THEN** the plugin MUST continue with empty controlled state and one bounded warning

### Requirement: Persistence Gate

A batch trigger MUST not be returned until the mutation containing all author accumulations and the winning reservation is durable. If persistence fails, Core MUST not start an Agent turn.

#### Scenario: Reservation publish fails

- **WHEN** the atomic persistence step rejects for a triggering batch
- **THEN** Will MUST reject the decision and Core MUST not start an Agent turn

### Requirement: Own-Key And Timestamp Integrity
Author and reservation lookup MUST use own properties rather than JavaScript prototype-chain membership. A loaded author state MUST have either two null timestamps or two finite timestamps, and `lastDecayAt` MUST NOT precede `lastMessageAt`. Prototype-mutating identifiers MUST be rejected before a mutation is published.
#### Scenario: Reservation names an inherited property
- **WHEN** a reservation author ID resolves only through `Object.prototype` and is not an own author entry
- **THEN** the snapshot MUST be treated as invalid controlled state
#### Scenario: Author timestamps are inconsistent
- **WHEN** an author has only one timestamp or has `lastDecayAt < lastMessageAt`
- **THEN** recovery MUST reject the snapshot instead of restoring an undecayed high score
