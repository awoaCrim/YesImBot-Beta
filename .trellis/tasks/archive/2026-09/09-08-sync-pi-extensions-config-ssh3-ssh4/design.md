# ssh3/ssh4 Pi 扩展与配置同步：技术设计

## 1. 边界

本机是**非模型**用户级扩展和配置的 canonical source；ssh3、ssh4 是独立目标。默认安全策略是 **model-preserve**：任何密钥、认证、模型定义、模型选择/路由/压缩相关配置都属于 target-owned，既不从本机复制，也不在目标端被修改或删除。

执行阶段先完成 ssh3（当时在 model-preserve 明确前执行，见第 11 节）；ssh4 host key 已由用户确认并写入本机 `known_hosts`，只读连接可用且已完成只读对比盘点，但尚未同步。

本阶段只把已验证流程与新的 model-preserve 边界抽象为 project-local 共享 skill，不连接或修改 ssh3/ssh4。

## 1.1 model-preserve 覆盖范围

默认保留目标、不进入 staging 的模型相关内容：

| 类别 | 典型项 | 处理 |
| --- | --- | --- |
| 凭据/认证 | `auth.json`、Pi Web 凭据文件、provider credential fields、API/OAuth/token/authorization、private key | 绝对不同步，也不读取内容 |
| 模型定义 | 真实 `models.json`、`models-store.json`（含空 `{}` 状态） | metadata-only 核验 |
| 模型选择 | `settings.json` 的 `defaultModel` / `defaultProvider` / `defaultThinkingLevel` / `compactionModel` | 保留目标值，不写入不删除 |
| 模型路由/策略 | model-prompt-router 扩展与其配置文件、subagent model policy 配置文件 | 实现与 config 都不同步 |
| 模型能力 config | 模型 toolkit 类扩展配置（compaction、web-search model、auto-mode reviewer model 等） | 不同步 |
| 模型 profile 文档 | 模型 profile 目录及 prompt 文档中的模型区块 | 不整文件覆盖；不能安全切分时保留目标 |
| 模型策略包 | 参与模型选择/路由/压缩/provider 行为的 package | 保留目标版本与活动引用，不自动安装/替换/卸载 |

## 2. 数据流

```text
本机只读盘点
  -> model-preserve 分类（credential / model-definition / model-selection / model-routing / model-compaction / uncertain）
  -> 三端差异分类（含合并方式：whole-file / field-merge / section-merge / install-only）
  -> 用户确认冲突策略与模型相关保留清单
  -> 显式 allowlist staging（不含整文件 settings.json 与任何模型相关内容）
  -> 每个目标独立备份
  -> SSH 加密传输
  -> 目标端隔离解压与 archive 重扫
  -> 只安装非模型已审核 package；模型策略包保留目标
  -> 普通非模型文件写入 / settings 字段级合并 / prompt 区块合并
  -> 目标密钥与模型字段保留验证
  -> 非模型请求验证
  -> 删除临时目录，保留备份与脱敏报告
```

## 3. 配置合并策略

### 3.1 四类合并方式

每个 allowlist 项必须先归入一种合并方式，未分类不得进入 staging：

1. **whole-file**：确认非模型、非凭据、无源机器绝对路径的文件，典型为 `keybindings.json` 和逐文件审核的非模型 extension 源码；prompt 文档仅在两侧均无模型区块时才可用。
2. **field-merge**：`settings.json`。永远不做整文件覆盖。
3. **section-merge**：含模型区块的 prompt 文档，只写确认非模型的 section。
4. **install-only**：非模型已审核 package source，只能走 `pi install <source> --no-approve`。

### 3.2 `settings.json` 字段级合并

`settings.json` 不再是“package 安装成功后整体重写”的文件：

- 本机只产出**非模型字段补丁**；整文件 `settings.json` 不得进入 archive；
- 目标端读取自己的目标 `settings.json`，只写入已分类为非模型的字段；目标模型字段、目标 package 条目、目标独有字段全部保留；
- 写入前完整备份目标文件；写入后重新解析并逐字段断言目标模型字段未变，失败即从备份恢复并使当前目标失败；
- 出现以下任一情况直接**跳过整个文件**并记录，不算目标失败：目标不可解析、schema 不兼容、存在无法可靠分类的嵌套字段、补丁内含模型字段形状、目标模型字段无法枚举、备份未完成；
- 典型模型相关字段：`defaultModel`、`defaultProvider`、`defaultThinkingLevel`、`compactionModel`（含其 `model` / `thinkingLevel` 子字段），以及 `packages` / `extensions` 中指向模型策略、路由或 toolkit 实现的条目；
- 名字含 `model` 但语义仅为状态栏展示的字段不算模型策略；无法确认语义时一律按模型相关处理（fail-closed）。

