# Implementation Result

Date: 2026-09-02

## Current Removal State

Independent read-only verification date: 2026-09-03

**This implementation is no longer deployed on `ssh2`.** The main removal deleted the Mogick container, all tagged `mogick-proxy:*` images, the `/opt/mogick-proxy` and `/opt/mogick-backups` trees, the live Caddy management route/certificate state, NewAPI channel 59 data, and the dedicated Resin platform data.

Verified clean current state:

- Docker has no Mogick container, image tag, volume, network or `shared-app-network` endpoint. Caddy, NewAPI and Resin remain present.
- No Mogick-named path remains under `/opt`, `/etc/caddy`, `/root`, `/home`, `/srv` or `/var/backups`. Searches of the active NewAPI and Resin trees found no `mogick-proxy` or removed Resin platform-ID reference.
- The active Caddyfile and autosaved JSON contain no `geminiweb2api.uwoacrimson.com` route. Caddy configuration validation passed, and Caddy certificate/config storage contains no file or content reference for that domain. HTTP still receives Caddy's generic automatic HTTPS redirect, but HTTPS fails before an application response because the hostname no longer has a configured TLS route/certificate; the former management endpoint is not reachable.
- NewAPI is healthy through both its internal and public `/api/status` endpoints. Its SQLite database passes `integrity_check`; channel 59 is absent from `channels`, `abilities`, `logs`, `quota_data`, tasks and channel-scoped auxiliary tables. Case-insensitive searches across every SQLite column found no `Mogick`, `mogick-proxy`, `http://mogick-proxy:20431` or removed Resin platform UUID. Thirteen other channels remain.
- Resin is healthy and still has exactly three subscriptions. Its state, cache, request-log and metrics databases pass `integrity_check`. Platform name `Mogick`, platform ID `35358777-d58b-4774-af2b-a7b9940d87bc`, associated leases, request logs and platform metric rows are all absent. Request payload storage remains empty.
- NewAPI and Resin restarted successfully during removal and both show restart count 0 after their current starts. Caddy remained running with restart count 0 and a valid reloaded configuration.
- Four historical Caddy backup files dated August 17–22, 2026 still mention `geminiweb2api.uwoacrimson.com`, but point to older Gemini/Antigravity services and predate the September 2 Mogick deployment. They are unrelated shared rollback artifacts and were correctly preserved.

Post-review residual cleanup completed on 2026-09-03:

- Removed all **408** Mogick-specific top-level artifacts from `/tmp` and `/var/tmp`, including test directories, credential-test directories, build logs, source archives and CLI research files. A second name/content scan found no Mogick or management-domain temporary artifact.
- Purged channel 59 abilities, 107 channel request/audit log rows, 10 quota rows and remaining Mogick-text audit rows from NewAPI, then checkpointed and vacuumed the active database.
- Purged the removed Resin platform's 7 lease-cache rows, 747 request-log rows and 46 metric-bucket rows, then checkpointed and vacuumed the affected databases.
- Final verification found zero Mogick containers, images, named paths, Caddy current-config references, management-domain certificate files, NewAPI channel/history rows, Resin platform rows, leases, request logs or metric rows. NewAPI and Resin both returned HTTP 200, and all three pre-existing Resin subscriptions remained present.

The few free pages that may subsequently appear in actively written shared SQLite databases are normal allocator state; full-column scans contain none of the removed Mogick identifiers or strings.

## Historical Deployed State (Removed 2026-09-03)

- Host: `ssh2`
- Mogick source: `/opt/mogick-proxy`
- Image: `mogick-proxy:20260902-live-fixes-r8`
- Application version: `2026.9.2-r8`
- Management URL: `https://geminiweb2api.uwoacrimson.com/`
- Management credential file: `/opt/mogick-proxy/secrets/mogick_admin_token` (versioned scrypt format verified; plaintext intentionally never requested or recorded)
- Egress mode: `resin`
- Resin image: `ghcr.io/resinat/resin:1.2.0` pinned by digest in Compose
- NewAPI internal URL remains `http://mogick-proxy:20431`

