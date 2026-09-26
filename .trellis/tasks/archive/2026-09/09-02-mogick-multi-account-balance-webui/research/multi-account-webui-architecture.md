# Multi-account and WebUI Architecture Research

Date: 2026-09-02

## Current Constraints

Remote source: `ssh2:/opt/mogick-proxy/mogick-proxy.js`.

- One global `token` object and one global `refreshing` promise.
- One `token.json` file, transformed to `/data/token.json` by Dockerfile build-time `sed`.
- One global device authorization state.
- `ensureToken()` and the 401 retry path assume a single account.
- Requests are sent over one reusable HTTP/2 connection to the same upstream; that connection can remain shared because bearer authentication is per request.
- Streaming responses are currently piped after upstream response headers are received.
- No application authentication exists for `/status` or `/auth/login`.
- NewAPI relies on the stable internal address `http://mogick-proxy:20431` and existing `/v1/*` behavior.

## Recommended Focused Architecture

Keep one Node.js service and avoid splitting the management plane into another container for the MVP.

### Account store

Persist accounts under `/data/accounts/` as one atomic JSON file per account:

```text
/data/accounts/<account-id>.json
```

Persist only durable fields:

- generated account ID
- operator label
- enabled flag
- access token
- refresh token
- expiry timestamp
- created/updated timestamps
- cached balance snapshot and timestamp
- last successful request/refresh timestamps
- last durable health reason

Keep runtime-only state in memory:

- per-account refresh singleflight promise
- per-account device-flow polling promise
- consecutive failure counters
- cooldown deadline
- current in-flight request count

Use write-to-temporary-file plus `fsync`/rename semantics for token rotation. Each account has its own lock/singleflight so simultaneous requests cannot spend the same one-time refresh token twice. Updating one account must not rewrite or corrupt another account's credential file.

### Migration

On first upgraded startup:

1. If `/data/accounts/` has no account files and legacy `/data/token.json` exists, import it as one enabled account with an operator-visible label such as `legacy-account`.
2. Write the new account atomically.
3. Rename the legacy file to a migration backup only after successful read-back verification.
4. Migration must be idempotent.

### OAuth device flow

Use a flow map keyed by a random management flow ID, not global state. A flow is optionally associated with a requested account label. On success, create a new account rather than replacing a global token.

Management APIs return the verification URI, user code, expiry, and flow status, but never return access/refresh tokens.

### Scheduler

Recommended MVP strategy: round-robin among eligible accounts, with failure-aware skipping.

Eligibility:

- enabled
- has a refreshable or currently valid token
- not in cooldown
- not known to be exhausted/reauth-required

Selection and retry rules:

1. Select the next eligible account using an in-memory round-robin cursor.
2. Ensure/refresh that account's token using its own singleflight.
3. Retry the same account once after a 401 only if token refresh succeeds.
4. Before any response body has been emitted, fail over to another account for classified account-scoped errors such as unrecoverable 401, verified insufficient balance, and bounded 429 cooldown.
5. Bound total attempts to the number of eligible accounts; never loop indefinitely.
6. Do not switch accounts after response headers/body have been sent to the client.
7. For streaming requests, network errors before upstream response headers may fail over; errors after piping starts terminate the stream and record the account failure without replaying the prompt.

A shared upstream HTTP/2 session is acceptable because each request includes its own Authorization header. If upstream behavior shows connection-bound identity, split sessions per account; this is a deferred compatibility fallback, not the default complexity.

### Balance service

Query the verified endpoint per account with that account's bearer token. Preserve decimal values as strings. Cache and expose the latest snapshot. Balance query failures should be visible but should not by themselves disable inference traffic.

### Management API

Suggested routes under `/admin/api`:

- `POST /session/login`, `POST /session/logout`, `GET /session`
- `GET /accounts`
- `POST /accounts/login-flow`
- `GET /accounts/login-flow/:flowId`
- `PATCH /accounts/:id`
- `DELETE /accounts/:id`
- `POST /accounts/:id/refresh-token`
- `POST /accounts/:id/refresh-balance`
- `GET /stats`

Mutating routes require CSRF protection in addition to authenticated cookies if a browser session is used.

### WebUI

Serve a small embedded vanilla HTML/CSS/JavaScript UI from the same process to minimize dependencies and deployment complexity. The MVP needs:

- authenticated login screen
- account table with label, enabled state, OAuth/health status, expiry, balance and update time
- add-account device-flow modal
- enable/disable, refresh balance, refresh token, and delete actions
- aggregate available balance and eligible account count
- scheduler mode/status and recent sanitized errors

Do not display token values. Mask upstream user identifiers.

### Management authentication

Application-level authentication is preferred even if Caddy also protects the route, because it protects management APIs on the Docker network. Use an administrator password supplied through a Docker secret or environment variable; derive a password hash and issue signed, HttpOnly, SameSite=Strict session cookies. Bind all management endpoints to authenticated sessions. Keep `/v1/*` behavior unchanged for NewAPI.

The remaining product decision is whether the WebUI is exposed through public HTTPS, restricted by IP/VPN, or accessed only over an SSH tunnel/internal network.

### Deployment and rollback

- Remove Dockerfile `sed` source transformations; make bind host and data directory environment-driven in source.
- Back up `/opt/mogick-proxy`, `/opt/mogick-proxy/data`, Compose, and active Caddyfile before upgrade.
- Build a versioned image tag in addition to `latest`.
- Health-check `/status` and an authenticated management status endpoint.
- Verify NewAPI inference before exposing management access.
- Rollback restores the previous image/source and legacy token file backup; account migration must leave enough information to reconstruct the original single account.

## Key Risks

- One-time refresh token rotation requires strict per-account serialization and atomic persistence.
- Public WebUI exposure materially increases credential-management risk.
- Automatic retry after a streamed response begins can duplicate billable work and corrupt output; it is explicitly prohibited.
- Balance API units are not self-describing; UI wording must not claim currency without a verified contract.
- Multi-account use must comply with the upstream service terms; the official site warns against using multiple accounts to circumvent free-tier limits. The feature should be positioned as managing legitimately owned accounts, not bypassing quotas.
