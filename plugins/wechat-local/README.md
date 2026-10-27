# Local WeChat private-text adapter

A private Koishi adapter for an authenticated, loopback-only private-text bridge. It does not install or load a native module, restart WeChat, discover contacts, retrieve history, or start an LLM. The native module and minimal bridge must be separately reviewed and running before activation.

The current local integration is explicitly restricted to one unchanged account and one approved private contact. Account-switch-safe proprietary sending has not been established; the user-approved single-account test does not imply multi-account support. A separately reviewed single-account native build enables scoped sending, while older receive-only sessions remain receive-only. Local acceptance and synthetic tests do not prove platform delivery.

## Configuration

Load `koishi-plugin-adapter-wechat-local` with these fields:

| Field            | Required value                                                          |
| ---------------- | ----------------------------------------------------------------------- |
| endpoint         | A WS URL on 127.0.0.1, with root path and no credentials/query/fragment |
| token            | The bridge's 64-hex bearer token, stored as a secret                    |
| expectedSelfId   | The exact native account ID from the approved binding                   |
| peerId           | The exact single private contact ID from that binding                   |
| requestTimeoutMs | 100–30000 ms; default 5000                                              |

There are no account or recipient defaults. The handshake must match both configured IDs. Both http and satori services are required for correct startup and disposal. Do not expose the unencrypted loopback transport through a public proxy or port forward.

## Behavior and limits

- Only post-binding private text from the pinned contact becomes a direct Koishi session. Other contacts, groups, self echoes, malformed frames and unsupported content are rejected.
- Inbound text is literal, not parsed as Koishi markup; real numeric message IDs remain strings.
- Outbound sends reject other targets, guild context, media, mentions and quotes before transport. Text is limited to 16384 UTF-8 bytes.
- Local invocation acceptance is not platform delivery proof. The native sender supplies no confirmed message ID, so accepted/uncertain sends return an empty ID list. Core's delivery-proof rules remain unchanged.
- Sends are not automatically retried or replayed after timeout or reconnect. Connection recovery is explicit; inbound events may be lost while disconnected. There is no historical catch-up.
- The adapter itself does not log raw messages or bearer tokens. An enabled Koishi/YesImBot application may persist newly received sessions under its own storage configuration.

## Local checks

From the repository root with existing development dependencies:

```sh
node_modules/.bin/tsc --noEmit -p plugins/wechat-local/tsconfig.json
node_modules/.bin/oxlint plugins/wechat-local
node_modules/.bin/vitest run plugins/wechat-local/tests/adapter.test.ts
```

The package is private and the synthetic tests do not establish real client compatibility or confirmed message delivery.
