# Technical Design

## Root cause

The production Koishi process runs from `/var/lib/docker/volumes/yesimbot_koishi-app/_data` (`/koishi` in the container), while the YesImBot source workspace lives under `/var/lib/docker/volumes/yesimbot_koishi-app/_data/yesimbot-v4` (`/koishi/yesimbot-v4`).

The new workspace package exists and builds correctly, but only the source workspace has the Yarn link:

```text
/koishi/yesimbot-v4/node_modules/koishi-plugin-yesimbot-image-tools
  -> /koishi/yesimbot-v4/plugins/image-tools
```

The running app root has no corresponding dependency or link. Koishi loader logs the configured key and then reports:

```text
cannot resolve plugin "yesimbot-image-tools"
```

`@koishijs/plugin-config` scans the app-root `node_modules`, so it also treats the package as not installed. The custom YesImBot panel's `yesimbot-*` legacy fallback can incorrectly display the configuration as enabled; changing that fallback would hide the cause rather than fix installation.

## Boundary and solution

Do not change WebUI status logic or image-tool behavior. Use the repository's existing integration flow:

```text
yesimbot-v4/scripts/setup-koishi.mjs --no-pull
  -> collectPluginPackages()
  -> update the Koishi app package.json with workspace:^ dependency
  -> yarn install in the Koishi app root
  -> create root node_modules workspace link
  -> build and verify all plugin package resolution
```

The command should target the existing app root explicitly and use the local dirty workspace without pulling or reverting it:

```text
node scripts/setup-koishi.mjs \
  --app /var/lib/docker/volumes/yesimbot_koishi-app/_data \
  --no-pull
```

The setup flow may rewrite `koishi.yml` into canonical YAML and rebuild packages. A semantic before/after comparison must prove that only the intended dependency/config representation changes; credentials are compared in memory only.

## Runtime data flow

```text
plugins/image-tools/package.json
  -> setup-koishi collectPluginPackages()
  -> app-root package.json dependency: koishi-plugin-yesimbot-image-tools=workspace:^
  -> app-root yarn.lock + node_modules symlink
  -> Koishi ns-require from /koishi
  -> yesimbot-image-tools/dist/index.cjs
  -> plugin apply() registers channel AgentPlugin
  -> plugin-config PackageScanner sees package.json/schema
  -> WebUI packages service reports installed runtime metadata
```

## Compatibility

- Preserve the already migrated `yesimbot-image-tools:image-tools` configuration and all credential-bearing values.
- Preserve chat, vision, embedding, roleplay, Will, history, memory, notify, transport, Sandbox, and NapCat configuration/data.
- Do not republish the package or introduce a registry-wide package marker solely to compensate for a missing app-root installation.
- Do not restart NapCat. Restart only `yesimbot-koishi` after the app-root dependency is ready.

## Verification seams

1. From the app root, `require.resolve("koishi-plugin-yesimbot-image-tools")` must resolve into `yesimbot-v4/plugins/image-tools/dist`.
2. `node scripts/setup-koishi.mjs --app ... --no-pull --check` must pass all package resolution checks.
3. The package service (`packages` WebSocket data service) must contain the package with non-failed runtime metadata and a schema.
4. Startup logs must contain no `cannot resolve plugin "yesimbot-image-tools"` and must show the configured plugin applying without an error.
5. Existing YesImBot panel payload must show `yesimbot-image-tools` enabled with no attention issue.
6. Console assets remain HTTP 200 and the NapCat container identity/start time remain unchanged.

## Rollback

Create an owner-only backup before changing the app root containing:

- app-root `package.json` and `yarn.lock`;
- current `koishi.yml`;
- root `node_modules/.yarn-state.yml` and the absence/presence metadata for the new package link;
- source workspace lockfile and relevant package manifest hashes;
- Docker state and sanitized logs;
- a guarded rollback script.

The rollback guard checks the post-setup app-root manifest/lock/config and the new package link before stopping Koishi. It restores only the app-root manifest, lockfile, and config, then runs the supported Yarn install or removes only the new workspace link if the install cannot run. It never restores whole `node_modules`, source trees, conversation files, Persona/card, memory, or NapCat data.
