# Implementation Plan / Results

## 1. Preflight and backup

- [x] Confirm the remote host is `ssh2` and capture app-root/source paths.
- [x] Record app-root `package.json`, `yarn.lock`, `koishi.yml`, root Yarn state, source lockfile, Docker state, and NapCat invariants.
- [x] Create an owner-only backup under `/opt/yesimbot/backups/` with per-file hashes and a guarded rollback script.
- [x] Confirm the current failure with `setup-koishi --check`, root `require.resolve`, and sanitized startup logs.

Backup: `/opt/yesimbot/backups/image-tools-webui-registration-20260914T050144Z/`. The guarded rollback is limited to the app-root manifest/lock/config/Yarn state and the new package link; it never restores conversation data, Persona/card files, source history, or NapCat state.

The initial failure was an app-root/workspace boundary issue. The production process uses `/var/lib/docker/volumes/yesimbot_koishi-app/_data` (`/koishi` in the container), while the source workspace is under `yesimbot-v4`. The source workspace had the image-tools link, but the app root had neither the dependency nor the link. Koishi logged `cannot resolve plugin "yesimbot-image-tools"`, and the custom YesImBot panel's legacy fallback was therefore a false positive.

## 2. Synchronize the app-root installation

- [x] Run the existing local-workspace setup flow with `--app /var/lib/docker/volumes/yesimbot_koishi-app/_data --no-pull` (host-side attempt failed at an unrelated portal path; container-side install completed).
- [x] Verify the only intended app-root dependency addition is `koishi-plugin-yesimbot-image-tools: workspace:^` and the lockfile has its workspace entry.
- [x] Verify `/koishi/node_modules/koishi-plugin-yesimbot-image-tools` points to `yesimbot-v4/plugins/image-tools` and resolves its built CommonJS entry.
- [x] Confirm the setup flow's package-resolution verification passes for all managed plugins.

The first host-side setup attempt reached the intended manifest update but stopped because the host view did not expose the container-mounted `data/plugins/notify-webhook` portal target. This was an environment/path failure, not an image-tools failure. The same setup flow completed from inside the Koishi container, and the host-side `--check` then passed every managed plugin resolution, including:

```text
koishi-plugin-yesimbot-image-tools -> yesimbot-v4/plugins/image-tools/dist/index.cjs
```

The app-root manifest diff contains exactly one dependency addition; no `devDependencies` changed. The root link is:

```text
../yesimbot-v4/plugins/image-tools
```

The container-side check can report `yesimbot is not on dev` because Git metadata is not mounted there. The host-side check, where the source Git metadata is available, is the authoritative setup verification and passed with exit code 0.

## 3. WebUI/runtime verification

- [x] Restart only `yesimbot-koishi` after app-root installation; do not restart NapCat.
- [x] Verify startup no longer logs `cannot resolve plugin "yesimbot-image-tools"` and the plugin applies without an error.
- [x] Query the authenticated console `packages` data service without printing credentials; assert the image-tools package has package metadata, schema/runtime data, and no `failed` flag.
- [x] Query `yesimbotPanel`; assert `yesimbot-image-tools` is enabled and no attention entry is caused by package resolution.
- [x] Verify `/`, `/index.js`, `/style.css` return HTTP 200 and NapCat ID/start time/restart count are unchanged.

After installation, Koishi was restarted at `2026-09-14T05:08:14.551626614Z` UTC. A follow-up config cleanup removed three empty disabled placeholders that `setup-koishi.mjs` had added for unrelated managed plugins; only Koishi was restarted again at `2026-09-14T05:18:45.920780075Z` UTC. The final restart was clean:

- `yesimbot-koishi`: running, exit code 0, `OOMKilled=false`, restart count 0.
- Startup applies `yesimbot-image-tools:image-tools`.
- No `cannot resolve plugin`, missing-module, or severe startup matches were found in the post-restart log window.
- `/`, `/index.js`, and `/style.css` on port `15140` each returned HTTP 200.
- NapCat container identity, start time (`2026-09-11T16:37:12.361256872Z` UTC), running state, and restart count 0 were unchanged.

The authenticated console WebSocket check returned both `packages` and `yesimbotPanel` data. The `packages` entry for `koishi-plugin-yesimbot-image-tools` had workspace/package metadata, manifest metadata, runtime metadata, a runtime schema, and runtime usage data; it had no failed flag. The panel entry was `enabled=true`, `status=enabled`, `detail=已启用`, with `panelAttentionCount=0`. Authentication values and provider options stayed server-side.

## 4. Regression and compatibility checks

- [x] Run image-tools focused tests and affected package checks/builds as needed after setup.
- [x] Re-run semantic config comparison: image key/baseURL/model/editModel/timeout and all unrelated provider/core/persona/Will/history settings are unchanged.
- [x] Confirm no API key or authorization value appears in local task/spec artifacts or emitted diagnostics.
- [x] Do not send a real QQ message. No additional Sandbox message is needed because the current issue is package resolution, not chat behavior.

Focused verification passed on the remote source workspace:

- `npx vitest run plugins/image-tools/tests --reporter=dot`: 3 files, 23 tests passed.
- `yarn workspace koishi-plugin-yesimbot-image-tools check-types`: passed with the workspace root binary path available.
- `yarn workspace koishi-plugin-yesimbot-image-tools build`: passed.
- `npx oxfmt --check plugins/image-tools`: passed.
- `npx oxlint plugins/image-tools`: 0 warnings, 0 errors.
- The source workspace `yarn.lock`, root source `package.json`, image-tools manifest, and source `.yarnrc.yml` match the post-install snapshots; the source workspace lockfile was not changed by deployment or the focused build.
- `node scripts/setup-koishi.mjs --app /var/lib/docker/volumes/yesimbot_koishi-app/_data --no-pull --check`: passed all managed package resolutions.
- Remote `git diff --check`: passed.

The post-setup YAML was compared in memory against the pre-setup snapshot. The setup-added disabled placeholders for `yesimbot-quota`, `yesimbot-schedule`, and `yesimbot-usage` were removed after verifying that they were the only unrelated semantic differences. The final parsed configuration matches the pre-setup configuration; the image `enabled`, `baseURL`, `model`, `editModel`, `timeout`, and secret `apiKey` fields all compare equal in memory. No credential value was printed or written to task/spec artifacts.

A full Turbo build remains out of scope for this registration fix because an earlier full run also surfaced pre-existing provider `contextWindow` type errors in unrelated DeepSeek/Anthropic model definitions. The focused image-tools build and checks pass; those baseline errors were not changed or hidden.

## 5. Documentation and finish

- [x] Update `.trellis/spec/yesimbot/backend/index.md` with the app-root/workspace installation contract and the setup placeholder/config-preservation gotcha.
- [x] Record root cause, failed host attempt/path distinction, successful container install, restart/verification, backup/rollback path, source-lock/style checks, and remaining baseline issue in this task's `implement.md`.
- [x] Run `python ./.trellis/scripts/task.py validate .trellis/tasks/09-14-image-tools-webui-registration` and remote `git diff --check` for scoped source changes.
- [x] Present final verification results; no Git commit was created.

Final rollback guard: `/opt/yesimbot/backups/image-tools-webui-registration-20260914T050144Z/state/live-target.sha256.after` passes for the final app-root manifest, lockfile, Yarn config/state, and config. The backup also retains the pre-cleanup post-setup config at `state/koishi.after-setup-before-cleanup.yml` for auditability.
