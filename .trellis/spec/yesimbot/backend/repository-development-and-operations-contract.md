# Repository Development and Operations Contract

## 1. Scope / Trigger

Use this contract when changing repository structure, package ownership, build outputs, Trellis integration, runtime boundaries, or production activation of YesImBot code.

The repository is a Yarn 4 monorepo for a Koishi-based message-first agent. The source checkout is the authority for code and tests. Runtime configuration, durable conversation data, credentials, and platform state are separate operational assets.

## 2. Repository ownership

| Area | Owner | Boundary |
|---|---|---|
| `core/` | `koishi-plugin-yesimbot` | Koishi integration, model registry, Messenger, Channel, Conversation, Agent, Runtime, and built-in platform registration |
| `packages/agent-runtime/` | `@yesimbot/agent-runtime` | Generic Agent loop, turn queue, storage, tools, plugin hooks, state, and runtime events |
| `plugins/*` | Optional Koishi plugins | Named Agent, Will, resource, console, workspace, MCP, memory, or platform extensions |
| `providers/*` | Model provider plugins | AI SDK adapter construction and model registration |
| `.trellis/` | Project workflow and knowledge | Tasks, specs, workflow, scripts, workspace journals, and validation context |
| `data/`, external app data | Runtime operations | Config, secrets, durable JSONL, assets, and live platform state; never treat as source code |

`core/src/messengers/` owns live Session admission and Translator calls. `core/src/runtimes/` owns FIFO scheduling, Agent execution, history projection, Will integration, and delivery tracking. Runtime code must not retain live Session references.

## 3. Source and dependency rules

- Use Yarn 4 with the repository's `nodeLinker: node-modules` configuration. Do not use `pnpm` or `npm` to mutate the dependency graph.
- TypeScript source and tests are the source of truth. `dist/`, `.turbo/`, Vite caches, and `node_modules/` are generated or installed state.
- Read [`AGENTS.md`](../../../AGENTS.md), the affected package spec index, and the relevant task artifacts before editing.
- Preserve unrelated dirty changes. Create a scoped backup before touching a shared or remote checkout.
- Do not copy or commit credentials, production `data`, durable JSONL, or raw platform messages as part of a code migration.
- Keep package names and workspace boundaries consistent with their `package.json` files. Do not add a second facade or duplicate an existing state machine without evidence.

## 4. Cross-layer contracts

- External model output must use `send_message`. Plain assistant text, reasoning text, tool receipts, and `turn.done` are not delivery evidence.
- A delivery is proven only by a non-empty message ID observed by the current channel's delivery callback. Preserve the existing `TurnDeliveryTracker`, reservation settlement, and delivery-wins-over-later-failure behavior.
- `finish` is an argument-free terminal tool. Intermediate tools continue the loop. Invalid tool calls and provider-defined tools without Core terminal metadata do not satisfy the terminal invariant.
- Provider capabilities must come from explicit model configuration. Never enable forced tool choice solely from a provider name.
- Historical projection is a read boundary. It must be non-mutating, idempotent, fail-closed for malformed markers, and must not rewrite durable JSONL or current-turn entries.
- Plugins register through the public `ctx.yesimbot` facades. They must not reach into private Runtime, Channel, Will, or storage internals when an existing extension point exists.

## 5. Development and verification

Before implementation:

1. Read the task `prd.md`, `design.md`, `implement.md`, and JSONL context files.
2. Read the affected package spec index and referenced contracts.
3. Search for existing ownership, tests, schemas, and public extension points.
4. Establish a focused regression test before changing behavior.

After implementation, run the narrowest applicable checks and record their exact outcome:

- affected package tests and the full affected package suite;
- `tsc --noEmit` or the package's declared type-check command;
- `oxfmt --check` and `oxlint` for affected files;
- affected package build;
- `git diff --check` and a check for generated or secret files;
- `python ./.trellis/scripts/task.py validate <task-dir>` for active Trellis tasks.

Classify unrelated failures instead of changing unrelated contracts to hide them. Static provider probes prove SDK request serialization and parsing only. They do not prove live model behavior, platform delivery, or user-visible results.

## 6. Trellis and task rules

- `.trellis/workflow.md` is the workflow source of truth and `.trellis/config.yaml` is the project configuration source of truth.
- `.trellis/spec/` stores source-backed, executable project contracts. Update a spec when a debugging or implementation result establishes a stable invariant.
- `.trellis/tasks/` stores PRDs, designs, implementation plans, research, and verification evidence. Do not place dependencies, build caches, or raw conversation logs in task research.
- `.trellis/.runtime/` and `.trellis/.template-hashes.json` are managed state. Do not hand-edit them without a clear migration reason.
- Keep platform assets such as `.pi/` and `.agents/skills/` aligned with the selected Trellis workflow. A workflow change must be checked against platform hooks, agents, skills, and commands.

## 7. Production activation and rollback

- Production activation requires explicit approval separate from implementation approval.
- Before activation, save an owner-only backup containing only the task-owned source/build/test scope, hashes, and a rollback script. Do not include credentials, chat history, or unrelated runtime data.
- Build from the reviewed source tree, validate package resolution and loadability, then atomically replace only the owned build outputs.
- Restart only `yesimbot-koishi`. Do not restart NapCat for a code-only change.
- Verify container running state, exit code, OOM state, restart count, startup markers, module resolution, and an authenticated or local HTTP health endpoint as applicable.
- Do not send a QQ or Sandbox canary unless it is separately approved. A healthy container and HTTP response do not prove that a live user received a model reply.
- If activation fails, restore the scoped backup, restart the same container, verify recovery, and preserve new runtime data.

## 8. Wrong vs Correct

### Wrong

- Copy `node_modules`, production `data`, secrets, and durable JSONL as if they were source code.
- Run `yarn`, `npm`, and `pnpm` interchangeably in a Yarn 4 workspace.
- Treat `dist/` or `.turbo/` as the source of truth.
- Mark delivery from assistant text, `tool.done.ok`, an empty ID list, or `turn.done`.
- Rebuild or replace unrelated plugins while activating a scoped task.
- Delete a remote source tree before a file-level migration check and rollback point exist.

### Correct

```text
source checkout -> focused tests -> type/lint/format -> package build -> scoped backup -> explicit activation -> health check
```

The local checkout contains code, tests, Git history, Trellis context, and generated build outputs. Runtime data and credentials remain outside the source migration boundary.
