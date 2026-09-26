# Implementation Plan: Public API-Key Usage Portal

## 1. Protect the working tree and load context

1. Work only in `G:/Users/admin/Desktop/code/public-api` for product changes.
2. Preserve the existing untracked `.trellis/workspace/pi/` path and audit all changed/staged paths before commit.
3. Load `AGENTS.md`, `web/AGENTS.md`, the backend specs, cross-layer/reuse guides, this task's PRD/design, and `research/repo-audit.md`.

## 2. Implement Token-scoped backend queries

1. Add failing model tests for Token-only Usage Analysis:
   - context Token isolation;
   - model-only grouped rows;
   - correct summary/trend metrics;
   - pagination and empty results;
   - 90-day/range/page bounds where owned by the model/controller boundary.
2. Extend the Usage Analysis model layer with a Token-facing result that reuses existing aggregate, cache-rate, timeout, and ClickHouse bucket behavior without changing the Root result contract.
3. Add a bounded current-Token model-options query.
4. Add failing model tests for paginated Token logs:
   - all pages are reachable;
   - time/type/model/request-ID filters;
   - Code-Agent exclusion;
   - newest-first SQLite/MySQL/PostgreSQL ordering and existing ClickHouse branch;
   - no cross-Token rows.
5. Implement the Token log count/page query against `LOG_DB`.

## 3. Add privacy-safe controllers and routes

1. Add a Token Usage Analysis controller that obtains `token_id` only from Gin context and overwrites/ignores administrative query identifiers.
2. Add a Token model-options controller.
3. Add a paginated Token-log controller with an explicit allow-listed response DTO and sanitized `other` data.
4. Register:
   - `GET /api/usage/token/analysis`
   - `GET /api/usage/token/analysis/options`
   - `GET /api/log/token/page`
5. Apply `TokenAuthReadOnly`, `CriticalRateLimit`, and `DisableCache`; preserve the legacy `/api/log/token` route and response.
6. Add controller/router regressions proving:
   - invalid/disabled Key and banned user behavior;
   - malicious `user_id`/`token_id`/`channel_id` cannot change scope;
   - prohibited fields are absent from serialized responses;
   - no-cache headers and endpoint registration are correct;
   - safe range/page/query errors and timeout behavior.

## 4. Build a dedicated public frontend data boundary

1. Add feature-local API types matching the new allow-listed payloads.
2. Add a dedicated Axios client that does not use dashboard auth/session refresh interceptors and does not redirect 401/403.
3. Add tests proving a provided API Key is sent unchanged, a simultaneous dashboard session cannot overwrite it, and errors remain page-local.
4. Implement API calls for Token metadata, Token Usage Analysis/options, and paginated Token logs.
5. Ensure neither API Key values nor derivatives that can recover them are placed in logs, errors, Query keys, or storage.

## 5. Implement `/key-usage`

1. Add the public TanStack route and render it with `PublicLayout` without requiring authentication.
2. Build the API Key entry card with password/reveal behavior, validation, loading, and invalid/disabled/banned states.
3. Keep the accepted Key in feature-local React memory and use a random non-secret session nonce in Query keys.
4. Implement clear/change behavior that cancels and removes all previous `key-usage` queries and detail state.
5. Add the Usage Overview:
   - Token quota summary;
   - reused/adapted Usage Analysis overview and trend components;
   - shared date/model filters;
   - model-only breakdown with pagination.
6. Add Request Records:
   - time/type/model/request-ID filters;
   - paginated table;
   - Token-safe details dialog that contains only allow-listed fields.
7. Do not reuse any component path that can show dashboard-only user/channel data or Root Request Snapshot controls unless it gains an explicit Token-safe mode with regression coverage.
8. Add responsive, keyboard, focus, loading, empty, error, pagination, and Key-change regression tests.

## 6. Internationalization and presentation checks

1. Add all user-facing text through `useTranslation()`.
2. Update all seven locale files using the repository's i18n workflow and confirm zero missing/extra/untranslated entries.
3. Preserve existing protected New API/QuantumNous branding and copyright headers.

## 7. Full quality verification

Run from `G:/Users/admin/Desktop/code/public-api`:

1. `gofmt` on changed Go files.
2. Focused model/controller/router Go tests for the new Token contracts.
3. Existing Usage Analysis, Token auth, and log regression tests.
4. Root module build and applicable broader Go tests; document any verified unrelated baseline failure rather than masking it.
5. Focused frontend API/state/component tests.
6. `cd web && bun run typecheck`.
7. Affected-file `oxlint` and `oxfmt --check`/repository format check.
8. `cd web && bun run i18n:sync` and inspect the sync report.
9. `cd web && bun run build:check` (or the repository's current equivalent confirmed from scripts).
10. `git diff --check` and a complete diff/security review.
11. Explicitly search the diff and built frontend for accidental API Key persistence/logging and prohibited response fields.

## 8. Spec and review gate

1. Update the owning `public-api/.trellis/spec/backend/quality-guidelines.md` with the executable Token self-service contract: routes, context-bound scope, privacy projection, client memory/cache rules, tests, and wrong-vs-correct example.
2. Run a fresh-context quality review against the PRD, design, specs, and complete diff; fix verified findings and rerun affected checks.
3. Confirm changed paths contain only authorized product code, tests, translations, spec/docs, and route generation output.

## 9. Commit and deploy to `ssh2`

After the user approves this plan for implementation and the final diff/check results:

1. Commit only authorized files; do not include `.trellis/workspace/pi/` or unrelated changes.
2. Create a deployment archive from the exact commit and a unique image tag.
3. On `ssh2`, back up `/opt/newapi/docker-compose.yml`, `.env` without printing it, current image metadata, source state, and SQLite using an online backup plus integrity check.
4. Build the new image fully before changing Compose.
5. Change only the `newapi` service image and recreate only that service.
6. Verify:
   - `docker compose ps` and restart count;
   - effective image tag;
   - `GET http://127.0.0.1:3000/api/status` returns HTTP 200 and `success=true`;
   - `/key-usage` serves the new public page/asset;
   - Token endpoints reject missing credentials without redirect behavior;
   - bounded recent logs contain no startup/migration failure.
7. If any gate fails, restore the saved Compose/image/database state, recreate the prior service, and re-verify `/api/status` before reporting failure.

## Rollback points

- Backend/API rollback: revert the new Token analysis/log routes, controllers, model queries, and tests together; legacy APIs remain untouched.
- Frontend rollback: revert `/key-usage`, feature-local client/components, shared presentation prop adaptation, route tree, tests, and locale additions together.
- Deployment rollback: restore the saved Compose/image state; restore SQLite only if a database integrity or migration issue occurred (none is expected because this design adds no schema change).
