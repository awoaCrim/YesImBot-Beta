# ssh3/ssh4 Pi 扩展与配置同步：执行计划

## Phase A — 只读对比

- [x] 记录本机、ssh3 的用户、主机、Pi/Node/npm/Git 版本和 package lineage。
- [x] 对比本机与 ssh3 的全局 npm 包、Pi 用户 packages 和全局 skills。
- [x] 对比本机与 ssh3 的扩展文件 manifest，识别目标独有扩展和内容漂移。
- [x] 对比本机与 ssh3 的核心配置；敏感文件只做存在性/元数据检查，模型配置只做脱敏盘点。
- [x] 记录 ssh3 项目/运行相关状态，但不读取或复制项目内容。
- [x] 记录 ssh4 状态演进：早期仅到 banner/KEX 且 host key 未信任；后续 host key 已确认、登录与只读 Pi 盘点完成，但始终尚未同步。

## Phase B — 规划确认

- [x] 确定本轮先独立同步 ssh3；ssh4 恢复后再执行，不让一个目标影响另一个目标。
- [x] 确定 ssh3 active subagent package 冲突处理：安装本机 `@cr1ms0n/pi-subagent@0.8.1`，然后写入本机 settings；旧 `@parke.dev` 安装目录不删除。
- [x] 确定普通用户配置和扩展 allowlist；保留目标独有项目/行为扩展、备份和运行状态。
- [x] 确定 `models.json` / `models-store.json` 按安全迁移契约排除，不修改目标模型或密钥。
- [x] 用户于 2026-09-08 明确批准只执行 ssh3；已运行 `task.py start`，未操作 ssh4。

## Phase C — ssh3 独立执行

1. 运行 `task.py start`，进入 in-progress。
2. 重新生成本机 allowlist staging，不包含 `auth.json`、真实模型文件、运行状态、项目文件和 SSH 状态。
3. 在 ssh3 创建唯一临时目录和 `~/.pi/agent/migration-backups/<timestamp>/` 备份目录。
4. 备份将覆盖的 `AGENTS.md`、`APPEND_SYSTEM.md`、`keybindings.json`、`settings.json` 和允许覆盖的扩展文件；记录存在性、字节数和 SHA-256，不记录敏感内容。
5. 使用 `pi install npm:@cr1ms0n/pi-subagent@0.8.1 --no-approve` 安装本机活动 subagent package；失败则停止写配置，保留备份并清理临时目录。
6. 复制本机 `AGENTS.md`、`APPEND_SYSTEM.md`、`keybindings.json`、`settings.json` 和非敏感扩展文件；跳过 `anon-notify/server/notify-webhook.test.mjs` 的机器绝对路径 fixture。
7. 不复制/修改 `auth.json`、`models.json`、`models-store.json`、`trust.json`、sessions、cache、backups、run history、remote memory、SSH 配置和 ssh3 独有项目/行为扩展。
8. 删除临时传输文件，保留备份和不含敏感内容的 manifest/log。

### 实际完成状态（2026-09-08）

- [x] 以 `C:/Users/Administrator/.pi/agent` 重新生成 35 文件显式 allowlist staging，排除指定 fixture 和全部敏感/运行状态路径。
- [x] ssh3 创建唯一备份 `C:\Users\10497\.pi\agent\migration-backups\20260908-194453213`，35 个目标文件全部先备份并校验哈希。
- [x] 安装 `npm:@cr1ms0n/pi-subagent@0.8.1`；首次包装层将 `npm notice` stderr 误判为失败，但检查确认安装完整、目标配置未被提前修改，失败临时目录已清理，未重复安装。
- [x] 通过新 staging 临时目录写入 35 个 allowlist 文件；4 个文件内容实际变化，31 个原本一致；全部最终哈希与本机一致。
- [x] 保留 ssh3 旧 `@parke.dev/pi-subagent` 安装目录、目标独有扩展/备份/config 和所有排除状态。
- [x] 两个远程临时目录均已清理；远程备份和不含敏感内容的执行/验收 JSON 保留。
- [x] 执行报告已写入 `research/implementation-report.md`。

## Phase D — ssh3 验收

