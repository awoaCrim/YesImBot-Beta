# Technical Design

## Architecture

```text
Public browser
  -> Caddy HTTPS (management paths only)
    -> Mogick Admin/WebUI

NewAPI (Docker network)
  -> Mogick /v1/*
    -> RequestRouter
      -> AccountPool strict round-robin
        -> Resin forward proxy (sticky Platform.Account)
          -> Tongyuan OAuth / subscription / Copilot upstreams

Mogick
  -> /data/accounts/*.json       OAuth credentials and durable account state
  -> /data/mogick.sqlite         numeric usage events and daily aggregates
  -> Resin management API        subscription/node/platform/lease adapter
```

Resin is a separate container and control plane. Mogick remains the only interface exposed to operators and NewAPI.

## Deep Modules and Seams

### AccountPool Module

Interface:

```text
beginLogin(label) -> LoginFlowView
getLoginFlow(flowId) -> LoginFlowView
listAccounts() -> AccountSnapshot[]
setEnabled(accountId, enabled)
deleteAccount(accountId)
refreshBalance(accountId)
leaseNext(excludedAccountIds) -> AccountLease
completeLease(lease, outcome)
```

The implementation hides credential files, per-account refresh singleflight, OAuth device polling, balance caching, cooldown state, eligibility and the strict round-robin cursor. Callers never receive raw tokens. `AccountLease` exposes only an account ID plus a method/internal capability to execute authenticated upstream work.

Durable account files use generated UUIDs and atomic temporary-write + fsync + rename. Runtime promises, in-flight counts and cooldowns remain in memory.

### RequestRouter Module

Interface:

```text
forwardOpenAI(request, response) -> Promise<void>
```

This module hides request normalization, strict round-robin selection, bounded retries, per-account Resin transport, 401 refresh, failure classification, SSE pass-through parsing and metrics finalization. Its interface invariant is that failover is allowed only before client output starts.

### ResinAdapter Seam

Resin is a true external dependency. Define an internal port with two adapters:

- production HTTP adapter using Resin's Bearer-protected management API and forward proxy;
- in-memory/fake adapter for scheduler, WebUI and failure tests.

Interface:

```text
listSubscriptions/queryNodes/queryLeases/queryMetrics
create/update/delete/refreshSubscription
probeNode
ensureMogickPlatform
openTunnel({accountId, targetAuthority}) -> Duplex
getAccountBinding(accountId) -> BindingSnapshot
```

Browser requests never cross this seam directly. The server injects `RESIN_ADMIN_TOKEN` for control-plane calls. Forward proxy authentication uses `Mogick.<accountId>:RESIN_PROXY_TOKEN`.

### MetricsStore Module

Interface:

```text
record(event)
queryUsage(filters) -> UsageSummary
querySeries(filters) -> UsagePoint[]
compact(now)
```

Use Node 22's built-in `node:sqlite`, WAL mode and prepared statements. Store numeric/relational metadata only. No content columns exist.

Tables:

- `usage_events`: request-level data retained 30 days.
- `usage_daily`: daily account/model aggregates retained indefinitely.
- `schema_migrations`: deterministic local migrations.

Aggregate cache rate is `SUM(cached_input_tokens) / SUM(input_tokens)`, not an average of per-request percentages. Missing cache usage is tracked separately from a real zero.

### AdminAuth Module

Interface:

```text
login(token, clientContext) -> SessionCookie
requireSession(request) -> Session
requireMutation(request) -> Session
logout(session)
```

The implementation hides constant-time token comparison, signed session cookies, expiry, CSRF token binding and login throttling. Session state can remain stateless and HMAC-signed; rotating the configured management Token invalidates existing sessions.

### AdminUI Module

Serve embedded static assets and JSON management routes. Use a small dependency-light UI rather than a separate runtime container. Pages:

- Dashboard: account/proxy health, aggregate balance, 24h usage.
- Accounts: OAuth device login, enable/disable/delete, balance/refresh actions.
- Proxy Pool: Resin subscriptions, nodes, platform status, leases and probes.
- Usage: time/account/model filters, totals and charts.
- System: versions, migration status and sanitized errors.

## Data Model

### Account file

```json
{
  "version": 1,
  "id": "uuid",
  "label": "operator label",
  "enabled": true,
  "access_token": "secret",
  "refresh_token": "secret",
  "expires_at": 0,
  "created_at": 0,
  "updated_at": 0,
  "last_refresh_at": 0,
  "balance": {
    "available_amount": "decimal string",
    "free_balance": "decimal string",
    "plan_balance": "decimal string",
    "total_balance": "decimal string",
    "active_hold_amount": "decimal string",
    "frozen": "decimal string",
    "credit_limit": "decimal string",
    "updated_at": 0,
    "error": null
  }
}
```

Files are mode 0600 where supported. API snapshots omit token fields and mask upstream user identifiers.

### Usage event

Fields include timestamp, request ID, account ID, model, stream flag, result category, HTTP status, latency, optional first-token latency, input/output/total/cached tokens, cache-usage-present flag and sanitized Resin node/egress identifiers. No body/content/blob columns exist.

