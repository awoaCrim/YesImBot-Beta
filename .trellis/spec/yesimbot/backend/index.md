# YesImBot Backend Guidelines

> Executable contracts for the remotely maintained YesImBot v4 backend.

## Pre-Development Checklist

- Identify the affected owner: Core runtime, `yesimbot-will-policy`, platform Translator, or message-batch plugin.
- Preserve optional interfaces and legacy `routing` / single-input paths unless the task explicitly changes them.
- Read [Batch Willingness and Delivery Settlement](./willingness-batch-contract.md) before changing reply admission, willingness persistence, poke/quote metadata, or `send_message` delivery handling.
- Read [Memorizer Long-Term Memory](./memorizer-memory-contract.md) before changing memory persistence, embedding indexing, retrieval ranking, or the `remember` / `recall` / `search` tools.
- Read [Offline Persona Runtime Experiments](./persona-experiment-contract.md) before continuing persona or runtime-prompt evaluation; synthetic development results are not canon or production evidence.
- Read [QQ Message Projection](./qq-message-projection-contract.md) before changing channel-type explanations or quote/reply model rendering.
- Read [Live Persona Maintenance](./live-persona-contract.md) before changing production Persona/card text, style examples, or prompt activation.
- Read [Runtime Transport Ownership](./runtime-transport-contract.md) before changing cached Runtime identity or Bot replacement/reconnect behavior.
- Read [Provider-Reported Prompt Compaction](./provider-usage-compaction-contract.md) before changing provider usage handling or automatic session-compaction scheduling.
- Read [Compact Fragment Persistence and Recall](./compact-fragment-recall.md) before changing compact-entry metadata, overflow indexing, model-history recall, or archive/switch/reset behavior.
- Read [Automation Notification Contract](./automation-notification-contract.md) before changing `anon-notify`, the `notify-webhook` plugin, the injected event text, or the relay policy.
- Treat the remote working tree as user-owned and potentially dirty; create a scoped backup before edits and never revert unrelated changes.

## Guidelines Index

| Guide                                                                                                 | Description                                                                                                              | Status                       |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| [Batch Willingness and Delivery Settlement](./willingness-batch-contract.md)                          | Cross-layer contracts for batch admission, per-author willingness, durable reservations, and delivery settlement         | Active                       |
| [Memorizer Long-Term Memory](./memorizer-memory-contract.md)                                          | Embedding indexing, hybrid keyword/vector retrieval, `semanticUsed` truthfulness, stale-vector clearing, and backfill    | Active                       |
| [Offline Persona Runtime Experiments](./persona-experiment-contract.md)                               | Source-role labeling, frozen evidence, reproducible artifacts and judge-background requirements                          | Experimental / not deployed  |
| [QQ Message Projection](./qq-message-projection-contract.md)                                          | Actual channel types, quoted-author attribution, inline deduplication and nonmutating replay                             | Deployed                     |
| [Live Persona Maintenance](./live-persona-contract.md)                                                | Coordinated prompt/card updates, PNG integrity, example provenance and reversible activation                             | Active                       |
| [Roleplay Greeting and Image Tools Ownership](./roleplay-image-tools-contract.md)                     | Greeting seeding switch, standalone image action ownership, config migration, and guarded deployment                     | Deployed                     |
| [Historical Model-History Projection](./historical-model-history-projection-contract.md)              | Non-mutating filtering of historical output tool calls and internal control fields before model conversion               | Deployed                     |
| [Agent Message Protocol and Delivery State](./agent-message-protocol-contract.md)                     | Capability-gated tool choice, terminal-tool validation, plain-text failure, and callback-level delivery evidence         | Active / deployed 2026-09-14 |
| [Provider-Reported Prompt Compaction](./provider-usage-compaction-contract.md)                        | Fixed usage threshold, Agent-idle boundary, FIFO scheduling, and single-flight compact behavior                          | Active                       |
| [Compact Fragment Persistence and Recall](./compact-fragment-recall.md)                               | Independent compact segments, persistent overflow index, bounded channel-scoped recall, and session lifecycle            | Active                       |
| [Runtime Transport Ownership](./runtime-transport-contract.md)                                        | Bot-instance cache ownership, reconnect replacement and preserved conversation history                                   | Deployed                     |
| [Automation Notification Contract](./automation-notification-contract.md)                             | Pi event trust boundary, authoritative status, relay policy and canary verification                                      | Deployed                     |
| [MCP Client Confirmation and Secret Contract](./mcp-client-contract.md)                               | MCP transport secrets, dynamic tool catalogs, raw current messages, and pre-upstream side-effect confirmation            | Active                       |
| [Repository Development and Operations Contract](./repository-development-and-operations-contract.md) | Monorepo ownership, source/runtime boundaries, Trellis workflow, verification, migration, deployment, and rollback rules | Active                       |

