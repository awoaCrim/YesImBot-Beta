# Implementation Plan

## 1. Preserve and Baseline

- Record current Mogick source commit, local modifications, image ID, container settings and NewAPI channel health.
- Create consistent backups of `/opt/mogick-proxy`, `/opt/mogick-proxy/data`, Compose and active Caddyfile.
- Capture a redacted baseline for `/status`, model list and one NewAPI inference usage row.

Rollback point: untouched backup plus current image tag.

## 2. Restructure Mogick into Testable Modules

- Add `package.json` with Node test/check scripts and no unnecessary runtime framework.
- Move the single-file implementation into focused modules for account storage/OAuth, balance, Resin adapter/transport, scheduler/router, metrics, admin auth/routes and static WebUI.
- Replace Dockerfile `sed` transformations with `MOGICK_LISTEN_HOST`, `MOGICK_PROXY_PORT` and `MOGICK_DATA_DIR` configuration.
- Keep existing OpenAI-compatible behavior and request fingerprint tests.

Validation:

```bash
npm test
node --check <entrypoint>
docker build ...
```

## 3. Account Store and Legacy Migration

- Implement per-account atomic JSON persistence and redacted snapshots.
- Implement idempotent migration from `/data/token.json` and migration backup.
- Refactor device flow and refresh singleflight to per-account/per-flow state.
- Add OAuth-only account creation, enable/disable/delete and manual refresh operations.

Tests:

- migration success/idempotence/corrupt legacy file;
- concurrent refresh calls spend one refresh token once;
- one account write failure does not affect another;
- API serialization never contains token fields.

Rollback point: migrated account plus current valid legacy-format export.

## 4. Balance Module

- Implement authenticated Resin-routed balance query and decimal-string validation.
- Add login-time, 5-minute scheduled and manual refresh with rate limiting.
- Implement fresh-depleted vs unknown/stale eligibility rules.

Tests use a fake subscription endpoint for success, malformed envelope, auth failure, zero balance and transient failure.

## 5. Deploy and Adapt Resin

- Add Resin Compose service on `shared-app-network`, persistent volumes and protected `RESIN_ADMIN_TOKEN`/`RESIN_PROXY_TOKEN` configuration.
- Pin the pulled image digest used for deployment.
- Configure Resin request logging with request/response body capture disabled.
- Implement server-side `ResinAdapter` for subscriptions, nodes, platforms, leases, probes, metrics and request-log summaries.
- Ensure a dedicated `Mogick` platform.
- Implement CONNECT tunneling with `Mogick.<accountId>` sticky proxy authentication.
- Replace the global HTTP/2 connection with bounded per-account/per-authority sessions.

Tests:

- fake Resin control API contract;
- proxy auth identity format;
- stable identity across OAuth/balance/inference;
- no direct fallback when Resin is unavailable;
- session failure isolation by account.

## 6. Strict Round-robin Router

- Implement eligible-account snapshots and cursor rotation.
- Add bounded retry/failover classifications.
- Enforce the no-retry-after-output invariant for stream and non-stream paths.
- Preserve 401 same-account refresh-once behavior.

Tests:

- A/B/C/A order;
- skip disabled/depleted/cooldown accounts;
- 401 refresh then success;
- failover before headers;
- no failover after stream begins;
- attempts never exceed eligible account count.

## 7. Metrics and Retention

- Add `node:sqlite` schema migrations, WAL mode and prepared statements.
- Implement shared usage normalization.
- Add streaming SSE pass-through parser and non-stream integration.
- Record metadata-only request events and daily aggregates.
- Add 30-day compaction and long-lived daily queries.

Tests:

- all supported cached-token field positions;
- weighted aggregate cache rate;
- missing usage vs real zero;
- client cancellation and malformed SSE;
- schema has no content/body/secret columns;
- compaction is idempotent and preserves totals.

## 8. Admin Authentication and API

- Implement management Token login, HMAC-signed secure session cookie, CSRF and login throttling.
- Add account, balance, usage, system and Resin adapter routes.
- Add central secret/header/body sanitization and uniform errors.

Security tests:

- unauthorized/expired/tampered sessions;
- CSRF rejection;
- login rate limit;
- token/cookie/proxy credentials absent from logs and JSON responses;
- public management router cannot reach `/v1/*`.

## 9. Integrated WebUI

- Build a responsive dependency-light UI for login, dashboard, accounts, Resin proxy pool, usage and system status.
- Implement device-code polling, account actions, Resin subscription/node/lease workflows and charts/tables for Token/cache metrics.
- Never place management Token or service credentials in URLs or browser storage.

Validation:

- browser smoke test for login/logout;
- two-account device flow UI;
- subscription CRUD and node probe against Resin adapter;
- usage filters and empty/error states;
- mobile/desktop layout and keyboard accessibility.

## 10. Docker, Caddy, and Live Rollout

- Build a versioned Mogick image and recreate through Compose without changing the internal service name/port.
- Start Resin internally with no public proxy port.
- Keep Resin egress disabled until a healthy subscription exists.
- Configure subscription through integrated WebUI and verify healthy nodes.
- Enable Resin egress and run account/balance/model/chat smoke tests.
- Verify NewAPI channel 59 inference and usage attribution.
- Add Caddy management-only HTTPS route; validate and reload Caddy.
- Confirm public `/v1/*` is 404 while internal `/v1/*` remains functional.

## 11. Final Verification

Run full module tests, Docker health checks and live acceptance matrix:

- legacy migration and restart persistence;
- at least two accounts and strict rotation;
- sticky Resin identity and node failure handling;
- true balance display;
- stream/non-stream metrics and cache-rate math;
- 30-day retention simulation;
- management authentication and public path restrictions;
- NewAPI compatibility;
- backup and rollback rehearsal.

Do not declare proxy-pool acceptance complete until at least one user-provided subscription has a healthy node and a real Mogick request succeeds through Resin.