### 3.3 prompt 文档

`AGENTS.md`、`APPEND_SYSTEM.md` 及其他 prompt 文档可能含模型选择区块（由模型路由机制维护或含具体模型/provider 名）：

- 含模型区块时禁止整文件覆盖；只能按 section 合并确认非模型的区块；
- 目标端由路由机制维护的区块保持目标版本；
- 无法可靠切分时**保留目标版本**，记录 `preserved-target`；
- 目标布局与本机不同（例如 prompt 文档在子目录）时不在另一位置新建副本，升级为需用户决定的布局冲突。

### 3.4 普通用户级配置与 extension

`keybindings.json` 和审核过的非敏感、非模型 extension 文件以本机为来源；覆盖前必须备份。含凭据相关字段（例如 token 环境变量/文件引用、回传 endpoint 与 recipient）的 extension config 默认不同步，除非逐字段审核确认。

### 3.5 package 分类

`settings.json` 中的 `packages` 是活动扩展配置，但不再默认“以本机为准”：

- 只有确认非模型相关且经逐包审核的 source 才能安装；
- 参与模型策略（模型选择、路由、回退、thinking level、compaction、provider/toolkit 行为）的包发生冲突时，默认**保留目标版本与目标活动引用**，不安装、不替换、不卸载；
- 目标旧 package 安装目录不删除；目标独有 package 不删除；
- package 未安装时，其 config 文件也不同步，避免写入无实现的配置或覆盖有实现的配置。

### 3.6 `models.json` / `models-store.json`

遵守 model-preserve：只做存在性/类型/字节数/时间戳/可选 hash 核验，不复制、修改、删除、移动或重命名；目标端原本缺失时也不得因同步而新建。若用户后续单独要求同步模型定义，需另开明确授权的迁移设计，且仍不得同步凭据。

### 3.7 项目相关内容

`trust.json`、项目源码/目录、project-local agents、项目专属扩展和运行时状态不进入 staging，也不因本机缺少对应文件而删除目标内容。

## 4. 目标独立性

ssh3 和 ssh4 分别执行、分别备份、分别校验；一个目标失败不应回滚或污染另一个目标。目标用户、路径、Pi lineage、密钥字段、模型字段和状态存在性分别记录。

model-preserve 不因目标而变：即使 ssh4 缺少本机的某些模型相关配置，也不属于可同步范围。

## 5. ssh4 后续执行的 model-preserve allowlist / 排除

基于已完成的 ssh4 只读盘点，ssh4 阶段的默认边界：

可同步（待写入授权）：

- `keybindings.json`（ssh4 原本不存在，属非模型 UI 配置）；
- 逐文件审核且确认非模型、非凭据、无本机绝对路径的 extension 源码；
- 经逐包审核且确认非模型的 package source（ssh4 阶段暂无已确认项）。

只能字段/区块级处理：

- `settings.json`：只合并确认非模型的字段；ssh4 的 `lastChangelogVersion`（与其 `0.84.3` CLI 相关）、目标 package 条目、目标模型字段均保留；不可靠分类则整文件跳过；
- prompt 文档：本机 `AGENTS.md` 含模型选择 section，因此不整文件覆盖；先解决 ssh4 `prompts/` 布局决策，否则保留目标版本。

默认不同步（model-preserve）：

- `pi-openai-toolkit/config.json`（compaction / web-search model / auto-mode reviewer model）；
- model-prompt-router 扩展与 `model-prompt-router.json`、模型 profile 文档；
- subagent model policy 配置文件；
- `auth.json`、`pi-web-credentials.json`、`models.json`、`models-store.json`（含 ssh4 当前空对象状态）。

明确排除（target-owned / 运行时）：