- [x] ssh3 `node --version`、`npm --version`、`git --version`、`pi --version`、`pi --help` 成功。
- [x] ssh3 `pi list` 显示 `npm:@cr1ms0n/pi-subagent@0.8.1`；同步前 16 条 package entries 中仅替换旧 subagent source，其他 15 条 entry 未删除。
- [x] 35 个允许同步文件与本机 SHA-256 一致；目标独有文件仍存在。
- [x] `auth.json`、`models.json`、`models-store.json`、`trust.json`、sessions、cache、backups、run history、remote memory、SSH 状态及其他保护项的存在性/聚合哈希保持不变。
- [x] `anon-notify` 目标 fixture 保持 ssh3 用户路径，不含本机 `Administrator` 用户路径，且文件哈希未变。
- [x] 模型请求、Pi Web 调用和 Pi/Node 进程终止次数均为 0。

## Phase E — ssh4 后续独立执行（model-preserve）

- [x] ssh4 SSH 服务已恢复 banner/KEX 响应；实际 ED25519 指纹与此前只读候选一致。
- [x] 用户已通过可信渠道确认 host key，已写入本机 `known_hosts`，只读连接可用；已完成 ssh4 只读对比盘点（见 `research/ssh4-comparison.md`）。
- [x] ssh4 已按 model-preserve allowlist 完成同步（2026-09-09）；最终备份为 `~/.pi/agent/migration-backups/20260909-144113-ssh4-final-8836`。
- [x] 只写入 `keybindings.json`、4 个审核通过的非模型 extension 文件；`settings.json` 仅字段级合并 `theme`、`tuiMode`；prompt 文档保留 ssh4 `prompts/` 版本。
- [x] 不同步：`auth.json`、`pi-web-credentials.json`、`models.json`、`models-store.json`、模型路由扩展与其配置、模型 profile 文档、subagent model policy 文件、`pi-openai-toolkit/config.json`、`settings.json` 模型字段。
- [x] 未安装或替换任何模型策略包；`npm:pi-tool-display` 与 `git:github.com/awoaCrim/preserveScrollbackPatch` 已确认存在，ssh4 原有 package sources 与目标独有 packages 保留。
- [x] 验收通过：目标 Pi `0.84.3` 未升级；模型字段指纹、模型文件/凭据和稳定保护项未变；5 个同步文件哈希与本机一致；远程临时目录已清理；sessions 未进入写入 allowlist。
- [x] ssh4 同步失败不会影响 ssh3；本轮早期失败尝试均保留远程备份，最终 run 已成功完成。

## Phase F — 可复用 skill 交付（2026-09-08）

- [x] 读取当前 task 的 PRD、design、implement、执行报告和全部 `implement.jsonl` context。
- [x] 读取 `trellis-meta` 的 project-local skill 说明，确认使用 `.agents/skills/` 且不修改 bundled skills / template hashes。
- [x] 创建 `.agents/skills/pi-environment-sync/SKILL.md`，定义触发、参数、授权、默认 allowlist、保护项、硬停止条件和 references 路由。
- [x] 创建 `references/migration-workflow.md`，覆盖本机/目标只读盘点、host-key、逐目标状态机、显式 staging、唯一备份、package-first apply、验收、失败/回滚/清理。
- [x] 创建 `references/command-templates.md`，提供参数化 PowerShell/SSH/archive/transfer/runner/native-process/rollback 模板；不含真实 key、token 或本次机器私有路径。
- [x] 创建 `references/report-template.md`，提供逐目标 preflight、package、allowlist、protected-state、非模型验收和清理报告格式。
- [x] 明确真实 `models.json` / `models-store.json` 默认仅存在性/元数据核验，不复制、不读取内容、不修改、不删除、不移动、不重命名。
- [x] 明确 package source 冲突时先安装 canonical package、验证成功后最后写 `settings.json`，目标旧 package 不删除。
- [x] 明确 TCP 可达但 SSH 在 banner/KEX 前关闭时 blocked，不使用 `StrictHostKeyChecking=no`，不继续同步。
- [x] 运行 skill 结构/references、私有实例值、危险模式、Markdown fence、task validation 检查。
- [x] 本阶段未执行任何 ssh3/ssh4 命令，未修改远程环境，未执行 `git commit`。

## Phase G — 独立只读质量检查（2026-09-08）

