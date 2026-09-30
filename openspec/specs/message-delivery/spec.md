# message-delivery Specification

## Purpose
Define Messenger-owned passive and active delivery, pacing, and producing-runtime failure feedback.

## Requirements

### Requirement: Messenger-Owned Passive Delivery
Messenger MUST call the originating `Session.send()` for each ChannelRuntime output. Runtime and Agent code MUST NOT receive a Session or Session-bound send capability. A segment MUST be delivered as an ordered element list. One assistant message MAY produce multiple ordered segments, and Messenger MUST send them in produced order.

#### Scenario: Runtime yields output
- **WHEN** Messenger receives a ChannelRuntime output
- **THEN** it MUST send each segment through the active Session without waiting for the full turn

#### Scenario: Structured output is delivered
- **WHEN** a segment contains structured platform elements
- **THEN** Messenger MUST preserve the element structure and MUST NOT flatten it to text

### Requirement: Active Messenger Post Delivery
When `messenger.post()` starts a turn, Messenger MUST consume its sole output iterable and send each ordered segment through the current Bot matching the EventRecord's `platform` and `selfId`. It MUST call `Bot.sendMessage()` with the EventRecord channel ID and MUST NOT require or fabricate a Session.

#### Scenario: Posted turn yields output
- **WHEN** an active post yields one or more assistant segments
- **THEN** Messenger MUST send all segments through the matching Bot in produced order

#### Scenario: Posted turn joins active work
- **WHEN** a post joins an active turn
- **THEN** Messenger MUST NOT consume a second output iterable or send a duplicate reply

### Requirement: Ordered Pacing And Cancellation
Messenger MUST apply configured bounded pacing between segments, derive pacing from visible text, check cancellation before delay and send, stop on cancellation, and stop after the first send rejection. It MUST not retry, recall, or edit already delivered segments.

#### Scenario: Middle segment fails
- **WHEN** the second segment of a four-segment reply rejects
- **THEN** Messenger MUST not send the third or fourth segment
- **AND** it MUST not retry the failed segment

#### Scenario: Turn is cancelled
- **WHEN** the producing runtime aborts delivery after the first segment
- **THEN** Messenger MUST stop at the current segment boundary without failure feedback for cancellation

### Requirement: Durable Delivery Failure Feedback
A rejected passive or active send MUST call `fail()` on the producing ChannelRuntime. The runtime MUST append exactly one same-channel `yesimbot.event` with `eventType: "delivery.failed"`, frozen failure text, turn/message identity, segment position, total count, and sanitized error data. Messenger MUST NOT call `post()` for this feedback, and later channel work MUST continue.

#### Scenario: Passive output fails
- **WHEN** `Session.send()` rejects
- **THEN** Messenger MUST route one failure EventRecord through the producing runtime
- **AND** it MUST not recursively create another failure

### Requirement: Empty Turn Delivers Nothing
When a producing runtime yields no renderable output, Messenger MUST send no platform message and MUST emit no delivery-failure record.

#### Scenario: Turn has no renderable output
- **WHEN** the producing runtime completes without a deliverable segment
- **THEN** Messenger MUST not call a platform send API

### Requirement: Current-Bot Send Tool
Core MUST provide the Agent's current-Bot send tool with an explicit channel ID. A resolved `Bot.sendMessage()` string array, including an empty array, MUST count as successful tool completion; a rejected send MUST surface as an error to the tool.

#### Scenario: Platform returns an empty ID list
- **WHEN** `Bot.sendMessage()` resolves with an empty array
- **THEN** the tool MUST report successful completion with zero delivered IDs

### Requirement: Delivery-Confirmed Will Reservation

Tool completion MUST NOT by itself confirm a willingness reservation. Core MUST confirm only on the first `send_message.onDelivered` callback for the producing turn, current conversation channel, and a non-empty platform message ID. At least one successful segment commits even when a later segment fails. Empty ID arrays, all-failed sends, cross-channel delivery, and model text without a send MUST leave the turn unconfirmed so its terminal path releases the reservation.

#### Scenario: Partial send

- **WHEN** the first segment returns a platform message ID and a later segment fails
- **THEN** Core MUST commit the reservation exactly once using the first ID

#### Scenario: Successful tool with zero IDs

- **WHEN** `send_message` completes with an empty message ID array
- **THEN** Core MUST release the reservation at turn completion

### Requirement: Resource source preparation before delivery
Core MUST prepare recognized `asset://`, `artifact://`, and `workspace://` sources in `img` and `file` elements before passive Gateway delivery, autonomous Bot delivery, or the current-Bot active send tool reaches a platform adapter. Core MUST resolve each source within the producing channel scope, validate its media and delivery limits, and materialize only a representation supported by that platform. Core MUST preserve unrecognized structured elements without URI recovery or an element whitelist.

#### Scenario: Passive output sends a workspace image
- **WHEN** an assistant segment contains `<img src="workspace:///images/chart.png"/>`
- **THEN** Core MUST resolve the current channel workspace file before `Session.send()`
- **AND** it MUST send a platform-supported structured image element rather than `workspace://`

#### Scenario: Active send uses an artifact image
- **WHEN** the current-Bot active send tool sends content containing `<img src="artifact://mcp_screenshot/019d3b7e-1bd0-7e4f-9c5d-5bf3fd41f1d4"/>`
- **THEN** Core MUST prepare that source through the same resolver path used for passive delivery

### Requirement: Active send resource-source guidance
The Core `sendMessage` tool description MUST state that `img` and `file` source attributes may use an existing channel `asset://`, `artifact://`, or `workspace://` URI. It MUST state that Core resolves those sources before platform delivery. The description MUST NOT imply that `sendMessage` reads `skill://` or arbitrary host paths.

#### Scenario: The Agent prepares an active attachment send
- **WHEN** the Runtime exposes the current-Bot `sendMessage` tool
- **THEN** its description MUST identify the three supported source schemes
- **AND** it MUST identify Core as the delivery-time resolver

#### Scenario: A referenced output resource is unavailable
- **WHEN** Core cannot resolve one recognized resource source in an output segment
- **THEN** Core MUST omit only that unavailable media reference
- **AND** it MUST preserve sibling output content and record a safe diagnostic without a host path, source URL, or raw bytes

### Requirement: Fresh Terminal Settlement Retry
Core MAY cache one in-flight reservation settlement Promise, but MUST clear a rejected settlement so terminal cleanup can make a fresh bounded retry. A delivery-confirmed commit outcome MUST remain the terminal retry outcome even when the turn later reports failure.
#### Scenario: Delivery-time settlement exhausts transient retries
- **WHEN** the first current-channel delivery is real but its immediate bounded settlement attempts all reject transiently
- **THEN** terminal cleanup MUST make a fresh bounded commit attempt rather than reusing the rejected Promise
- **AND** it MUST NOT convert the confirmed delivery into a release