Resin was already deployed on this host since August 2026 with three existing operator subscriptions. This task reused it, preserved those subscriptions, pinned the running image, bound port 2260 to loopback, and attached Resin to `shared-app-network`; no unknown subscription was added by this task.

## Completed

- Modular Node.js gateway with no third-party runtime dependency.
- Per-account OAuth files, device login flows, refresh singleflight and legacy token migration/rollback export.
- Verified Tongyuan balance integration with decimal-string preservation.
- Strict round-robin account selection and bounded pre-output failover.
- Resin sticky identity across OAuth, balance and inference; no direct fallback in Resin mode.
- Integrated account, balance, Resin subscription/node/lease and usage WebUI.
- Versioned scrypt administrator-password login with raw high-entropy Token compatibility, secure signed cookie, CSRF and throttling.
- Metadata-only SQLite usage metrics, SSE usage parsing, 30-day request retention and permanent daily aggregates.
- Caddy management-only public route; inference and health paths remain unavailable publicly.
- Read-only/non-root/capability-dropped Docker hardening and health checks.

## Live r8 Fixes

- Balance HTTP 403 with Tongyuan business code `4001093` now maps to `同元账号已被禁用，无法查询余额`. Unknown upstream messages/details remain hidden. Failed refreshes preserve all last-successful balance values and the successful `updated_at` timestamp while advancing only the attempt timestamp and sanitized error.
- OAuth dialog no longer nests the device-login form inside `<form method="dialog">`. The × control is an explicit `type="button"` close action; close and Escape/cancel both clear the browser polling interval.
- Account label is optional in the WebUI and backend. Empty input receives the server-side default `未命名账号`; non-empty labels remain limited to 80 characters.
- The device-login form has a dedicated 1rem vertical gap. Its button is start-aligned on desktop and full-width on mobile.
- Management assets use cache-bust `20260902-r8`.

## Independent Review Fixes

- Round-robin cursor now advances after every actual attempt, including failover.
- Transient OAuth refresh errors no longer permanently disable accounts.
- Numeric balance JSON is rejected instead of losing precision.
- Rollback export follows primary-account enable/delete/token-rotation changes.
- Missing cache metadata is distinct from a real zero and excluded from the cache-rate denominator.
- Resin responses/errors are conservatively sanitized before reaching the browser or logs.
- Account eligibility reflects Resin routability.
- Failed HTTP/2 sessions are destroyed and removed.
- Full balance field set is shown in WebUI.
- Unauthenticated layout now enforces `[hidden] { display: none !important; }`; versioned assets are served with `Cache-Control: no-store`, preventing the hidden application from extending the login page.
- Hashed passwords use a 10 UTF-8 byte minimum while legacy raw Tokens require at least 24 characters; the login form no longer applies an incompatible HTML character-count minimum.

## Verification

- `npm run check`: 26 JavaScript files passed syntax checks.
- `npm test`: 37/37 tests passed, including focused regressions for balance error allowlisting/snapshot preservation, optional/default/overlong labels, dialog form structure, explicit close/cancel cleanup and responsive spacing.
- Docker Compose validation and image build passed.
- Mogick container is healthy, non-root, read-only, `cap_drop: ALL`, with zero restarts during final verification.
- Public path matrix: root/assets 200; unauthenticated admin API 401; `/v1/*`, `/status`, `/healthz`, `/auth/login` and unknown paths 404.
- Authenticated management session, secure cookie, CSRF rejection and logout passed.
- Resin management body/header capture limits are zero; one existing account has a matching sticky lease.
- A real Resin-routed non-stream chat returned HTTP 200 with usage and added exactly one metadata event.
- Metrics schema contains no request/response/body/content/credential columns.
- Secret literal scan found no configured secret in source/docs or current Mogick/Resin container logs.
- OAuth account credential file mode is 0600; administrator credential file mode is 0400 inside a root-only 0700 secret directory.
- Headless Edge computed layout verified the unauthenticated app has `display:none`, zero height and no extra scroll range.
- Public HTTPS headless Edge verification on r8 confirmed: dialog open; × closes without validation; empty-label Start returns a device code/login link without completing authorization; both × and Escape clear the poller; computed form gap is 16px with desktop start alignment; no browser-storage credentials exist.
- Manual balance refresh through the public WebUI returned the sanitized disabled-account message. A backup-to-live comparison confirmed every previous balance value and successful timestamp remained unchanged.
- Compose validation and the r8 image build passed. Only `mogick-proxy` was recreated; it is healthy with zero restarts. The account count and secret-file hashes were preserved, and Resin/NewAPI container identity/restart state did not change.
- Backup/rollback checkpoints: `/opt/mogick-backups/check-agent-pre-r2-20260902-160227`, `/opt/mogick-backups/check-agent-pre-r7-20260902-172345`, and `/opt/mogick-backups/implement-pre-r8-20260902-174356`.