- `trust.json`、sessions、`fff/`、`intercom/`、`powerline-footer/inbox.jsonl`、`ssh-remote-memories/`、`bin/`、cache、backups、run history；
- ssh4 独有 package：`pi-intercom`、`@juicesharp/rpiv-todo`、`pi-ssh-remote`、`pi-codex-goal`、`@gotgenes/pi-subagents`；
- ssh4 用户目录结构与本机不同，禁止把本机绝对路径写入；
- 全局 npm 包集合、系统工具、Pi CLI 版本（`0.84.3`）。

### 5.1 ssh3 历史 allowlist（已完成，仅供审计）

ssh3 同步在 model-preserve 明确前执行，当时允许：`AGENTS.md`、`APPEND_SYSTEM.md`、`keybindings.json`、`settings.json`（整文件）、非敏感扩展文件，以及安装本机 subagent package。明确排除：`auth.json`、`models.json`、`models-store.json`、`trust.json`、sessions/cache/backups/migration-backups、run history、remote memory、SSH 配置和 ssh3 独有项目/行为扩展。

在新策略下同一清单不再合法：`settings.json` 整文件、含模型区块的 `AGENTS.md`、`pi-openai-toolkit/config.json` 和 model-prompt-router 扩展均属于不同步项，详见第 11 节残留风险。`anon-notify/server/notify-webhook.test.mjs` 含机器绝对路径，仍只保留目标机版本。

## 6. 安全与回滚

- 使用显式 allowlist，不递归复制整个 `.pi\\agent`；
- 远程备份目录使用唯一时间戳；先备份后安装/写入；字段级合并与区块合并也必须先完整备份目标原文件；
- 不杀 Pi/Node 进程；遇到文件锁停止当前目标；
- package 安装、配置写入或验收失败时删除临时传输目录，保留该目标备份；必要时只从该目标备份回滚；回滚 `settings.json` 时只使用合并前的目标备份，绝不拿本机整文件当回滚源；
- 只运行 `pi --version`、`pi --help`、`pi list` 等不发送模型请求的验证；
- ssh4 host key 已由用户确认，仍不得使用 `StrictHostKeyChecking=no`，写入前必须重新做只读预检与 protected-state baseline。

## 7. 可复用 skill 结构

共享 skill 位于：

```text
.agents/skills/pi-environment-sync/
├── SKILL.md
└── references/
    ├── migration-workflow.md
    ├── command-templates.md
    └── report-template.md
```

设计职责：

- `SKILL.md`：负责触发、参数收集、**model-preserve 默认策略**、四类合并方式、永不复制项、硬停止条件、范围外声明和 references 路由；
- `migration-workflow.md`：负责授权、source/target 盘点与 model-preserve 分类、逐目标状态机、staging（含 field-patches / section-patches 桶）、package 分类与 package-first apply、`settings.json` 字段级合并、prompt 区块合并、验收、回滚和清理；
- `command-templates.md`：提供不含私有实例值的 PowerShell/SSH/archive 模板，含非模型字段补丁生成与目标端应模板、prompt 区块合并模板、非模型 package 分类器、model-preserve 源端扇描、目标模型字段基线比对；强调 `Split-Path -Parent -Path`、native exit code、隔离传输和显式 allowlist；
- `report-template.md`：按目标记录 model-preserve 策略与未同步模型相关内容清单、`settings.json` 的 skipped/field-merged 结果、preflight、备份、package、写入、protected-state、非模型验收和最终状态。

该 skill 是 project-local 用户资产，不写入 Trellis bundled skill，也不修改 `.trellis/.template-hashes.json`。Pi 使用 `.agents/skills/` 共享层发现该能力。项目安全契约（`.trellis/spec/guides/pi-environment-migration-guide.md`）更严格时以它为准；在其本任务边界内更宽松时（例如把模型类 package 列入默认同步），以 model-preserve 为准并记录冲突。

## 8. Skill 参数和安全契约

必填参数：source Pi root、SSH alias 列表、每个目标预期用户、每个目标 Pi root、**经逐包审核的非模型 package source 清单**（`REVIEWED_NONMODEL_PACKAGE_SOURCES`）、逐字段审核的非模型 settings 顶层字段清单（`REVIEWED_NONMODEL_SETTINGS_FIELDS`）、审核后的 extension 文件清单、模型区块标记（`MODEL_PROFILE_BLOCK_MARKERS`）。所有目标分别生成 run id、临时目录、备份和报告。skill 不写入任何真实主机、用户、路径、fingerprint、key 或 token 值。