## Network and Proxy Flow

Generate the durable account ID before device authorization starts. Every request in that flow already has a stable Resin Account.

For each account and target authority, maintain a bounded connection/session pool:

1. Open HTTP CONNECT to `resin:2260`.
2. Send proxy authorization for `Mogick.<accountId>`.
3. Establish TLS to the target through the tunnel.
4. For Copilot, create HTTP/2 session with the existing Mogick request fingerprint.
5. For OAuth and balance, issue ordinary HTTPS requests over the same Resin identity.

Sessions are keyed by account ID and authority; a global shared upstream session is removed. Session errors invalidate only that key.

The Resin control-plane adapter calls `http://resin:2260/api/v1/*` directly on the Docker network with `Authorization: Bearer <admin token>`.

## Scheduling and Failure State

Eligible account states:

- enabled;
- valid or refreshable OAuth credential;
- no fresh zero/negative balance;
- not in account cooldown;
- Resin reports a routable/bound path or transport succeeds.

The cursor advances after a selection attempt, preventing one failing account from monopolizing retries. Account outcomes update only runtime health/cooldown fields unless durable operator state changes.

Retry classes before output:

- 401: refresh same account once; then exclude it.
- explicit insufficient balance/402: mark depleted, refresh balance asynchronously, exclude it.
- 429: bounded cooldown, try next account.
- proxy connect/reset before upstream headers: mark proxy-path failure, try next account.
- upstream 5xx: short cooldown/failover within bounded attempts.

After `response.headersSent` or first streamed bytes, retries are prohibited.

## Usage Collection

All chat requests keep `include_usage=true`.

- Non-stream client: existing SSE aggregation uses a shared usage normalizer, then records one event.
- Stream client: a pass-through SSE transform parses complete `data:` lines while forwarding bytes immediately. It retains only an incomplete line buffer and the latest usage object.
- Client cancellation/upstream failure: finalize a metadata event with `usage_missing` when final usage was not observed; do not estimate tokens.
- Other `/v1/*` JSON responses: capture standard `usage` where present.

A scheduled compactor recomputes completed-day aggregates and deletes request events older than 30 days.

## Web and Security Contracts

Public Caddy route allows only `/`, static asset paths and `/admin/api/*`; all other paths return 404. Internal Docker requests continue to reach `/v1/*` directly.

Login flow:

1. Public login page accepts the management Token over HTTPS.
2. Server compares it in constant time.
3. Server returns signed HttpOnly session cookie and a CSRF token delivered to authenticated UI state.
4. Mutations require both session cookie and CSRF header.
5. Login failure responses are uniform and rate-limited.

Secrets are injected through protected environment files or Docker secrets. Sanitizing logger removes Authorization, Cookie, proxy auth and OAuth fields.

## Resin UI Integration

Reimplement only the operator workflows needed by this product through the stable Resin management API:

- subscriptions: list/create/update/delete/refresh;
- nodes: list/detail/probe;
- platforms: list/detail/update, ensure dedicated `Mogick` platform;
- leases: list/search by account;
- metrics/request logs: sanitized summaries only.

Do not proxy Resin's native WebUI into the browser and do not expose `RESIN_ADMIN_TOKEN`. If Resin changes its API, only `ResinAdapter` changes.

Resin payload logging is disabled or capped at zero body bytes so the proxy layer does not undermine the no-request-body requirement.

## Migration

On startup:

1. Initialize account directory and metrics schema.
2. If no new-format account exists and legacy `/data/token.json` exists, parse and validate it.
3. Create `legacy-account` with a generated stable ID and atomically write/read-back the new file.
4. Rename the legacy token file to a timestamped migration backup.
5. Record migration marker; repeated startups do not duplicate the account.

## Rollout and Rollback

1. Back up `/opt/mogick-proxy`, data and active Caddyfile.
2. Deploy Resin without public proxy ports and verify management health.
3. Deploy the new Mogick image with explicit compatibility setting `MOGICK_EGRESS_MODE=direct`, preserving the NewAPI address. This is a visible rollout setting, not an automatic fallback.
4. Verify legacy migration, WebUI authentication and direct functional tests.
5. Add a Resin subscription through the integrated UI and wait for healthy nodes.
6. Set `MOGICK_EGRESS_MODE=resin`, recreate the container, and verify OAuth/balance/model/chat through a sticky account. In Resin mode, proxy failure never falls back to direct.
7. Verify NewAPI inference, strict rotation and usage metrics.
8. Add Caddy management-only route.

Rollback restores the previous Mogick image/source, Caddyfile and legacy token backup. Resin can remain stopped; rollback must not consume new-format refresh tokens after the old token backup has become stale, so rollback validation includes exporting the currently valid primary account token back to legacy format immediately before cutover completion.

## Risks and Deferred Items

- Live proxy end-to-end acceptance requires the operator to provide at least one Resin subscription with a healthy node.
- Resin API compatibility is isolated behind the adapter, but upgrading Resin must run contract tests first.
- Upstream balance units are not self-describing; UI uses “额度/Credits”.
- Multiple accounts must be legitimately owned and used in compliance with upstream terms.
