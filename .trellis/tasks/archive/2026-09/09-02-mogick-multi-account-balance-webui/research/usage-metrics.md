# Usage Token and Cache Metrics Research

Date: 2026-09-02

## Current Evidence

### Mogick Proxy

- Chat requests are always converted upstream to SSE with `stream_options.include_usage=true`.
- For non-stream clients, `aggregateSSE()` already captures the last `j.usage` object and returns it in the OpenAI-compatible response.
- For stream clients, the current implementation decompresses and pipes the response directly, so it does not inspect or persist the final usage chunk.
- Therefore accurate service-side metrics require a lightweight SSE pass-through parser/tee for streamed responses.

### NewAPI

The active NewAPI log schema already has fields for:

- `prompt_tokens`
- `completion_tokens`
- `input_tokens_total`
- `cache_read_tokens`
- `cache_write_tokens`
- `cache_write_tokens_5m`
- `cache_write_tokens_1h`
- channel/model/request timing fields

A real row for channel 59 confirmed that NewAPI receives prompt and completion token counts. However, NewAPI sees channel 59 as one upstream channel and cannot know which internal Mogick account or Resin sticky identity served a request. Mogick therefore needs its own metrics store for account-level attribution.

NewAPI's parser also demonstrates that compatible upstreams may report cached tokens in several locations, including:

- `usage.prompt_tokens_details.cached_tokens`
- `usage.input_tokens_details.cached_tokens`
- `usage.cached_tokens`
- provider-specific choice-level usage

## Recommended Event Schema

Persist metadata only:

- event ID and timestamp
- client/request ID if available
- Mogick account ID and label snapshot
- model
- stream flag
- HTTP/upstream result category
- latency and optional first-token latency
- prompt/input tokens
- completion/output tokens
- total tokens
- cached input tokens
- optional cache-write token categories when returned
- cache rate derived from cached input / input
- Resin sticky account ID and optional sanitized node identifier
- completion state: completed, upstream_error, client_cancelled, usage_missing

Explicitly exclude prompts, generated text, tool calls/arguments, OAuth tokens, management tokens, proxy credentials, and raw authorization headers.

## Streaming Collection

Implement an SSE transform that:

1. forwards bytes immediately without waiting for the whole response;
2. keeps only an incomplete-line buffer;
3. parses `data:` JSON events opportunistically;
4. records the latest valid usage object;
5. finalizes one usage event on normal end, upstream error, or client cancellation;
6. never retries or replays after client output starts.

Non-stream aggregation should use the same usage normalization function to keep metrics consistent.

## Storage Recommendation

Use SQLite under `/data` for request-level metrics and aggregates. It provides indexed time/account/model queries and safer concurrent updates than rewriting JSON history. OAuth credential files can remain per-account atomic JSON files, keeping high-value secrets separate from analytics data.

Recommended indexes:

- timestamp
- account ID + timestamp
- model + timestamp
- result + timestamp

Recommended dashboard defaults:

- last 24 hours
- last 7 days
- last 30 days
- custom range

## Remaining Product Decision

Choose whether request-level metadata is retained for a bounded period (recommended 30 days with longer-lived daily aggregates), aggregates only, or indefinitely. This affects drill-down capability, disk growth, and operational privacy.
