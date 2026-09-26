# 部署 SSH2 并清理 Koishi 聊天记录

## Goal

将当前已经在本地完成验证的 YesImBot/Koishi 相关构建部署到 `ssh2` 上的 `yesimbot-koishi`，完成受控健康检查；同时按用户确认的范围清理 Koishi 聊天历史，并保留可回滚备份。

## User value

- SSH2 上运行目标代码，而不是继续使用旧的生产构建。
- 清理指定范围的历史对话，避免误删资源、配置、运行日志或回滚材料。
- 部署失败或健康检查异常时可以恢复到部署前状态。

## Confirmed facts

- 用户已明确允许为本次操作创建 Trellis task，并在规划完成后批准按计划执行；任务已进入 `in_progress`。
- 目标主机别名为 `ssh2`，当前 SSH 配置解析到 root 用户、22 端口；认证材料未写入任务文件或回复。
- 远端执行前基线中的 `yesimbot-koishi` 为 `running`、`OOM=false`、restart count 为 `0`；最终验收仍满足这些条件。
- 容器挂载包括：
  - `/opt/yesimbot/data/koishi` → `/koishi/data`；
  - Docker volume `/var/lib/docker/volumes/yesimbot_koishi-app/_data` → `/koishi`。
- 执行前 fresh preflight 在真实映射的 YesImBot data root 中发现 2 个 `sessions/*.jsonl`，合计 `1,192,865` bytes；两者均先进入 owner-only backup，随后按固定清单删除，未读取或输出正文。
- 既有部署记录表明，生产应用使用 `yesimbot-koishi`，通常只重启该容器，不重启 NapCat；部署前应创建 owner-only 的时间戳备份和 rollback script。
- 本地 YesImBot 源码、Agent runtime 和 Core 构建/类型检查/测试已在前一任务通过；工作树仍包含其他任务和用户已有修改，不能整体复制或回滚。
- 既有远端工作树/构建产物可能包含无关 dirty changes；本次部署必须采用 task-scoped 文件清单和 hash guard，不覆盖未列入清单的远端文件。

## Requirements

### R1 — Scoped production deployment

- 只部署当前任务所需的已验证 Core/Agent runtime 产物及其必要 workspace package 文件。
- 部署前读取并记录目标文件 hash、容器状态、HTTP health 和启动日志摘要。
- 备份将被覆盖的生产配置、构建产物、package/lock 文件（如实际会覆盖）及回滚所需元数据；备份目录权限限制为 owner-only。
- 使用原子替换或等价的受保护更新；hash 不匹配、复制失败或校验失败时停止并按 rollback 方案恢复。
- 只重启 `yesimbot-koishi`；不重启 NapCat，不发送 QQ/Sandbox 测试消息，除非后续另行明确批准。

### R2 — Chat-history cleanup

- 删除范围必须在执行前由用户明确确认。
- 默认推荐范围为 YesImBot 会话 JSONL：`*/sessions/*.jsonl`；不删除 `koishi.yml`、模型配置、willingness state、assets、artifacts、workspace、运行日志、NewAPI request snapshots 或部署 backups。
- 清理前统计目标文件数量、总字节数、路径摘要并纳入备份 manifest；不读取或输出聊天正文。
- 清理动作必须可回滚：优先将目标会话文件移动/复制到 owner-only 备份，再清理活动目录；清理后重新统计并确认目标为零或符合用户指定条件。
- 如果用户要求 Koishi 数据库、日志或其他数据源，也必须单独列出路径、影响和回滚方式，不得将“聊天记录”默认扩大为全量数据删除。

### R3 — Post-deployment verification

- 容器保持 `running`、退出码为 `0`、未 OOM，且 restart count 未出现异常增加。
- `127.0.0.1:15140` health endpoint 返回 HTTP `200`。
- Core/Agent runtime 和相关插件正常加载，启动日志没有新的 fatal/uncaught/severe 错误。
- 清理后目标会话目录状态与 manifest 一致；部署备份和 rollback script 可读取且 hash 校验通过。
- 不发送真实平台消息；仅执行进程、HTTP、包加载和文件状态验证。

## Out of scope

- 不删除 `willingness.json`、reservation state、assets、artifacts、workspace、备份、NewAPI 数据或 OAuth/API credentials。
- 不修改生产 Will routing/willingness 配置，除非后续计划明确列出并获得单独批准。
- 不重启 NapCat，不发送 QQ/Sandbox canary，不做自然流量行为评估。
- 不提交 Git commit，不覆盖远端无关 dirty worktree，不清理本地无关修改。

## Scope decision（已解决）

用户已确认本次只清理“聊天记录”，采用最小且可回滚的范围：清理 SSH2 上 YesImBot 数据根下全部频道的会话 JSONL：

- `/opt/yesimbot/data/koishi/yesimbot/channels/**/sessions/*.jsonl`
- 容器内对应路径：`/koishi/data/yesimbot/channels/**/sessions/*.jsonl`

范围包含活动和已归档的 `sessions/*.jsonl` 文件；不包含其它目录中的 JSONL、`interactions` transcript、Koishi 数据库/消息表、运行日志或任何插件私有记录。最终执行前仍需重新解析真实路径并生成固定删除清单；若复核结果为零文件，则记录为安全 no-op，不扩大到父目录或其它数据源。

用户已批准按本计划执行。批准不包含 NapCat 重启、真实平台消息或超出清单的数据操作。

## Execution result（2026-09-15）

- 本地 Agent runtime/Core build、type-check、Agent runtime 121 tests、Will policy 49 tests、Core 309 tests、相关 format/lint 和 `git diff --check` 通过；候选为 9 个 dist 文件，合计 `2,006,343` bytes。
- 远端 owner-only backup：`/opt/yesimbot/backups/deploy-ssh2-clear-20260915T163054Z-12868`，目录 mode `700`，包含旧 dist、2 个 session 备份、manifest 和 mode `700` 的 `rollback.sh`；临时 staging 已按 run id 清理。
- 实际清理了执行前 manifest 中的 2 个 YesImBot session JSONL，合计 `1,192,865` bytes；删除当时宿主机和容器映射路径均为 0 个目标文件。服务恢复后又出现 1 个新的 session 文件，因不属于执行前清单而被安全保留，未再次删除。
- 只替换了 `core/dist/**` 和 `packages/agent-runtime/dist/**` 的候选文件；`koishi.yml`、package manifests、models、willingness state、assets/artifacts/workspace、NewAPI snapshots 和 NapCat 未进入本任务写入清单。恢复服务后观察到一个 guild `willingness.json` 发生运行时 metadata/hash 变化，未由本任务覆盖或回滚。
- 最终 `yesimbot-koishi` 为 `running`、exit `0`、OOM `false`、restart count `0`；HTTP `127.0.0.1:15140/` 返回 `200`；两个 package 均从预期 dist 成功 `require.resolve()` 和加载；启动严重错误信号为 0。
- 执行中曾发现 runner 对 Docker mount 输出顺序进行字符串比较的误报。已先恢复 Koishi，再修正 guard、重新建立执行基线并继续；期间未修改 dist/session，NapCat container ID、StartedAt 和 restart count 保持不变。该恢复过程造成一次额外的同容器 stop/start，最终仍只操作 `yesimbot-koishi`。
- 未发送 QQ/Sandbox/平台消息，未调用真实模型或业务副作用工具；未创建 Git commit。
