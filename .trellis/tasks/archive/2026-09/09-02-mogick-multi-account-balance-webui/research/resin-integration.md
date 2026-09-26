# Resin Integration Research

Date: 2026-09-02

Primary source: `https://github.com/Resinat/Resin`

## Fit

Resin directly matches the requested account-sticky proxy-pool behavior:

- Docker Compose deployment is officially supported.
- It has a built-in WebUI protected by `RESIN_ADMIN_TOKEN`.
- Proxy ingress is protected separately by `RESIN_PROXY_TOKEN`.
- It imports remote subscriptions, pasted subscription content, Clash/sing-box formats, URI lists, and plain HTTP proxy lists.
- It supports active/passive health checks, circuit breaking, latency-aware node selection, persistent sticky bindings, HTTP forward proxy, SOCKS5, and reverse-proxy modes.
- Its sticky identity format has `Platform` and `Account`; a stable Mogick account ID can be used as Resin's Account value.

## Recommended Responsibility Split

- Mogick owns business accounts, OAuth credentials, balances, strict round-robin account scheduling, and management of account state.
- Resin owns proxy subscriptions, node parsing, health, circuit breaking, sticky node leases, and proxy observability.
- Each Mogick account always presents the same Resin Account identifier for OAuth, refresh, balance, model, and inference traffic.
- Resin and Mogick use separate secrets: management token(s) and Resin proxy token.

## Integration Mode

Preferred transport for production validation is HTTP forward proxy with Resin sticky authentication, because CONNECT tunneling preserves end-to-end TLS and allows Mogick to retain its current HTTP/2 upstream behavior. The proxy username carries `Platform.Account` and the password carries `RESIN_PROXY_TOKEN`.

A reverse-proxy integration is easier to implement and gives strong Resin observability, but it changes Mogick's transport path and may alter the upstream HTTP/2 fingerprint. It can be used as a fallback or prototype, not assumed equivalent without an inference compatibility test.

## Failure Behavior

- Resin unavailable or no healthy nodes: fail closed with an explicit upstream/proxy error.
- Do not silently bypass Resin and connect directly, because that unexpectedly changes account IP.
- Resin node failover remains transparent within an account's sticky lease where Resin can provide it.
- Mogick account failover remains bounded and only occurs before client output begins.

## Deployment Shape

Deploy Resin as a separate container on `shared-app-network`, with persistent cache/state/log volumes and no public proxy port unless explicitly needed. Mogick reaches Resin by Docker DNS. Caddy may expose Resin's WebUI if the user chooses separate management access; the proxy ingress itself remains internal.

## Remaining Product Decision

Choose whether operators manage proxy subscriptions/nodes in Resin's native WebUI or whether Mogick should call Resin's management API and reproduce those controls in the Mogick WebUI. Native Resin UI is recommended for MVP to avoid duplicating a mature proxy control plane.