## Independent r8 Check-Agent Review

- Re-reviewed the deployed `/opt/mogick-proxy` source and live container without reading or requesting administrator plaintext credentials or real device codes. No implementation defect remained in the requested r8 scope.
- Confirmed the OAuth dialog has a non-form outer panel, exactly one dynamically rendered start form, an explicit `type="button"` × handler, and both `close` and default Escape/`cancel` paths clear `state.flowTimer` to `null`.
- Confirmed empty and whitespace-only labels are normalized server-side to `未命名账号`, while labels longer than 80 JavaScript characters fail before the device authorization request is started.
- Confirmed the dedicated login-flow layout computes to a 16px gap, start-aligns the submit button on desktop, and stretches it to full width at a 390px mobile viewport.
- Confirmed balance code `4001093` is mapped only through the scalar-code allowlist. Unknown upstream `message`/`detail` values become `余额查询失败 (<status>)`; failed refreshes preserve all previous balance values and the last successful `updated_at` while updating only `last_attempt_at` and the sanitized error.
- Confirmed Resin remains fail-closed: production runs with `MOGICK_EGRESS_MODE=resin`; transport attempts the Resin proxy only, and Resin CONNECT failure does not attempt the target host directly.
- Strengthened regression coverage in remote `test/account-pool.test.js`, `test/transport.test.js`, and `test/webui-visibility.test.js` for persisted unknown-balance redaction, actual no-direct-fallback connection behavior, and the dialog `close` listener. Application source did not require changes, so no image rebuild or container recreation was necessary.
- Verification after the test updates: `npm run check` passed; `npm test` passed 38/38; `docker compose config -q` passed. The container remained healthy on image `mogick-proxy:20260902-live-fixes-r8`, application version `2026.9.2-r8`.
- Source, container, and public hashes matched for the r8 management assets. Public root/assets returned 200, unauthenticated management session returned 401, and `/v1/*`, `/status`, `/healthz`, `/auth/login`, and unknown public paths returned 404.
- A fresh headless Edge run loaded the deployed r8 assets and browser-verified dialog open/× close, empty and whitespace-label submission, Escape close, poll-timer cleanup, desktop spacing/alignment, and mobile full-width behavior using intercepted non-secret test responses. It neither completed OAuth nor displayed or recorded a device code.

## Historical Preserved External/User Changes

Before removal, NewAPI channel 59 published three selected model names with one mapping. Management audit records showed those changes occurred before this implementation, and the implementation did not overwrite them. Mogick itself advertised five upstream model IDs. Channel 59 has now been removed as part of the authorized teardown.

## Historical Remaining Live Acceptance (No Longer Applicable)

Before removal, only one OAuth account was configured. Unit/integration tests covered multi-account rotation, failover and concurrent refresh, but real two-account A/B rotation had not been completed.

This acceptance item is no longer actionable because the Mogick implementation was removed from `ssh2` on 2026-09-03. The task was archived after teardown verification for historical traceability.