默认可同步（均需先完成分类）：

- `keybindings.json`（whole-file）
- 审核过的非敏感、非模型 extension 具体文件（whole-file）
- `settings.json` 的**非模型字段**（field-merge，永不整文件）
- 两侧均无模型区块时的 `AGENTS.md` / `APPEND_SYSTEM.md`；否则仅 section-merge
- 经逐包审核且确认非模型的 package source（install-only）

默认保护（model-preserve）：`auth.json`、真实 `models.json` / `models-store.json`、Pi Web 凭据文件、provider credential fields、API/OAuth/token/authorization、private key、模型选择/路由/压缩类 settings 字段、模型路由扩展与其配置、模型 toolkit 类扩展配置、模型 profile 文档、subagent model policy 配置文件、trust、sessions、cache、既有 backups、run history、remote memory、SSH 状态、项目内容、Pi CLI 安装目录和 `node_modules`。真实模型文件只做存在性/类型/字节数/时间戳/可选 hash 核验，不读取或修改内容。

源端机器绝对路径文件默认排除；测试 fixture 保留目标版本，不能做盲目用户名替换。非模型已审核 package 先安装并验证，再执行字段级 settings 合并；模型策略包保留目标；旧 package 安装目录保留。

扇描与硬停止在原有基础上增加：staging 内出现模型相关文件/字段/区块、目标 `settings.json` 不可解析或 schema 不兼容、目标模型字段在写入后变化、模型策略包试图替换——均按规则跳过该项或停止当前目标。禁止使用 `StrictHostKeyChecking=no`、停止 Pi/Node、模型请求或 Pi Web 验收。

## 9. Skill 验证

验证不连接任何远程目标，只检查仓库内交付物：

- frontmatter、必需文件和 references 链接完整；
- skill 中不含本次机器的用户、host、端口、alias、私有绝对路径、fingerprint 或 credential，也不含真实模型/provider 标识作为待同步内容；
- model-preserve 默认策略、四类合并方式、`settings.json` 字段级合并/整文件跳过、模型策略包保留目标、prompt 文档不整文件覆盖、报告强制项可搜索定位；
- 模型相关名称只允许出现在“禁止/保留”语境中，不得出现在默认同步清单里；
- Markdown code fences 配对，PowerShell 模板可通过 parser 检查，Python 伪代码可 compile，task artifacts 通过 `task.py validate`。

## 10. ssh4 后续执行的 model-preserve allowlist

ssh4 host key 已确认且只读盘点已完成，尚未写入。待用户授权后的默认执行集：

1. 重新只读预检（用户/路径/protected-state baseline/目标模型字段基线）；
2. whole-file：`keybindings.json` + 逐文件审核通过的非模型 extension；
3. section-merge：prompt 文档仅在布局决策完成且可安全切分后处理，否则 `preserved-target`；
4. field-merge：`settings.json` 非模型字段，不可靠分类即整文件 `skipped`；
5. packages：本阶段默认为空（模型策略包保留目标，其余需逐包审核）；
6. 验收：非模型命令 + 目标模型字段与模型文件未变 + 报告记录 model-preserve 结果。

## 11. 已完成事实与残留风险

ssh3 同步在 model-preserve 明确前完成，以下项当时按整文件 allowlist 写入，在新策略下属于不同步项，因此保留为已知残留风险而不是错误或已完成验收的缺口：

- `settings.json`：当时整机覆盖，目标原有模型选择/压缩字段已被本机值替换；
- `AGENTS.md`：当时整机覆盖，本机版本含模型选择 section；
- `extensions/pi-openai-toolkit/config.json`：当时整机覆盖（内容变化），该文件含 compaction / web-search model / auto-mode reviewer model 配置；
- `extensions/model-prompt-router/index.ts`：当时进入 staging（两机内容一敛，未产生实际变化）。

ssh3 的 `auth.json`、`models.json`、`models-store.json`、`trust.json` 及其他 protected state 未变化，旧 package 与目标独有文件均保留。如需恢复，只能使用 ssh3 本次迁移备份（`migration-backups/20260908-194453213`）做**选择性**恢复，并需用户单独授权；本任务不改写 ssh3 已完成结果。