- [x] 复核 skill frontmatter、触发描述、relative references 和 `.agents/skills/` project-local ownership；确认未进入 `.trellis/.template-hashes.json`。
- [x] 复核授权、host-key、逐目标隔离、allowlist、protected state、package-first、settings 最后写、备份/hash、验证、失败/回滚/清理/报告流程。
- [x] 修正命令模板中的 Windows PowerShell 5.1/native stderr、`ProcessStartInfo.ArgumentList`、SSH stdin stream、远程路径 quoting、archive entry、目录 aggregate hash、回滚并发保护和递归清理边界问题。
- [x] 明确审核后的 canonical package sources 写入 `packages.txt` 并由 `source-manifest.json` 的 count/hash 绑定；archive 只含 manifest、packages.txt 和允许 bucket 的显式文件，runner 单独传输。
- [x] 运行 frontmatter/link/ownership/privacy/危险命令扫描、PowerShell 5.1 parser、Python syntax/archive path cases、PowerShell helper 本地 smoke 和 `task.py validate`；全部通过。
- [x] 本检查未连接 ssh3/ssh4，未执行远程命令，未修改远程环境，未执行 `git commit`。

## Phase H — model-preserve 默认化（2026-09-08 用户补充边界）

用户明确：不要把本机的密钥或任何模型相关配置同步到目标，尤其适用于尚未同步的 ssh4。本 Phase 只修改本地 project-local skill 与当前 task 记录；未连接、未修改 ssh3/ssh4，未执行 `git commit`。

### H.1 SKILL.md

- [x] 将 model-preserve 写为不可降级的默认安全策略，并新增“默认策略”章节。
- [x] 永不复制项扩展为凭据/认证、模型定义与模型策略、target-owned 与运行时状态三组，并统一 metadata-only 核验。
- [x] 新增四类合并方式：whole-file / field-merge / section-merge / install-only；未分类项不得进入 staging。
- [x] `settings.json` 从默认整文件同步项改为只能字段级合并非模型字段，无法可靠分类即整文件跳过。
- [x] `AGENTS.md` / `APPEND_SYSTEM.md` 不再默认整文件覆盖；含模型区块时只能 section-merge，否则保留目标版本。
- [x] package 只允许安装经逐包审核的非模型 source；模型策略/router/toolkit 冲突默认保留目标、不自动替换；旧 package 不删除；package 未安装则其 config 也不同步。
- [x] 参数表将 `CANONICAL_PACKAGE_SOURCES` 改为 `REVIEWED_NONMODEL_PACKAGE_SOURCES`，新增 `REVIEWED_NONMODEL_SETTINGS_FIELDS` 与 `MODEL_PROFILE_BLOCK_MARKERS`。
- [x] 硬停止条件、完成标准、报告要求与范围外（含目标 CLI 版本升级）同步更新。

### H.2 references/migration-workflow.md

- [x] 参数表与状态模型加入 model-preserve 分类、保留清单和 field/section 合并阶段。
- [x] Phase 1 盘点加入合并方式判定、extension 新增 `model-related` / `credential-bearing` 分类、package 逐包模型分类、protected baseline 加入模型相关配置与 Pi Web 凭据，新增分类结果输出要求。
- [x] Phase 3 staging 改为 `field-patches/` + `section-patches/` 结构；manifest 新增 `modelPreservePolicy`（含 blockMarkers/blockedSourcePatterns）与每文件 `mergeMode`；path/secret 扫描加入模型相关名称；archive 禁止整文件 `settings.json`。
- [x] Phase 5 重写为 package 分类 + 字段级合并 + 区块合并，并定义写后目标模型字段断言与失败恢复。
- [x] Phase 6/7 验收与失败策略加入 `settings.json` 跳过（不算失败）、模型字段变化（算失败）、模型策略包保留目标、baseline 缺失模型文件不得新建。

### H.3 references/command-templates.md

- [x] 控制端参数改为 `$ApprovedWholeFile` / `$FieldMergedConfigs` / `$SectionMergedDocs` / `$ApprovedExtensions`，并新增 `$ModelPreserveBlockedNames`、`$ModelRelatedSettingsFields`、`$ModelProfileBlockMarkerPairs`、`$ModelRelatedPackagePatterns`、`$KnownNonModelNestedFields`。
- [x] 新增 7.1 非模型字段补丁生成与目标端字段写入/复核模板（fail-closed，目标模型字段变化则从备份恢复）。
- [x] 新增 7.2 prompt 文档区块合并模板（含模型区块检测与 `preserved-target` 路径）。
- [x] archive 校验加入模型相关屏蔽名、禁整文件 `settings.json`、`mergeMode` 必验、补丁内容不得含模型字段/区块标记、packages.txt 不得含模型策略包。
- [x] 新增 12.1 非模型 package 分类器与 `Select-InstallablePackageSources`（未审核戒模型相关一律不安装）。
- [x] 13 Apply 改为按 mergeMode 分派，并拒绝整文件 settings 写入；15 protected 比对加入模型相关配置、Pi Web 凭据、Pi root 外的 model policy 文件与目标模型字段断言；16 回滚说明字段/区块合并也仅能来目标原文件备份。
- [x] 新增 18 model-preserve 源端扇描（信号→处理矩阵）与 19 目标端模型基线指纹（只存字段名与结构指纹，不存值）。

