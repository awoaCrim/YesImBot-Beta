# 以本机为准同步 Pi 扩展与配置到 ssh3/ssh4

## Goal

先只读盘点本机、ssh3、ssh4 当前 Pi 环境的差异；确认范围后，以本机当前环境中的**非模型**用户级配置与扩展为来源，同步到 ssh3 和 ssh4，同时保留两台目标机各自的密钥、模型配置、认证和项目相关状态。将本次已验证的本机 Pi → Windows SSH 目标流程整理为 project-local 共享 skill，并把 model-preserve 作为该 skill 的默认安全策略，供后续按参数复用。

## User value

让 ssh3/ssh4 的 Pi 非模型扩展和用户级配置与本机保持一致，减少 CLI/extension 行为漂移；同时不覆盖目标机自己的 API key、OAuth/auth 状态、模型选择与路由配置、项目 trust 和运行历史。

## Confirmed intent

- 来源：当前本机 Pi 环境中的非模型部分（用户级非模型配置 + 审核过的非模型 extension）。
- 目标：ssh3、ssh4。
- 同步对象：Pi 扩展 + 用户级非模型配置。
- **model-preserve（2026-09-08 用户补充的硬边界）**：不把本机密钥或任何模型相关配置同步到目标，尤其适用于尚未同步的 ssh4。范围覆盖 auth、真实 `models.json` / `models-store.json`、Pi Web 凭据、provider credential fields、API/OAuth/token/authorization/private key，以及模型选择/路由/压缩类配置。
- 密钥策略：ssh3 和 ssh4 保留各自的密钥，不能使用本机密钥覆盖目标机。
- 项目策略：项目源码、项目目录、项目 trust 和项目相关运行状态不进入同步范围。
- 当前阶段：已完成本机与 ssh3 的只读盘点及 ssh3 同步（在 model-preserve 明确前执行，见「已完成事实与残留风险」）；ssh4 已完成 host-key 确认与只读对比盘点，但尚未同步。本阶段只更新 skill 与任务记录，不连接或修改 ssh3/ssh4。
- 新增交付：把完整安全流程整理到 `.agents/skills/pi-environment-sync/`，并将 model-preserve 写入为其默认安全策略；skill 保持参数化，不含本机私有值。

## Confirmed research so far

- 本机 Pi CLI：`0.85.1`；ssh3 Pi CLI：`0.85.1`。
- 本机与 ssh3 的全局 npm 包均为 11 个、全局 skills 均为 39 个且 manifest 一致；Pi 用户 packages 都是 16 条，但活动 subagent package 不同：本机为 `npm:@cr1ms0n/pi-subagent@0.8.1`，ssh3 为 `npm:@parke.dev/pi-subagent`（已安装 `0.8.0`）。
- ssh3 比本机多一个模型 `uwoacrimson/deepseek-v4-flash`；共同模型的脱敏定义一致。
- 本机与 ssh3 的 `settings.json`、`AGENTS.md` 和扩展文件有差异；`auth.json` 明显不同，不能覆盖 ssh3 auth/key。
- 按迁移安全契约，本次不复制或修改 `models.json` / `models-store.json`；只保留目标现有模型和 credential 状态。
- ssh3 有本机没有的 `pi-subagents.json`、项目/行为相关扩展和多个备份目录；同步时保留，不删除。
- ssh4：host key 已由用户通过可信渠道确认并写入本机 `known_hosts`（ED25519 指纹 `SHA256:7CFHwEftyW5yBXwY1gVykiM5YxEuXk42dOa74sGo77k`），只读 SSH 连接可用（远端 `OpenSSH_for_Windows_9.5`）。只读对比盘点已完成，**尚未执行任何同步写入**。
- ssh4 Pi CLI 为 `0.84.3`，落后本机 `0.85.1`；CLI 升级不在本 skill 默认范围。
- ssh4 的 prompt 文档位于 `agent/prompts/` 子目录，与本机 agent 根目录布局不同；ssh4 不存在根目录 `keybindings.json`。
- ssh4 package 集与本机分裂：ssh4 独有 `pi-intercom`、`@juicesharp/rpiv-todo`、`pi-ssh-remote`、`pi-codex-goal`、`@gotgenes/pi-subagents`；subagent lineage 三方分裂（本机 / ssh3 / ssh4 各不同）。
- 本机与 ssh4 都存在模型相关配置（模型路由扩展与其配置、模型 toolkit 类扩展配置、模型 profile 文档、subagent model policy 文件、Pi Web 凭据文件）；按 model-preserve 这些全部属于 target-owned，不得同步。
- 本机 `AGENTS.md` 含模型选择相关 section，本机 `settings.json` 含模型选择/压缩字段；因此这两个文件在 model-preserve 下不得整文件覆盖。

