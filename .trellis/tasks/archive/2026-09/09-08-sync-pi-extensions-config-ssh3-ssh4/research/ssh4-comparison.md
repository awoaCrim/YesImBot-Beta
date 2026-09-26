# ssh4 与本机 Pi 环境对比（只读盘点）

日期：2026-09-08。仅执行只读对比；未执行同步、未写 ssh4、未修改本机 SSH 之外的任何状态、未发送模型请求、未调用 Pi Web、未停止进程。

## ssh4 连接状态

- SSH alias：`ssh4`（`frp-bar.com:56242`，用户 `77565`，IdentityFile `id_ed25519sunshine`）
- host key 已由用户确认写入本机 `known_hosts`（[frp-bar.com]:56242 条目存在，known_hosts 中该主机共 3 条指纹）
- SSH 连接成功：远端 `OpenSSH_for_Windows_9.5`，登录用户 `knined\77565`，主机名 `KNINED`（Windows）
- 会话出现 post-quantum KEX 警告（OpenSSH 常规提示），不影响只读访问

## 版本基线（本机 canonical vs ssh4）

| 项目 | 本机 | ssh4 | 差异 |
| --- | --- | --- | --- |
| Pi CLI | `0.85.1` | `0.84.3` | **ssh4 落后一版**（0.85.0→0.85.1 属同线；0.84.3 旧线） |
| Pi 用户 packages | 16 条 | 16 条 | 见下表（其中 5 条为 ssh4 独有） |
| Node | `v24.11.1` | `v24.14.0` | ssh4 更新 |
| npm | `11.6.2` | `11.11.0` | ssh4 更新 |
| Git | `2.52.0.windows.1` | `2.55.0.windows.2` | ssh4 更新 |
| 全局 npm 包 | 11 顶层（@earendil-works/pi-coding-agent@0.85.1 等） | 有 @gotgenes、pi-intercom、pi-ssh-remote、pi-codex-goal 等，与本机集合不同 | 集合不一致 |
| 全局 skills | 12 个，位于 `~\.agents\skills\`（project-roaming） | 12 个同名，位于 `~\pi\agent\skills\global\` | 同名（同内容待 hash 核验） |
| 全局 agents | `~/.pi/agent/agents/approver.md` | `~\pi\agent\skills\agents\approver.md` | 同名存在 |

## package/source 对比（`pi list`）

| 本机 16 条 | ssh4 16 条 | 归因 |
| --- | --- | --- |
| npm:pi-mcp-adapter | npm:pi-mcp-adapter | 一致 |
| npm:pi-powerline-footer@0.12.1 | npm:pi-powerline-footer@0.12.1 | 一致（注意 ssh4 无 `@0.12.1`，实际 0.12.1） |
| npm:pi-web-access | npm:pi-web-access | 一致 |
| — | **npm:pi-intercom** | 仅 ssh4；目标独有扩展，保留 |
| npm:@juanibiapina/pi-extension-settings | npm:@juanibiapina/pi-extension-settings | 一致 |
| npm:@juicesharp/rpiv-ask-user-question | npm:@juicesharp/rpiv-ask-user-question | 一致 |
| — | **npm:@juicesharp/rpiv-todo** | 仅 ssh4；保留 |
| npm:@narumitw/pi-btw | npm:@narumitw/pi-btw | 一致 |
| npm:@ff-labs/pi-fff | npm:@ff-labs/pi-fff | 一致 |
| npm:pi-context-view@0.4.1 | npm:pi-context-view@0.4.1 | 一致 |
| npm:pi-rtk-optimizer | npm:pi-rtk-optimizer | 一致 |
| npm:pi-openai-toolkit | **npm:pi-openai-toolkit@0.4.1** | **版本 spec 冲突**（本机无版本 pin，ssh4 pin 0.4.1；需字段级合并） |
| npm:pi-cache-stack | npm:pi-cache-stack | 一致 |
| — | **npm:pi-ssh-remote** | 仅 ssh4；保留 |
| git:github.com/awoaCrim/preserveScrollbackPatch | — | 仅本机；同步候选 |
| npm:pi-dynamic-workflows | — | 仅本机；同步候选 |
| npm:pi-tool-display | — | 仅本机；同步候选 |
| — | **npm:@gotgenes/pi-subagents** | **subagent 冲突**：本机为 `@cr1ms0n/pi-subagent@0.8.1`（ssh3 为 `@parke.dev/pi-subagent@0.8.0`，三方各不相同） |
| — | **npm:pi-codex-goal** | 仅 ssh4；保留 |
| npm:@cr1ms0n/pi-subagent@0.8.1 | — | 本机活动 package |
| git:…/pi-sakura-cyberdeck (filtered) | — | 仅本机；项目相关（theme） |

**当前冲突结论（model-preserve）**：subagent package lineage 三方分裂，且 ssh4 的 `pi-openai-toolkit@0.4.1` pin 与本机不同；两类 package 都涉及 model policy/toolkit 行为，默认保留 ssh4 版本与活动引用，不安装本机版本。其余本机独有 package 只能在逐包审核并确认非模型后成为候选；ssh4 独有 package 全部保留。

## 核心配置对比

| 文件 | 本机 | ssh4 | 判定 |
| --- | --- | --- | --- |
| `AGENTS.md` | 根目录 5202 B，含 model-profile 区块 | **无根目录文件**；位于 `agent/prompts/AGENTS.md`，SHA256 `d666c852…`（旧通信风格版，不含 model-profile） | 内容不同 + **目录位置不同**；同步需同时处理布局迁移 |
| `APPEND_SYSTEM.md` | 根目录 7130 B | 位于 `agent/prompts/APPEND_SYSTEM.md`，SHA256 `6dec5117…` | 内容不同 + 位置不同 |
| `keybindings.json` | 90 B，存在 `{"app.clear":"ctrl+l",…}` | **不存在** | 本机独有；同步候选 |
| `settings.json` | 2052 B，SHA256 `e06b2745…` | 1669 B，SHA256 `b4654042…` | 不同；差异主因 packages/settings 内容 |
| `auth.json` | 2171 B（存在） | 104 B（存在） | 只做存在性；**不同步** |
| `models.json` | 5607 B，SHA256 `4d33fe80…` | 5104 B，SHA256 `1fcf5fe4…` | 只有脱敏元数据；**不同步内容** |
| `models-store.json` | 9343 B，SHA256 `f23471dc…` | **2 B（空 `{}`）**，SHA256 `44136fa3…` | 大小/状态差异极大；**不同步** |
| `trust.json` | 260 B | 不存在 | 本机项目相关内容；**不部署** |
| `run-history.jsonl` | 33.3K | 不存在 | 运行状态；不部署 |
| `mcp-cache.json` | 100.5K | 不存在 | 缓存；不部署 |
| `mcp-npx-cache.json` / `cache-stack.json` | 存在 | 不存在 | 缓存/运行产物；不部署 |
| `model-prompt-router.json` | 存在 | 不存在 | 模型路由配置；model-preserve，不部署 |
| `pi-web-credentials.json` | —（本机无） | 110 B，存在 | 凭据；只做存在性，**不读取/不复制** |
| `powerline-footer/` | —（ext 配置） | `inbox.jsonl` 1815 B | 运行时状态；不部署 |

## extensions 对比

| 位置 | 本机 | ssh4 |
| --- | --- | --- |
| `agent/extensions/` | 32 个文件，9 个子目录/文件（anon-notify、cache-probe、model-prompt-router、pi-openai-toolkit、pi-rtk-optimizer、pi-tool-display、powerline-footer、rtk.ts、subagent、subagent-guidance） | 仅有 3 个文件：`pi-rtk-optimizer/`、`rtk.ts`、`subagent-guidance/` |
| 全局 skills | 12 个（`~/.agents/skills/`，hash 已记录） | 12 个同名（`agent/skills/global/`） |
| extensions hash | 本机 SKILL.md hash：codebase-design `22d3815e…`、diagnosing-bugs `3dfe5ec1…`、domain-modeling `004d5cb6…`、handoff `65e80725…`、implement `30cd7bc1…`、improve-codebase-architecture `411f295e…`、prototype `c2a9cc54…`、research `0b6597c4…`、resolving-merge-conflicts `726cc35e…`、tdd `2de14b89…`、teach `99c077a0…`、writing-great-skills `8c38389d…` | 访问时 `dir` 语法受限，未能逐一 hash；同名列表一致 |

## 状态/元数据（仅存在性/类型/bytes/mtime，未读内容）

- `sessions/`：ssh4 存在 21 个文件 37,489,572 B + 8 个子目录（含 session 文件与快照目录），最近 2026-09-08；运行状态，**不部署**。
- `fff/`（frecency/history）、`intercom/`（extension-state、pending-asks、broker-launch.vbs）、`bin/fd.exe、rg.exe`、`ssh-remote-memories/`（空）：ssh4 运行/工具状态，不部署。
- 本机有 `~/.pi/subagent.json`、`pi-cache-stack/`、`subagent-locks/`、`subagent-sessions/`、`web-search-cache/`、`context-mode/`、`migration*/` 等；ssh4 无对应，均为本机运行时/项目状态，不部署。
- 机器绝对路径 fixture：本机路径含 `C:\Users\Administrator\…` 与 user `Administrator`；ssh4 用户为 `77565`、路径 `C:\Users\77565\…`。**任何同步内容中的 `Administrator` 绝对路径都不能直接写入 ssh4**（与 ssh3 对比时的 `notify-webhook.test.mjs` 同理）。

## model-preserve allowlist（待写入授权）

1. `keybindings.json`：确认非模型 UI 配置后可 whole-file 新建。
2. extension：只能逐文件审核；确认非模型、非凭据、无本机绝对路径后才可 whole-file。`model-prompt-router/`、subagent model policy 实现/config、`pi-openai-toolkit/config.json` 明确排除。
3. package：当前安装清单为空。本机独有 package 必须逐包审核；涉及模型/toolkit/model policy 或无法分类的 package 不安装。
4. `AGENTS.md` / `APPEND_SYSTEM.md`：本机文档含模型相关区块且两侧布局不同，禁止整文件覆盖；只有布局决策完成并能安全切分时才可 section-merge，否则保留 ssh4 版本。
5. `settings.json`：只能合并确认非模型的字段；`packages` / `extensions` 列表不进入 field patch，目标模型字段、目标 package 条目、目标独有字段和 CLI 版本字段保留。不可靠分类时跳过整个文件。

## 必须保留（target-owned，不复制、不删除）

- `auth.json`、`pi-web-credentials.json`、`models.json`、`models-store.json`（凭据/模型状态，只做元数据核验）
- ssh4 独有 package：`pi-intercom`、`@juicesharp/rpiv-todo`、`pi-ssh-remote`、`pi-codex-goal`、`@gotgenes/pi-subagents`
- `trust.json`（本机项目 trust 不进 ssh4）、`sessions/`、`fff/`、`intercom/`、`powerline-footer/inbox.jsonl`、`ssh-remote-memories/`、`bin/`
- 机器/用户路径：ssh4 的 `C:\Users\77565\…` 结构与本机不同，同步时禁止覆盖其用户级目录

## 风险点

- **subagent lineage 三方分裂**（本机 / ssh3 / ssh4 各不同）：该 package 携带 model policy，按 model-preserve 保留 ssh4 active package，不安装本机 fork、不改写 settings package 引用。若要统一 lineage，必须另开迁移设计并单独授权。
- **Pi CLI 版本差**（0.84.3 vs 0.85.1）：settings.json 中 `lastChangelogVersion: 0.84.1`；同步前需考虑是否先升级 CLI 或只同步兼容字段。
- **AGENTS.md / APPEND_SYSTEM.md 布局迁移**：ssh4 用 `prompts/` 子目录布局，本机用 agent 根目录布局；直接复制会创建旧文件并存，需决策迁移策略。
- **全局 npm 集合分裂**：ssh4 有本机没有的全局 CLI（opencode-ai、claude-code-patched 等），不纳入同步范围（全局 npm 不在本次扩展同步 allowlist）。

## 下一步建议

1. 决策 `AGENTS.md` / `APPEND_SYSTEM.md` 布局：统一到 Pi 用户根，还是保留 ssh4 `prompts/` 布局；两种方案都只允许非模型 section 合并，不能整文件覆盖含模型区块的文档。
2. 决定是否仅同步 `keybindings.json`，或再批准逐文件非模型 extension allowlist。
3. package 默认不安装；只有完成逐包非模型审核后才加入 install-only 清单。subagent 与 `pi-openai-toolkit` 保留 ssh4 版本和 config。
4. `settings.json` 仅尝试不含 `packages` / `extensions` 的非模型字段补丁；schema/嵌套语义不可靠即整个文件跳过。
5. ssh4 CLI `0.84.3` 升级属于独立任务，不纳入本次环境同步。

## 附录：本机核心文件元数据（供比对）

| 文件 | bytes | mtime | SHA256 |
| --- | --- | --- | --- |
| AGENTS.md | 5202 | Sep 8 16:01 | 228cf4964cfa240af1396cdb9ebec780ac26f62abdd0b4ba1f3dc0080caf0a35 |
| APPEND_SYSTEM.md | 7130 | Sep 7 01:43 | 6b9943d94d61c09524b2c5035b825560f86e9fad3169baca5379c722d705538c |
| keybindings.json | 90 | Aug 9 20:42 | f0b91362ff75219c1e85200cf6dd7cb18b3cdcf66b54f05127092c6acadd15a0 |
| settings.json | 2052 | Sep 8 17:37 | e06b2745781e522ae3e7aeae0ab444e3b2bb4912f5de0c0965cd037df42a42ce |
| auth.json | 2171 | Sep 7 20:53 | 03e719250059856dcd10e27f3f43ace1f5787df29a785d18fa894d840536745e |
| models.json | 5607 | Sep 8 00:51 | 4d33fe807764432e7fc1324a191ecab295319ee08e31a30125d8d86081e77190 |
| models-store.json | 9343 | Sep 8 19:33 | f23471dccca941ef53a9a42e698a200f78b1848f257a43473d97c9d6827d2837 |
| trust.json | 260 | Aug 17 21:25 | — |
| run-history.jsonl | 33310 | — | — |
| mcp-cache.json | 102885 | Sep 8 12:01 | — |

ssh4 关键 hash：settings.json `b4654042d7f0481…`；prompts/AGENTS.md `d666c85229…`；prompts/APPEND_SYSTEM.md `6dec5117f8…`；models.json `1fcf5fe479…`；auth.json `6ee564ca9a…`；models-store.json `44136fa355…`（空对象）。脱敏元数据均不包含内容/凭据。