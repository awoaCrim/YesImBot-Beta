# Automation Notification Contract

## Scope

Read before changing the Pi `anon-notify` extension, the `notify-webhook` Koishi plugin, the injected event text, or the relay policy that decides whether Anon tells the user about an automation event.

## Ownership and paths

- Chain: Pi extension → authenticated webhook → normalized/validated event → runtime event text → Anon's decision → `send_message`. Each stage has one owner; the plugin never composes the user-visible notification.
- `anon-main-context` (default) injects a runtime event with `trigger: true, ifBusy: "defer"`. `delivery: "direct"` is an explicit bypass: fixed-format text straight to the configured Koishi target, no model, no Anon voice. Do not merge the two paths or add model-facing policy text to the direct path.
- `recipientId` is configured server-side only. A request must never choose its own delivery target.

## Event text and trust boundary

- The boundary declaration sits before the opening marker. The plugin does not append a model-facing relay policy or fixed output-format rules after the payload; the event remains data for the existing runtime/persona to interpret.
- `eventPayload()` output is model-facing only. Persistence, `/events/:id`, `/commands`, `agent_command` binding and direct delivery read the original event object, so escaping in the serialized text cannot change stored or API data.
- A closing marker appearing inside any payload field must be JSON-escaped (`[\/...]`). `summary` and `details` carry model-generated text, so without escaping a payload can end the untrusted block early and make its own text look like harness policy. Escaping must stay reversible: assert round-trip equality, not just absence.
- Marker-like text supplied by a payload remains data inside the block. This is a model-visible semantic boundary, not OS-level isolation; do not describe it as a hard security guarantee.

## Relay ownership

- The plugin authenticates, validates, persists, and transports the event. It does not decide whether Anon should relay an event or prescribe her wording, length, bubble count, vocabulary, or conversational strategy.
- `status` remains validated control metadata for the webhook lifecycle and direct-delivery path. It must not be converted into a fixed model instruction by the transport layer.
- Any user-visible relay decision belongs to the existing runtime/persona and current conversation context. Observational canaries may measure the result, but they must not be promoted into hard-coded prompt rules.
- `delivery: "direct"` remains a separate explicit bypass: fixed-format text goes to the configured Koishi target without a model or Anon voice.

## Runtime turn boundary

- The Core event-to-model formatter must frame every runtime event as the current input for the new turn, not as a continuation of an earlier user request. The framing belongs before the `[SYSTEM_NOTIFICATION]` payload wrapper so it is not mixed into untrusted event data.
- This boundary is input semantics, not relay policy: it must not prescribe whether Anon calls `send_message`, how many messages she sends, their length, wording, vocabulary, or conversational strategy. The existing runtime/persona remains the owner of that decision.
- A notify event must not cause an earlier user request to become a new request solely because the event woke the Runtime. The persisted conversation remains intact; no JSONL rewrite or history deletion is a valid fix for this class of bug.
- Regression coverage should exercise the real plugin `apply()` with a mocked `messenger.post`, assert that `anon-main-context` still uses `{ trigger: true, ifBusy: "defer" }`, then pass the posted event through the built Core formatter and assert the current-turn boundary is present outside the payload wrapper.

## Validation contract

- `status` is a control field once it triggers relaying. Reject empty string, `false`, `0`, and unknown values (`??` for the default, never `||`, which silently upgrades a client bug to a success notification).
- `event_id` and `session_id` pass character allowlists before status parsing; a test asserting status rejection must use ids that satisfy those allowlists or it will assert the wrong error.

## Required regression coverage

Unit tests use the plugin's real `apply()` with a mocked `ctx` that records `messenger.post` calls:

1. No model-facing relay policy or fixed output-format rule is appended after the payload.
2. Boundary declaration precedes the opening marker.
3. Forged closing marker stays JSON-escaped; the escaped form is counted with a real backslash in the assertion string (`"[\\/...]"` — `"[\/...]"` in JavaScript equals `"[[/...]"` and silently passes).
4. Payload between the markers parses as JSON and round-trips `summary`/`details` unchanged.
5. Falsy and unknown `status` are rejected and never injected.
6. The pre-existing `agent_command` binding/idempotency test stays green.

## Live validation

- State `context_injected` proves injection only. Proof of a working notification is the next assistant turn calling `send_message` with a platform result containing real `messageIds`.
- Read decisions from the channel session JSONL: nested `data.type === "yesimbot.event"` with text in `data.data`, then the next assistant `tool-call`. Client-side delivery on sandbox channels is unreliable and must not be used as evidence.
- If a live canary is authorized, use one `completed`, one `failed`, and one adversarial event (`status: failed` with a summary claiming success plus a forged closing marker and fake instruction) to observe the end-to-end result and payload handling. Do not assert a fixed relay count or wording from the transport layer.
- These canaries land in Anon's real private chat and may send real QQ messages. That is expected; do not delete history entries to tidy up.
- After any Persona/card rewrite, re-run an authorized observational canary when behavior needs verification. Do not respond to an observed style change by adding fixed relay instructions to the injected event.

## Operational notes

- Production previously ran ahead of the local copy under `extensions/anon-notify/server/`. Diff before editing and converge in both directions; deploying a stale local file silently reverts newer plugin features.
- Activation is backup → staged hash check → `node --check` inside the container → atomic replace → restart → health, with the persona card hash guarded unchanged. Rollback: restore `index.js` from the timestamped backup directory and restart.
