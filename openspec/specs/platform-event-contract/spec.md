# platform-event-contract Specification

## Purpose

Define persisted message and non-message input contracts, their Satori-shaped resources, and committed input observation.

## Requirements

### Requirement: Split Persisted Input Contract
Core MUST persist ordinary channel messages as `yesimbot.message` and non-message channel events as `yesimbot.event`. Messages MUST contain only the versionless host-owned message contract fields, including `elements` and `messageId`. Events MUST contain a versionless closed host-owned event base with `eventType` and frozen `text`, plus the flat declaration-merged variant fields for that `eventType`.

#### Scenario: Input custom type is selected
- **WHEN** Core commits an ordinary message or a non-message event
- **THEN** it MUST use the corresponding custom type
- **AND** it MUST NOT use nested `message`, payload `content`, or payload `type` as a discriminant

#### Scenario: Event variant is extended through declaration merge
- **WHEN** a platform adapter declaration-merges a new event variant into `EventMap`
- **THEN** persisted `yesimbot.event` payloads for that variant MUST contain the closed host event base fields plus the declaration-merged variant fields
- **AND** they MUST NOT inherit arbitrary `Universal.Event` resources by default

### Requirement: Satori-Shaped Input Resources
Core MUST keep using current Satori-shaped resources where they are explicitly part of the host ingress contract, and it MUST NOT introduce parallel Source, Scope, or Sender models. Core MUST NOT rely on inherited `Universal.Event` structure to carry optional platform resources into persisted ingress records.

#### Scenario: A message is persisted
- **WHEN** Core creates a current Message
- **THEN** it MUST preserve the message contract's structured resources and source elements while storing timestamp only on the Agent custom message
- **AND** it MUST NOT persist unrelated `Universal.Event` resources unless the message contract explicitly includes them

#### Scenario: An event is persisted
- **WHEN** Core creates a current Event
- **THEN** it MUST preserve the closed host event base and the declaration-merged variant fields for that event type
- **AND** it MUST NOT persist unrelated `Universal.Event` resources unless the event contract explicitly includes them

### Requirement: Typed Poke Identity

The `notice.poke` variant MUST expose optional `actorId` and required `targetId`. OneBot MUST populate `actorId` from `user_id` and `targetId` from `target_id`. Consumers MUST NOT infer actor or target identity from rendered `text`. Missing actor identity MUST remain representable for compatibility and MUST fail closed for willingness batch admission.

#### Scenario: OneBot targeted poke

- **WHEN** OneBot translates a poke notice with `user_id` and `target_id`
- **THEN** the persisted Event MUST contain their string forms as `actorId` and `targetId`
- **AND** it MUST not retain raw `_data`

### Requirement: Committed Input Observation
Core MUST emit `yesimbot/event` after durable append and before Will evaluation for either input variant.

#### Scenario: Current input is observed
- **WHEN** a Message or Event is appended
- **THEN** observers MUST receive the committed input and a throwing observer MUST not undo persistence or prevent Will evaluation
