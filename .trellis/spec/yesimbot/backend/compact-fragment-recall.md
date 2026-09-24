# Compact Fragment Persistence and Recall

## Contract

- The conversation JSONL files are the canonical source for messages and compact entries. A compact entry is an independent summary of only the raw messages after the latest compact boundary. Never pass an older compact summary back into a later compaction request.
- Compaction input renders each included message with its source time in `Asia/Shanghai` (`YYYY-MM-DD HH:mm`), preferring the message timestamp and falling back to the JSONL-entry timestamp only for legacy/invalid records. The prompt must preserve the time a fact or event happened; a compact-entry creation time is not evidence of an event time.
- New compact entries may carry `firstEntryId`, `lastEntryId`, `parentCompactId`, `lineageId`, `startAt`, and `endAt`. These fields are optional so legacy JSONL stays readable. When metadata is absent, use the compact-entry ID as a conservative lineage fallback and the entry timestamp as the time bound; never fabricate timestamps inside an old summary.
- `session.compact.inlineFragments` is a positive integer with default `3`. The newest N compact fragments in the active session are projected into model history. Older fragments are indexed in the Core-owned `yesimbot_compact_fragment` table. The index is rebuildable from JSONL and upserts by compact-entry ID.
- The index is isolated by the exact `deriveChannelKey()` value. Recall further requires the active session's latest compact lineage and follows only the `parentCompactId` ancestor chain from that anchor; source end time is an additional past-time bound, not a substitute for ancestry. Switching sessions must not expose later fragments from another session branch even when source timestamps tie or move backward.
- Recall uses bounded lexical overlap only, selects at most three fragments, excludes IDs already resident in the request, and returns no fallback corpus on a miss. Label known source times as source ranges; if a legacy fragment has only its compact-entry time, label it as record time (not event time). Escape both resident and recalled summaries inside explicit read-only tags. Keep the read-only recall block request-only: do not append it to JSONL, make it look like a new user message, or feed it to compaction.
- A database read, overflow write, or index-rebuild failure is best-effort and must not block a normal model request or delivery. A channel reset is different: remove that exact channel's index rows successfully before deleting its JSONL or resources. If deletion fails, reset fails and source data remains.
- `archive(false)` preserves recent compact fragments and uncovered raw tail entries while continuing their lineage. `archive(true)` starts an empty session without compact anchors; the next compact starts an independent lineage. Old archived JSONL remains available if a user switches back to it.
- Preserve the fixed provider-reported `inputTokens > 100,000` trigger and existing idle, FIFO, single-flight, stop, cancellation, failure-limit, and manual-compaction behavior.

## Implementation seams

- `packages/agent-runtime/src/entry.ts` — backward-compatible compact-entry metadata.
- `core/src/conversations/compact.ts` — Shanghai timestamp rendering and non-recursive compact prompt.
- `core/src/conversations/index.ts` — compaction boundary, fragment indexing/rebuild, archive/switch lifecycle.
- `core/src/conversations/fragment-store.ts` — channel-scoped database index and bounded lexical selection.
- `core/src/runtimes/channel.ts` — resident history projection and request-only recall injection before compact entries are projected away.
- `core/src/config.ts` — configurable resident-fragment count.
