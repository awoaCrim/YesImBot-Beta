# Roleplay Greeting and Image Tools Ownership

## 1. Scope / Trigger

This contract applies when changing the roleplay plugin's automatic character-card greeting or the ownership of `generate_image` / `edit_image` in the YesImBot v4 backend.

The two behaviors have separate owners:

- `plugins/roleplay` controls whether a newly initialized empty **direct** runtime seeds the card's rendered `first_mes`.
- `plugins/image-tools` owns image-generation and image-editing agent actions.
- `providers/openai` remains responsible for OpenAI-compatible chat/embedding model registration and image tool-result response handling; it must not own image action registration.

Do not modify the PNG character-card metadata merely to disable the greeting. Do not introduce a Core-wide image-model registry for this seam unless a separate design is approved.

## 2. Signatures

### Roleplay configuration

```ts
interface RoleplayPluginConfig {
  characterCard: string;
  useRandomGreeting?: boolean;
  enableGreeting?: boolean; // schema default: true
}
```

`RoleplayPlugin.setup(scope, bot)` passes the selected greeting only when `scope.type === "direct"` and `enableGreeting !== false`; otherwise it passes an empty greeting. `createRoleplayPlugin().init()` must leave storage unchanged when the rendered greeting is empty or a message already exists.

### Image-tools configuration

Package: `plugins/image-tools`
Package name: `koishi-plugin-yesimbot-image-tools`

```ts
interface ImageToolsConfig {
  enabled?: boolean;       // schema default: true
  apiKey: string;          // secret, required by schema
  baseURL?: string;        // OpenAI-compatible Images API origin
  model?: string;          // required when enabled
  editModel?: string;      // falls back to model when omitted
  timeout?: number;        // seconds, schema range 1..600, default 120
}
```

When enabled, the plugin registers one channel-scoped `AgentPlugin` named `image-tools` exposing exactly:

```text
generate_image
edit_image
```

The plugin setup receives `ChannelResources` from `ctx.yesimbot.resource.get(scope)` and uses the runtime-owned `EphemeralImageProjectionStore` when available.

## 3. Contracts

### Greeting

- `enableGreeting` defaults to `true` for backward compatibility.
- Production may set `enableGreeting: false`; this suppresses only automatic greeting seeding for new direct sessions.
- `first_mes`, `alternate_greetings`, card loading, CBS rendering, and PNG bytes remain unchanged.
- Existing sessions are not rewritten. A restart is required because the roleplay plugin caches the card and registered agent plugin at startup.
- Group runtimes keep their existing no-greeting behavior.

### Image ownership and behavior

- `plugins/image-tools` creates the OpenAI-compatible image client and owns image operation configuration.
- `image-generation.ts`, `image-edit.ts`, and `image-output.ts` live with the new plugin and preserve their existing input/output and error contracts.
- Preserve `artifact://` output URIs, resource reads, output-byte validation, the shared per-turn three-image budget, temporary image projection, abort/cancellation behavior, timeout classification, and cleanup on turn finish and plugin stop.
- The provider keeps `image-tool-result.ts` and its `imageToolResultSupport` / placement handling because those transform provider chat results rather than register image actions.
- Core `read` and `describe_image` tools are unchanged.
- Disabling the new plugin must register no agent plugin. Enabling it without a model is invalid.

### Configuration migration and deployment

- Move the existing image endpoint, key, model, optional edit model, and timeout from the old provider-owned image entry to `yesimbot-image-tools`; compare credential-bearing fields server-side only.
- Remove the old `imageGeneration` block and old provider image-tools entry.
- Preserve chat, vision, embedding, Persona, Will, history, resource, notify, transport, and QQ settings.
- Use an owner-only scoped backup and a hash-guarded rollback that restores only the affected config and dist files.
- Restart only `yesimbot-koishi`; do not restart NapCat and do not clear non-Sandbox history.
- Koishi may normalize YAML formatting on startup. After semantic equivalence is verified, record the post-start config hash in the live rollback guard; do not weaken the guard to ignore arbitrary later edits.

## 4. Validation & Error Matrix

| Condition | Required result | Action |
|---|---|---|
| `enableGreeting` omitted | Backward-compatible default `true` | Keep existing behavior |
| `enableGreeting: false` | Empty new direct runtime has no seeded assistant greeting | Verify storage before the first user message |
| Image plugin disabled | No `agent.use()` registration | Do not create the image client |
| Image plugin enabled without `model` | Deterministic configuration error | Refuse startup/tool registration |
| `timeout < 1` or `timeout > 600` | Schema validation failure | Refuse configuration |
| Old provider `imageGeneration` remains | Ownership migration incomplete | Stop before activation |
| Live files differ from the guarded target | Rollback exits without changing files | Investigate concurrent edits first |
| Candidate build hash differs from backup | Deployment artifact is stale | Rebuild/update the scoped candidate and manifest |
| New image operation exceeds the shared three-output budget | `image_budget_exhausted` result | Do not call the upstream image endpoint |
| Startup loads old provider image entry | Wrong config/dist is active | Stop and correct activation; no behavior claim |

## 5. Good / Base / Bad Cases

- **Good**: Set `enableGreeting: false`, keep the card intact, move image settings into the standalone plugin, retain provider image-result middleware, run focused tests, and verify a unique Sandbox direct session has no old greeting occurrence.
- **Base**: Keep the default greeting switch enabled for an un-migrated installation and use the standalone plugin only when explicitly configured.
- **Bad**: Delete or rewrite `first_mes`, leave `imageGeneration` under `providers/openai`, copy a key into source or logs, add a second Core image registry for one backend, or bypass the rollback hash after Koishi rewrites config.

## 6. Tests Required

- Roleplay plugin tests assert enabled direct greeting seeding and disabled direct empty storage; card/CBS tests remain green.
- Image-tools registration tests assert disabled no-op, missing-model rejection, exactly the two public tool names, shared budget, turn-finish cleanup, and stop cleanup.
- Moved image tests retain success, timeout, abort, invalid input, artifact failure, output validation, and budget exhaustion coverage.
- Provider tests assert no `imageGeneration` schema or image action registration while chat/embedding and image-result capability tests remain green.
- Run affected package TypeScript checks, `oxfmt --check`, `oxlint`, and package builds. A pre-existing provider type-check failure must be recorded rather than hidden with a type escape.
- After deployment, verify `yesimbot-koishi` is running with `ExitCode=0` and `OOMKilled=false`, console `/`, `/index.js`, and `/style.css` return HTTP 200, startup loads `yesimbot-image-tools` and not the old provider image entry, and the scoped rollback guard passes.
- A live Sandbox smoke may use a unique direct user/channel and an authenticated server-side console RPC. Distinguish the Sandbox echo from the Bot reply, revoke the temporary token, and never send real QQ traffic.

## 7. Wrong vs Correct

### Wrong

```yaml
plugins:
  group:yesimbot:
    '@yesimbot/provider-openai:image-tools':
      imageGeneration:
        enabled: true
        model: gpt-image-2
```

This couples unrelated action registration to a general provider and makes the image lifecycle depend on the provider instance.

### Correct

```yaml
plugins:
  group:yesimbot:
    yesimbot-roleplay:instance:
      enableGreeting: false
    yesimbot-image-tools:image-tools:
      enabled: true
      model: gpt-image-2
      timeout: 240
```

The secret `apiKey` and endpoint are copied only on the server. The standalone plugin owns the two image actions, while the OpenAI provider remains a model/result adapter.
