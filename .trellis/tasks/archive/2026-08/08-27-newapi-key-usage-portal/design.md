# Design: Public API-Key Usage Portal

## 1. Architecture and boundaries

The feature is integrated into the existing `public-api` Go application and embedded React frontend.

```text
Anonymous browser at /key-usage
  -> API Key kept in page memory
  -> dedicated tokenPortalHttp client (Authorization: Bearer <key>)
  -> TokenAuthReadOnly + CriticalRateLimit + DisableCache
  -> controller reads context token_id only
  -> bounded model queries against Token and LOG_DB
  -> allow-listed token-facing DTOs
  -> overview / trend / model breakdown / paginated request logs
```

There is no separate service, Root credential, account login, database table, or deployment unit.

## 2. Backend API contracts

### 2.1 Existing token metadata

Keep `GET /api/usage/token/` unchanged and use it as the initial Key validation and quota request.

Authentication: `TokenAuthReadOnly`.

The frontend uses its existing fields for Key name, granted/used/available quota, unlimited status, model limits, and expiry.

### 2.2 Token Usage Analysis

Add:

- `GET /api/usage/token/analysis`
- `GET /api/usage/token/analysis/options`

Middleware:

- `TokenAuthReadOnly`
- `CriticalRateLimit`
- `DisableCache`
- existing CORS behavior may remain, although the page is same-origin

`analysis` query parameters:

- `start_timestamp`, `end_timestamp`
- `page`, `page_size`
- optional `model_name`

The controller must ignore or reject administrative filter parameters such as `user_id`, `token_id`, and `channel_id`. The effective Token ID always comes from `c.GetInt("token_id")`.

Limits match the existing Root analysis contract:

- default range: 24 hours at the API boundary; the UI explicitly sends today's range
- maximum range: 90 days
- query timeout: 15 seconds
- default page size: 20
- maximum page size: 100

Response data:

```text
start_timestamp, end_timestamp, bucket_seconds,
page, page_size, total,
summary: UsageAnalysisMetrics,
rows: [{ model_name, ...UsageAnalysisMetrics }],
trend: [{ timestamp, ...UsageAnalysisMetrics }]
```

The model query is Token-scoped and groups the breakdown only by `model_name`. It reuses the existing aggregate expression, cache-rate finalization, bounded summary/count/page/trend pattern, and ClickHouse bucket expression. It does not resolve or return users, Token IDs/names, or channels.

`options` returns only distinct model names used by the current Token in the bounded recent analysis window. It never returns global user/Token/channel options.

### 2.3 Paginated Token request logs

Preserve legacy `GET /api/log/token` for compatibility and add:

- `GET /api/log/token/page`

Query parameters:

- `p`, `page_size`
- optional `type`, `model_name`
- optional `start_timestamp`, `end_timestamp`
- optional `request_id`, `upstream_request_id`

Apply the same 90-day maximum range, maximum page size 100, and 15-second timeout. The caller can traverse all retained history by selecting successive legal ranges and pages; the API never returns an unbounded array.

The model query uses `LOG_DB`, filters the context Token ID, excludes `LogTypeCodeAgent`, uses existing ClickHouse ordering behavior, and performs count plus page fetch.

The API returns a dedicated allow-listed DTO. Allowed fields are:

- `created_at`, `type`, `content`, `model_name`
- `quota`, `prompt_tokens`, `completion_tokens`
- `cache_read_tokens`, `cache_write_tokens`, `cache_write_tokens_5m`, `cache_write_tokens_1h`, `input_tokens_total`
- `use_time`, `is_stream`, `group`
- `request_id`, `upstream_request_id`
- sanitized `other`

It must not serialize:

- `user_id`, `username`
- `token_id`, `token_name`, API Key material
- `channel`, `channel_name`
- `ip`
- `other.admin_info`, `other.audit_info`
- request snapshots, request bodies, or response bodies

## 3. Authentication and error behavior

`TokenAuthReadOnly` remains authoritative:

- invalid or disabled Key -> 401
- banned user -> 403
- expired or exhausted but not disabled -> historical read is allowed

Controllers use safe API envelopes for validation/query failures. Database driver details and authorization values are never returned or logged.

The public frontend does not use the dashboard Axios instance because that client injects session access tokens and redirects 401 responses to `/sign-in`. A feature-local Axios instance:

- has same-origin base URL
- does not read the auth store
- does not refresh browser sessions
- does not redirect on 401/403
- sends the API Key only in the per-request Authorization header
- treats API errors as page-local states

## 4. Frontend structure

Add `web/src/routes/key-usage.tsx` and `web/src/features/key-usage/`.

Suggested feature structure:

```text
features/key-usage/
  api.ts
  types.ts
  index.tsx
  components/
    api-key-entry-card.tsx
    key-usage-header.tsx
    token-quota-summary.tsx
    token-model-breakdown.tsx
    token-request-log-table.tsx
    token-request-log-details.tsx
  lib/
    filters.ts
    query-session.ts
```

### 4.1 Entry state

- Render with `PublicLayout`; no account session is required.
- API Key input uses password semantics with an optional reveal control.
- Submission first calls the existing token metadata endpoint.
- On success, retain the Key in React memory and create a random/non-secret query-session nonce.
- Never put the Key in route search params, global auth store, storage, Query keys, error text, toast text, or logs.
- “Change API Key” removes all `key-usage` queries, clears all displayed data and Key state, and returns to the entry card.
- Page reload naturally loses the Key.

### 4.2 Dashboard presentation

After validation, show two primary sections/tabs:

1. **Usage Overview**
   - quota status
   - existing Usage Analysis summary visual language
   - hourly trend
   - model-only breakdown and pagination
   - shared date/model filters

2. **Request Records**
   - time/type/model/request-ID filters
   - paginated allow-listed log table
   - lightweight Token-safe detail dialog

Reuse `UsageAnalysisOverview` and `UsageAnalysisTrend` where their contracts are generic. If the overview scope caption requires adaptation, change it through a backward-compatible presentation prop used by both Root and Token pages. Do not reuse the Root breakdown.

Do not directly reuse the authenticated full Usage Logs details dialog: it reads dashboard role state and can surface Root-only Request Snapshot controls. The Token page owns a smaller allow-listed details view and may reuse only pure formatting helpers and generic visual components.

## 5. Cache and cross-Key isolation

React Query keys use `['key-usage', sessionNonce, ...]`, never the Key. The nonce changes whenever a Key is accepted.

On Key clear/change/unmount:

- cancel in-flight `key-usage` queries
- remove `key-usage` query cache
- clear selected log/details state
- clear Key and Token metadata state

Late responses from a prior nonce must not render into the active session.

## 6. Compatibility and migration

- No database schema migration.
- Existing Root Usage Analysis routes and payloads remain unchanged.
- Existing `/api/log/token` response remains unchanged for compatibility.
- New queries use GORM and existing database/ClickHouse helpers so SQLite, MySQL, PostgreSQL, and optional ClickHouse remain supported.
- Existing protected project branding and public API behavior are preserved.

## 7. Testing strategy

### Backend

- Model tests: Token isolation, model-only aggregation, summary/trend correctness, pagination, range/page bounds, empty data, Code-Agent exclusion, and sanitized `other`.
- Controller tests: context Token ID overrides malicious query IDs; response DTO omits every prohibited field; invalid range and timeout map safely.
- Router tests: public Token endpoints require `TokenAuthReadOnly`, use rate limiting/no-cache, and do not accept dashboard-only auth as a substitute for the submitted API Key.
- Preserve all existing Root Usage Analysis and legacy Token log tests.

### Frontend

- Public route renders without an authenticated user.
- API client sends the supplied Key and does not use/overwrite it with dashboard access tokens.
- 401/403 remains in-page and never redirects to `/sign-in`.
- Key never appears in query keys or browser storage.
- Key change/clear removes previous cached data and ignores late responses.
- Usage filters, trend, model pagination, log filters/pagination, loading/empty/error states work.
- DOM never renders request/response body, IP, user/Token/channel identifiers, or Request Snapshot controls.

## 8. Deployment and rollback

Build and deploy the existing application image only after implementation checks pass and the reviewed changes are committed.

Deployment sequence:

1. archive the exact reviewed commit;
2. create a consistent SQLite backup and save Compose/environment/image metadata without printing secrets;
3. build a uniquely tagged image before cutover;
4. update only the `newapi` service image and recreate that service;
5. require container health, `/api/status` HTTP 200 with `success=true`, `/key-usage` HTML delivery, and expected frontend asset/route evidence;
6. verify unauthenticated Token API rejection without printing a Key;
7. inspect bounded startup logs;
8. restore the saved Compose/image/database state if any gate fails.
