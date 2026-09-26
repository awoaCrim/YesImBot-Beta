# Mogick Balance / Quota API Research

Date: 2026-09-02

## Conclusion

A real authenticated balance endpoint exists and is used by the official Mogick CLI. The proxy can query it per OAuth account; NewAPI's local channel `balance` field is not needed as the source of truth.

## Primary Evidence

### Official CLI artifact

- Official release metadata: `https://releases.tongyuan.cc/mogick/latest_version`
- Resolved version during research: `26.8.28.4243`
- Linux artifact SHA-256 matched the official manifest: `acab6f7246db3d441508853d7dca8110e5c5b240f96aec3c4d57c5bc4a146374`.
- The official binary contains:
  - subscription base URL `https://api.tongyuan.cc/subscription`
  - package name `tongyuan.cc/ai/mogick/subscription`
  - response fields `total_balance`, `balance`, `free_balance`, and `plan_balance`
  - errors `subscription: balance HTTP %d`, `subscription: balance code=%d`, and `subscription: balance data is empty`
  - UI/status labels for `user_balance`, `available`, `free_balance`, and `plan_balance`

### Read-only authenticated probe

Using the already-authorized account token without logging or persisting it elsewhere, the following endpoint returned HTTP 200:

```text
GET https://api.tongyuan.cc/subscription/api/v1/user/balance
Authorization: Bearer <account access token>
```

Observed response envelope and field types, with values redacted:

```json
{
  "code": "number",
  "message": "string",
  "data": {
    "user_id": "string",
    "balance": "numeric string",
    "free_balance": "numeric string",
    "plan_balance": "numeric string",
    "frozen": "numeric string",
    "credit_limit": "numeric string",
    "total_balance": "numeric string",
    "posted_balance": "numeric string",
    "available_amount": "numeric string",
    "active_hold_amount": "numeric string"
  },
  "timestamp": "number"
}
```

For the current account, structural relations were verified without recording actual values:

- `total_balance == free_balance + plan_balance`
- `available_amount == total_balance - active_hold_amount`
- `available_amount` and `frozen` were non-negative

Candidate paths such as `/subscription/balance`, `/subscription/v1/balance`, and `/subscription/user/balance` returned 404. The full path above is the verified endpoint.

## Semantics and UI Recommendation

Use `available_amount` as the primary "available balance/credits" value because it accounts for active holds. Also expose:

- `free_balance`
- `plan_balance`
- `total_balance`
- `active_hold_amount`
- `frozen`
- `credit_limit`
- last successful refresh timestamp
- last query error

The official documentation and product site describe usage as points/Credits, while the API model is named `moneyValue` and does not include a unit field. Until a stable unit contract is confirmed, label the values as "额度/Credits" rather than currency and preserve the decimal strings without floating-point conversion.

## Operational Recommendation

- Query on account login success.
- Cache for a configurable interval, recommended 5 minutes.
- Allow manual refresh from the WebUI with server-side rate limiting.
- Refresh after upstream insufficient-balance responses.
- Treat balance lookup failure as telemetry failure, not immediate account disablement.
- Treat an authenticated success with no usable balance as account-ineligible only when the upstream request path independently returns an insufficient-balance error; avoid guessing from a single field.
- Never return OAuth tokens or upstream `user_id` unmasked in normal list APIs.