## Requirements

### R1. 三端只读盘点

记录本机、ssh3、ssh4 的 Pi CLI/package lineage、Node/npm/Git、全局 npm 包、Pi 用户 packages、skills、扩展文件和核心配置元数据；不得输出凭据或敏感文件内容。ssh4 不可安全访问时记录阻断原因，不绕过 host-key 或握手安全策略。

### R2. 差异分类

将差异分为：

- 可同步的用户级非模型扩展/配置（并注明合并方式）；
- 必须保留目标机版本的密钥、认证、模型配置和目标机状态；
- 项目相关或运行时状态，不同步；
- 需要用户决定的冲突项（package lineage、目录布局、版本 pin）。

### R3. 密钥与模型保留（model-preserve）

后续同步永不调取本机密钥或模型相关配置到目标：

- 永不复制/修改：`auth.json`、真实 `models.json` / `models-store.json`、Pi Web 凭据文件、provider credential fields（例如 `apiKey`、authorization headers）、API/OAuth/token/private key。
- 不同步模型选择/路由/压缩相关配置：`settings.json` 中的 `defaultModel` / `defaultProvider` / `defaultThinkingLevel` / `compactionModel` 等 model/provider/thinking/compaction 字段；`pi-openai-toolkit/config.json`；`model-prompt-router.json`；model-prompt-router 扩展本身；以及任何无法安全拆分的 model/provider 配置。
- 目标端模型字段、目标 package source、目标模型相关设置一律保留；目标端原本缺失的模型配置不因本机存在而新建。
- 如未来要同步模型定义或模型策略，必须另开获得明确授权的迁移设计；即便如此也不得同步凭据。

### R7. model-preserve 写入方式

- `settings.json` 只能做**字段级合并**，且只写确认非模型的字段；目标模型字段、目标 package source、目标模型相关设置保留；无法可靠分类时跳过整个文件，而不是整文件覆盖。
- package source 只有非模型相关且明确审核过的 source 才能安装；涉及 model policy/router/toolkit 的 package conflict 默认保留目标，不自动替换、不自动卸载；目标旧 package 不删除；package 未安装时其对应 config 也不同步。
- 含模型选择区块的 `AGENTS.md` / `APPEND_SYSTEM.md` 或其他 prompt 文档不能整文件覆盖；若不能安全按 section 合并则保留目标版本。
- 普通非模型 extension、`keybindings.json` 等仍可按逐文件 allowlist 同步；机器路径 fixture、项目/运行时/target-owned 排除规则保留。
- 报告必须记录 model-preserve 策略、未复制的模型相关内容、以及 `settings.json` 的 skipped / field-merged 结果，且不得记录任何敏感内容或模型字段值。

### R4. 非破坏同步

后续执行前为每个目标建立唯一时间戳备份；只对显式 allowlist 文件执行复制/字段级合并；不停止 Pi/Node 进程；失败时保留备份并清理临时传输目录。

### R5. 项目排除

不复制项目源码、项目目录、`trust.json`、sessions、cache、backups、run history、remote memory、SSH 配置和项目专属扩展/状态；目标机独有项目相关文件不得因“以本机为准”被删除。

### R6. 可复用 Pi 环境同步 skill

创建并保持 project-local 共享 skill `.agents/skills/pi-environment-sync/`：

