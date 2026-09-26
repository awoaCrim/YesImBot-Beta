# Bootstrap Task: Remove Non-Project Spec Scaffolding

## Resolution

The initial Trellis bootstrap created guideline trees for `v7`, `new-api`, and
`pi-remote-compact`. None of these are source packages or maintained project
modules in this repository: the repository contains `core/`,
`packages/agent-runtime/`, `plugins/`, and `providers/` instead.

The three unrelated spec trees were removed rather than filled with generic or
remote-environment guidance. Existing guidelines for the actual repository
packages, the `yesimbot` architecture, `ops`, and the local `pi-subagent`
integration were preserved.

## Checklist

- [x] Confirmed `v7` is not a repository source package.
- [x] Confirmed `new-api` is not a repository source package.
- [x] Confirmed `pi-remote-compact` is not a repository source package.
- [x] Removed `.trellis/spec/v7/`.
- [x] Removed `.trellis/spec/new-api/`.
- [x] Removed `.trellis/spec/pi-remote-compact/`.
- [x] Preserved the remaining project-related spec trees.
- [x] Code examples: not applicable because the removed trees have no in-repository implementation to document.

## Verification

- `python ./.trellis/scripts/get_context.py --mode packages` no longer lists
  the removed spec packages.
- The three target directories no longer exist.
- No source files or existing user changes outside these target spec trees were
  modified.
