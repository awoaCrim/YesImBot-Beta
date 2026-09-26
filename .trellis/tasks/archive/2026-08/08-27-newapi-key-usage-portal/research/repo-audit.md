# Repository Audit: Public API-Key Usage Portal

## Target and deployment

- Authoritative repository: `G:/Users/admin/Desktop/code/public-api`.
- Existing production target: SSH alias `ssh2`, Compose root `/opt/newapi`, SQLite-backed New API container.
- Deployment contract: `public-api/.trellis/spec/backend/deployment-guidelines.md` requires an exact committed archive, unique image tag, Compose/image/database backup, application-service-only recreation, `/api/status` verification, served-asset verification, and rollback on failure.
- The repository currently has unrelated untracked `.trellis/workspace/pi/`; it must not be modified or included in product commits.

## Existing token authentication

- `middleware/auth.go:TokenAuthReadOnly` reads `Authorization`, accepts Bearer format, normalizes `sk-` and routing suffixes, resolves the token, rejects disabled tokens and banned users, and writes `id`, `token_id`, and `token_key` into Gin context.
- Expired or exhausted tokens remain able to read historical data unless explicitly disabled. This is intentional read-only behavior.
- Route handlers must use the context `token_id`; accepting a caller-provided token/user identifier would create an IDOR boundary.

## Existing token-facing APIs

- `router/api-router.go` registers `GET /api/usage/token/` behind `TokenAuthReadOnly` and `controller.GetTokenUsage`.
- `controller/token.go:GetTokenUsage` returns the token name, granted/used/available quota, unlimited flag, model limits, and expiry.
- `router/api-router.go` registers `GET /api/log/token` behind `TokenAuthReadOnly` and `controller.GetLogByKey`.
- `model/log.go:GetLogByTokenId` filters by `token_id`, excludes Code-Agent audit rows, orders newest first, strips `other.admin_info`/`audit_info`, but applies `common.MaxRecentItems` (1000) and has no pagination, total, time range, or search filters.

## Existing Usage Analysis

- `GET /api/usage-analysis` and `/options` are Root-only and use `CriticalRateLimit` plus `DisableCache`.
- `controller/usage_analysis.go` enforces a default 24-hour range, maximum 90-day range, 15-second timeout, default page size 20, and maximum page size 100.
- `model/usage_analysis.go` performs bounded aggregate, grouped-count/page, and hourly-trend queries against `LOG_DB`; it supports `token_id` filtering and handles ClickHouse hourly bucketing separately.
- Metrics include request count, input/output/total tokens, structured cache read/write fields, input total, consumed quota, cache rate, and legacy-row count.
- The Root breakdown groups by user, token, model, and channel. A public token view must not expose those administrative dimensions; its breakdown should aggregate by model only.

## Existing log privacy boundary

- `model.Log` contains user/token/channel/IP identifiers plus billing/error metadata.
- `formatUserLogs` strips `other.admin_info` and `other.audit_info`, but the raw JSON model still contains fields such as user ID, token ID, channel ID, and IP.
- A public Token API therefore needs an allow-listed response DTO rather than returning `model.Log` directly.
- Approved public fields: timestamp/type/content, model, structured token metrics, quota, duration, stream flag, group, request IDs, and sanitized `other` billing/error metadata.
- Explicitly excluded: user identity, token identity/secret, channel identity, IP, admin/audit data, Request Snapshot, request body, and response body.

## Frontend reuse and security findings

- Existing Usage Analysis presentation is split into overview, trend, and breakdown components under `web/src/features/usage-analysis/`.
- Overview/trend metrics can be reused with a small backward-compatible scope-label adaptation; the Root breakdown cannot be reused because it renders user/token/channel dimensions.
- The authenticated Usage Logs provider and full details dialog are coupled to dashboard role/session state. Reusing them directly on a public page risks showing Root-only controls when a browser also has a Root session.
- The public feature should use a dedicated allow-listed log table/details view while reusing pure formatting functions and generic UI primitives.
- The global Axios client in `web/src/lib/http-client.ts` injects the dashboard access token and redirects 401 responses to `/sign-in`. It would overwrite a caller-provided API Key when a logged-in dashboard session exists.
- The portal needs a dedicated Axios instance with no dashboard auth/refresh interceptors; each request supplies the entered Key as `Authorization: Bearer ...`.
- The Key must remain only in React component/context memory. React Query keys should contain a non-secret session nonce, and all `key-usage` queries must be removed when the Key changes or is cleared.

## Recommended shape

- Public route: `/key-usage`, rendered with `PublicLayout` and no required auth controls.
- Existing token metadata endpoint remains unchanged.
- Add token-scoped Usage Analysis endpoints that force context `token_id`, expose model-only options/breakdown, and reuse current metric/range/timeout contracts.
- Add a new paginated token-log endpoint instead of changing the legacy `/api/log/token` response shape.
- Keep the feature in the existing Go + embedded React image; do not create a privileged proxy service or separate deployment.