- `SKILL.md` 必须明确触发条件、输入参数、默认 allowlist、禁止项、硬停止条件和 references 路由；
- 默认安全策略必须是 model-preserve，并作为不可降级的默认值写入 skill 本体与 references；
- 参数化 source Pi 目录、SSH aliases、每个目标用户和目标 Pi 路径，不保留本次机器的私有实例值、host、port、fingerprint 或凭据；
- 完整覆盖授权、三端只读盘点、host-key/SSH 预检、逐目标隔离、显式 staging、字段级合并、区块合并、package 分类、唯一备份、扫描、传输、PowerShell 兼容、失败/回滚/清理、非模型验收和报告；
- 允许同步：`keybindings.json`、确认非模型且非凭据的 extension 文件、经逐包审核的非模型 package sources、`settings.json` 的非模型字段、两侧均无模型区块时的 prompt 文档；
- 不得复制整个 `.pi\\agent`、Pi 安装目录或 `node_modules`；
- `auth.json`、真实 `models.json` / `models-store.json`、Pi Web 凭据、模型路由/策略配置与扩展、模型 profile 文档、trust、sessions、cache、既有 backups、run history、remote memory 和 SSH 状态保持 target-owned，默认只做存在性/元数据核验；
- package source 冲突时先分类：非模型已审核 source 才安装并验证，再写字段；模型策略相关 source 保留目标；目标旧 package 不删除；
- TCP 可达但 SSH 在 banner/KEX 前关闭时标记 blocked，不使用 `StrictHostKeyChecking=no`，不继续同步。

## Acceptance Criteria

### 当前对比阶段

- [x] ssh3 只读盘点完成；ssh4 早期阻断原因与后续 host-key 确认、登录可用、只读盘点完成且尚未同步的当前状态均已记录。
- [x] 差异报告包含版本、package、扩展、配置和项目排除项。
- [x] `models.json` 只输出脱敏模型/provider 差异，不输出 key。
- [x] 已明确 ssh3 同步 allowlist、排除项和 package 冲突处理。

### ssh3 同步阶段

- [x] ssh3 可同步扩展、用户指令和普通非敏感配置与本机一致；active package 已先安装本机 `@cr1ms0n/pi-subagent@0.8.1`。
- [x] ssh3 的 `auth.json`、真实 `models.json` / `models-store.json`、目标 `trust.json`、sessions、cache、backups 和项目相关扩展保持不变。
- [x] 远程备份、哈希校验、临时清理和回滚证据完整。
- [x] ssh3 的 Pi CLI、`pi --help`、`pi list` 验收通过；未发送模型请求、未调用 Pi Web、未停止进程。
- [ ] 残留：ssh3 同步发生在 model-preserve 明确之前，`settings.json`、`AGENTS.md`、`extensions/pi-openai-toolkit/config.json`、`extensions/model-prompt-router/index.ts` 是按整文件 allowlist 写入的，与新策略不符。是否从该目标备份中选择性恢复模型相关项需用户单独决策（见「已完成事实与残留风险」）。

### 可复用 skill 交付

- [x] `.agents/skills/pi-environment-sync/SKILL.md` 已创建，触发和 references 路由清楚。
- [x] skill 使用参数化 source/alias/target user/target path，不包含本次机器私有实例值或凭据。
- [x] 默认同步内容、禁止同步内容、模型文件 metadata-only 保护、package-first、旧 package 保留和 KEX 阻断规则均已明确。
- [x] references 提供完整迁移工作流、可执行命令模板/伪代码和逐目标报告模板。
- [x] 已执行结构、链接、私有实例值、危险命令和 task validation 检查；新增 skill 期间未连接 ssh3/ssh4。
- [x] SKILL.md 与三个 references 已将 model-preserve 设为默认安全策略：永不复制凭据与模型相关内容；`settings.json` 只能字段级合并非模型字段，无法可靠分类即整文件跳过；模型策略类 package 冲突保留目标；含模型区块的 prompt 文档不整文件覆盖；报告强制记录 model-preserve 结果。
- [x] skill 参数已按新策略调整：`CANONICAL_PACKAGE_SOURCES` 改为 `REVIEWED_NONMODEL_PACKAGE_SOURCES`，新增 `REVIEWED_NONMODEL_SETTINGS_FIELDS` 与 `MODEL_PROFILE_BLOCK_MARKERS`。
- [x] 更新后重跑本地 privacy/dangerous-command/link/fence 检查，并重新校验 PowerShell parser 与 Python 伪代码 compile。

