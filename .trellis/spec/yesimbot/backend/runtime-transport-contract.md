# Runtime Transport Ownership

## Scope

Read before changing runtime cache identity, Bot replacement/reconnect behavior, or captured send/tool/plugin bindings.

## Ownership contract

- Conversation identity and transport identity are separate. Channel keys and durable storage remain scoped by the existing conversation rules; a reconnect is not a new conversation.
- A cached ChannelRuntime may be reused only when its captured Bot object and captured selfId still match, and its existing agent/message/model revision checks pass.
- Same selfId does not imply the same live transport. Sandbox recreates Bot/client objects after console WebSocket closure.
- ChannelRuntime owns the binding predicate: `isBoundTo(bot: Bot): boolean`. It compares `options.bot === bot && selfId === bot.selfId`; do not expose or duplicate another mutable Bot map solely for this comparison.
- Replacement uses the existing per-key serialization: await the old Runtime stop, rebuild Core tools and registered plugins with the new Bot, initialize, then cache. Concurrent acquisition of the replacement must produce one Runtime.
- Reuse the existing Channel and conversation storage. Do not call reset, clear, archive, or delete history to refresh transport ownership.
- An unchanged Bot object/account continues using the cached Runtime. Adapters updating their own internal transport in-place are not automatically stale: tool calls invoke the retained Bot object's current methods.

## Required regression coverage

Use actual Runtimes, ChannelRuntime and send_message with mocked Agent/model and Bot transports. For direct, guild and subchannel contexts, verify:

1. Same Bot instance reuses the Runtime.
2. A new Bot instance with the same selfId replaces and stops the old Runtime.
3. Concurrent replacement acquisition returns the same new Runtime.
4. Core send_message and plugin setup use the new Bot, not the closed old one.
5. Existing session ID and stored entries survive replacement.

The conversation storage getter returns a new facade each access. Verify backing session/data rather than requiring facade reference equality.

## Live validation and delivery limits

- A live reconnect test must close one WebSocket, open another with the same platform/user/channel, then observe the Bot reply on the new client's `sandbox/message` stream.
- An input echo or RPC acknowledgement is not a Bot reply. A send_message success receipt alone is not proof that the new WebSocket received it.
- If Will chooses wait, lack of reply is expected; do not diagnose transport failure from timeout alone. Correlate admission, tool result and client observation.
- Keep the client connected until the actual reply arrives. This ownership fix does not introduce client acknowledgements or guarantee delivery if a connection closes mid-turn.
- Live tests may invoke configured models/tools. Obtain authorization, keep credentials server-side, use a test channel, and do not change Will merely to make a test pass.

## Deployment

Back up the scoped source/tests and JS/map artifacts; guard against concurrent edits. Preserve configuration, Persona/card, unrelated source and historical data. Run Core tests/type-check/build plus changed-file lint/format, and verify service health and artifact hashes after activation.