### H.4 references/report-template.md

- [x] 新增 model-preserve 策略章节与未同步模型相关内容清单表。
- [x] Source snapshot 增加按合并方式计数与 model-preserve 扇描结果；package 表增加分类与 kept-target/not-installed 结果。
- [x] 新增 `settings.json` 结果区（field-merged/skipped + 原因 + 保留的目标模型字段名）。
- [x] protected-state 表加入 Pi Web 凭据、模型路由/策略配置、模型 profile 文档与“baseline 缺失则同步后仍缺失”检查。
- [x] 验收规则增加：出现整文件 settings 写入、模型区块文档被覆盖、模型策略包被替换时不得判为 success。

### H.5 本地验证

- [x] 隐私扇描（alias/host/用户/路径/fingerprint/provider与模型标识/subagent lineage/identity file）：0 个真实命中（仅 `pi-subagents-state` 目录名为同形假阳性）。
- [x] 危险命令扇描：8 处命中均为禁止语句或已受 guard 的当前 run 临时目录清理；无绕过型命令。
- [x] Markdown fence 配对与 references 相对链接：通过。
- [x] PowerShell 5.1 parser 与 Python 伪代码 compile：见下方验证记录。
- [x] `task.py validate`：见下方验证记录。
- [x] 本 Phase 未连接 ssh3/ssh4，未执行任何远程命令，未修改远程环境，未执行 `git commit`。

### H.6 ASCII Base64 stdin transport 修正（2026-09-08）

- [x] 独立复核发现：Windows PowerShell 5.1 的 `powershell.exe -Command -` 会按目标代码页解释原始 stdin UTF-8；直接写 UTF-8 字节可能对中文注释、中文路径或非 ASCII 用户名产生静默乱码。
- [x] 修正 `references/command-templates.md`：远程脚本改为 UTF-8 → Base64 ASCII stdin，远端使用固定 ASCII bootstrap + `-EncodedCommand`（UTF-16LE）解码并执行；脚本、目标路径和 secret 不进入 SSH 进程参数。
- [x] 保留并明确 SSH alias 白名单、`StrictHostKeyChecking=yes`、`BatchMode=yes`、连接/整体超时、stdout/stderr 并行读取和仅按 native exit code 判定成功。
- [x] 本地 transport smoke 通过，14/14 assertions：bootstrap ASCII 与 `-EncodedCommand` round-trip、ASCII payload、含中文注释/路径/用户名的脚本 UTF-8 字节 round-trip、`exit 7` 透传、`throw` 映射为 1 且输出 `remote-bootstrap:`。
- [x] PowerShell 5.1 fenced-block parser：23/23；Python fenced-block compile：1/1；Markdown fence/reference/privacy/dangerous-pattern scan 与 `task.py validate` 均通过。
- [x] 本次修正未连接 ssh3/ssh4，未执行远程命令，未修改远程环境，未执行 `git commit`。

### H.7 最终复验与 preflight 一致性修正（2026-09-08）

- [x] 质量检查发现命令模板第 3 节仍保留 inline SSH PowerShell preflight 的表述，已改为明确复用第 4 节的 ASCII Base64 stdin helper；现在首次 preflight 与后续远程 PowerShell 统一使用同一 transport。
- [x] 最终复验从当前 `command-templates.md` 直接提取 transport block，在本地 `powershell.exe` 替代 SSH 进程后运行，transport smoke：15/15 assertions 通过。
- [x] 当前 skill fenced blocks：PowerShell 23/23、Python 1/1；frontmatter、references links、Markdown fences、隐私扫描和 task-local 临时文件清理检查通过。
- [x] `python ./.trellis/scripts/task.py validate 09-08-sync-pi-extensions-config-ssh3-ssh4` 通过，`implement.jsonl` / `check.jsonl` 各 5 条有效 context。
- [x] 最终复验未连接 ssh3/ssh4，未执行远程命令、package 安装或 git 操作；远程环境与 `known_hosts` 无新增副作用。