### ssh4 后续阶段

- [ ] 按 model-preserve allowlist 独立执行 ssh4 同步：只写 `keybindings.json` 与逐文件审核的非模型 extension；`settings.json` 只做非模型字段合并或整文件跳过；prompt 文档只做区块合并或保留目标。
- [ ] 保留 ssh4 独有 package、`pi-web-credentials.json`、`models.json` / `models-store.json`、`models-store.json` 空状态、模型路由/策略配置与 sessions/fff/intercom 等运行状态。
- [ ] 报告记录 model-preserve 决策、未同步模型相关内容、settings 合并/跳过结果。
- [ ] ssh4 失败或不可达时只记录该目标状态，不影响 ssh3 已完成结果。

## Out of scope

- 不升级或切换 ssh3/ssh4 的 Pi CLI lineage（含 ssh4 从 `0.84.3` 升到本机 `0.85.1`）。
- 不同步本机 `auth.json` 或本机 API/OAuth 密钥。
- 不同步任何模型相关配置：模型定义、provider 定义、模型选择/路由/压缩、model policy 文件、模型 toolkit 配置。
- 不同步项目源码、项目目录、项目 trust 和会话/运行时状态。
- 不删除目标机独有的项目相关扩展、配置或 package。
- 不为了「行为完全一致」而放宽 model-preserve；扩大范围需用户在后续单独显式授权。

## 当前阻断与处理决定

- **ssh4**：host key 已确认并写入本机 `known_hosts`，只读连接可用，已完成只读对比盘点；当前状态是「可安全只读访问，但尚未同步」。未经用户写入授权不进入写入阶段。
- **model-preserve**：作为本任务与 skill 的默认策略。任何模型相关项在 ssh4 阶段默认 `kept-target`，不进入 staging。
- **ssh3 active subagent package**：ssh3 已在本机旧策略下替换为 `@cr1ms0n/pi-subagent@0.8.1`（旧 `@parke.dev/pi-subagent@0.8.0` 安装目录保留）。在新策略下这类带 model policy 的 package 冲突应保留目标，因此 ssh4 阶段不安装本机 subagent fork，改为保留 ssh4 的 `@gotgenes/pi-subagents`。
- **模型文件**：`models.json` / `models-store.json` 不修改；模型相关配置（模型路由、模型 toolkit 配置、模型 profile 文档、subagent model policy 文件）一律不同步。
- **目标独有文件**：`pi-subagents.json`、项目/行为相关扩展、备份文件、ssh4 独有 package 不删除。
- **可复用 skill**：共享能力位于 `.agents/skills/pi-environment-sync/`，长流程拆分到 `references/`；skill 仅保存通用参数和安全契约，不保存本次机器的用户、host、端口、私有路径、fingerprint 或凭据。

## 已完成事实与残留风险（2026-09-08 model-preserve 补充后）

- ssh3 同步结果保持不变地记录为本任务已完成事实，不因新策略而改写。
- 新策略与 ssh3 既有结果存在差异：ssh3 的 `settings.json`、`AGENTS.md`、`extensions/pi-openai-toolkit/config.json`、`extensions/model-prompt-router/index.ts` 曾在旧策略下按整文件写入，其中包含模型选择/路由相关内容。
- 该残留不影响 ssh4 阶段的执行边界；是否对 ssh3 做选择性恢复（只恢复模型相关项）属于新决策，需要用户单独授权，恢复动作只能来自该目标本次迁移备份。

## 未解决的用户决策项

1. ssh4 prompt 文档布局：统一到本机 agent 根目录布局，还是保留 ssh4 `prompts/` 布局；两种情况下都不得整文件覆盖含模型区块的文档。
2. ssh4 subagent lineage 冲突：默认保留 `@gotgenes/pi-subagents`（不安装本机 fork）；若要替换需用户显式授权并说明 model policy 文件如何处理。
3. ssh4 `pi-openai-toolkit` 版本 pin 与其 config：默认保留目标 pin 与目标 config（模型相关）。
4. ssh4 `settings.json`：默认只做非模型字段合并；若分类不可靠则整文件跳过（可接受结果，不算失败）。
5. 是否需要对 ssh3 做模型相关项选择性恢复（见上节）。