## Quality Check

- Run focused Core, will-policy, and message-debounce tests in the `yesimbot-koishi` container.
- Run each affected package's TypeScript check and build rather than relying on the full monorepo gate, which may contain unrelated failures.
- Run `oxfmt --check` and `oxlint` on the task file set, plus `git diff --check`.
- Verify that production config, container start time, and restart count did not change unless deployment was separately approved.
- For root-level remote maintenance scripts, use `set -euo pipefail`; access optional Docker inspect fields through safe `index` lookups; normalize Docker `Created` timestamps to Unix epoch before numeric sorting; and pass only exact allowlisted paths or audited IDs to destructive commands.

## Operational Notes

### App-root/workspace plugin installation

- The production Koishi app root and the YesImBot source workspace have separate Yarn manifests and `node_modules` trees. A plugin link that exists only under `yesimbot-v4/node_modules` is not sufficient for Koishi loader resolution or the standard WebUI package scanner.
- When adding a managed workspace plugin, run the repository setup flow from the host environment with Git available: `node scripts/setup-koishi.mjs --app <koishi-app> --no-pull`. If the host view does not expose a container-mounted portal target, use the mounted fallback from the source workspace inside the running container: `docker exec yesimbot-koishi sh -lc 'cd /koishi/yesimbot-v4 && node scripts/setup-koishi.mjs --app /koishi --no-pull'`. In either case, verify the app-root dependency, root `node_modules` link, and app-root `require.resolve()`; then run the authoritative host-side `--check`. A container-side `--check` can fail its branch precondition when Git metadata is not mounted, and that failure does not replace the host-side resolution check.
- `setup-koishi.mjs` may add disabled placeholder entries for managed plugins that were absent from `koishi.yml`. Treat those as config mutations: compare the parsed config against the pre-change snapshot and remove setup-added unrelated stubs when strict preservation is required before recording the final rollback hash.
- For a WebUI “not installed” report, inspect the authenticated `packages` data service and the runtime loader independently. A custom panel fallback may show a configured `yesimbot-*` key as enabled even when the app-root package is missing.

### `Ignoring models.json ...` startup warnings

`ModelService.register()` calls `refreshModels()` once per provider registration, and each refresh re-validates every `models.json` override against the partially populated registry. A batch of these warnings therefore repeats during startup and disappears entry by entry as the owning provider registers. Only warnings still present in the final refresh (the one before the last `Provider registered:` line) describe real problems.

`models.json` overrides patch metadata of already-registered models; they cannot create a model. A leftover override for a model id removed from a provider's `chatModels` list produces one permanent warning per refresh and is otherwise inert. Re-enabling such a model requires adding the id back to the provider configuration.

**Language**: Keep code-spec documentation in English; preserve Chinese product terminology where it is the canonical domain term.

### Sandbox admission and testing

Stock Sandbox uses browser-local `sandbox:<random>` platform IDs. `matchesAllowedChannel` supports exact equality or full `*`, not `sandbox:*` prefix globs. For API tests prefer a fixed explicitly allowed platform (currently `sandbox:yesimbot-test`) rather than opening all adapters. The installed console RPC `sandbox/send-message` requires authority4 and returns replies via asynchronous Sandbox events. Keep its local file server disabled. Platform-scoped history does not guarantee tool or shared-memory isolation; existing group-assignee admission and Will still apply. Configuration verification must not silently dispatch a message or incur a model request.

### Sandbox admission and testing

Stock Sandbox uses browser-local `sandbox:<random>` platform IDs. `matchesAllowedChannel` supports exact equality or full `*`, not `sandbox:*` prefix globs. For API tests prefer a fixed explicitly allowed platform (currently `sandbox:yesimbot-test`) rather than opening all adapters. The installed console RPC `sandbox/send-message` requires authority4 and returns replies via asynchronous Sandbox events. Keep its local file server disabled. Platform-scoped history does not guarantee tool or shared-memory isolation; existing group-assignee admission and Will still apply. Configuration verification must not silently dispatch a message or incur a model request.

### Sandbox admission and testing

Stock Sandbox uses browser-local `sandbox:<random>` platform IDs. `matchesAllowedChannel` supports exact equality or full `*`, not `sandbox:*` prefix globs. For API tests prefer a fixed explicitly allowed platform (currently `sandbox:yesimbot-test`) rather than opening all adapters. The installed console RPC `sandbox/send-message` requires authority4 and returns replies via asynchronous Sandbox events. Keep its local file server disabled. Platform-scoped history does not guarantee tool or shared-memory isolation; existing group-assignee admission and Will still apply. Configuration verification must not silently dispatch a message or incur a model request.
