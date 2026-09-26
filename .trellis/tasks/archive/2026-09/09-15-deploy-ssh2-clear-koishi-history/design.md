# 技术设计：部署 SSH2 Koishi 构建并清理会话历史

## 1. 设计结论与边界

本任务采用“本地构建候选 + 远端只读预检 + owner-only 备份 + 停止后受保护替换 + 固定清单清理 + 单容器验收”的流程。部署和清理都必须在用户批准本计划后执行；当前规划阶段不停止容器、不删除数据、不写远端。

### 目标与固定路径

- SSH 目标：已确认的 `ssh2`。
- Koishi 容器：`yesimbot-koishi`。
- NapCat 容器：`yesimbot-napcat`，只做状态对照，不停止、不重启、不替换。
- 生产应用根（宿主机）：`/var/lib/docker/volumes/yesimbot_koishi-app/_data/yesimbot-v4`。
- 生产应用根（容器内）：`/koishi/yesimbot-v4`。
- 会话数据根（宿主机）：`/opt/yesimbot/data/koishi/yesimbot`。
- 会话数据根（容器内）：`/koishi/data/yesimbot`。
- owner-only 备份根：`/opt/yesimbot/backups/<run-id>`；若远端实际布局不允许使用该路径，必须在写入前停止并重新确认，不得自行改用未知目录。

### 明确不做

- 不修改 `koishi.yml`、模型配置、Will/willingness 状态、Persona/card、NewAPI 配置或其它插件配置。
- 不部署 source、tests、`.git`、`node_modules`、生产数据或 credentials。
- 不替换 `plugins/will-policy`、NapCat 或其它未列入候选的 plugin dist。
- 不删除 `interactions` transcript、其它 JSONL、Koishi 数据库/消息表、运行日志、assets、artifacts、workspace、memory、quota 或 backups。
- 不发送 QQ/Sandbox/其它真实平台消息，不调用真实模型或业务工具，不创建 Git commit。

## 2. 候选构建与依赖边界

本地源码和测试是候选的唯一代码来源；远端工作树可能有用户已有 dirty changes，不能整体同步或 reset。候选只包含两个已验证 workspace package 的完整 `dist` 文件清单：

- `packages/agent-runtime/dist/**` → 远端 `packages/agent-runtime/dist/**`；
- `core/dist/**` → 远端 `core/dist/**`。

每个候选文件记录相对路径、bytes、SHA-256、mode 和构建时间。当前任务没有修改 `core/package.json` 或 `packages/agent-runtime/package.json`，因此默认只验证远端 manifest 的 `main`/`exports`/`types` 与 `require.resolve()` 结果，不覆盖 manifest。若 manifest、依赖版本或 package resolution 与候选不兼容，停止并更新计划，不以“顺手复制 package.json”绕过门禁。

候选生成使用当前已验证的本地源码，但不把整个 dirty checkout 当作可部署文件。执行阶段先保存任务涉及 source/test 的 hash manifest；若从上次验证到构建时发现目标包有未解释的新增/删除修改，先回到 planning，不能静默扩大候选。

## 3. 跨层数据流

```text
本地 source/test
  → package focused checks + build
  → candidate dist manifest/hash
  → ssh2 isolated staging
  → remote hash/path validation
  → owner-only backup of old dist + session files
  → stop yesimbot-koishi
  → post-backup baseline recheck
  → per-file atomic dist replacement
  → fixed-list session cleanup
  → start yesimbot-koishi
  → module/HTTP/log/container/invariant verification
```

会话清理与代码部署共用一次停机窗口，但拥有独立 manifest 和 rollback 逻辑：代码替换只处理 dist allowlist；清理只处理执行前登记的 session file allowlist。任何未列入清单的路径都不会进入复制、替换或删除命令。

## 4. 远端预检与基线

部署执行前使用新 SSH 连接并启用既有 host-key 校验，记录脱敏的：

1. 主机身份、用户、OS、磁盘余量和关键挂载；
2. `yesimbot-koishi` / `yesimbot-napcat` 的 ID、名称、镜像、running、exit code、OOM、restart count、StartedAt；
3. 容器 bind mount 与 workspace/data 的真实 `realpath`；目标路径不能是 symlink、mount point 或未知父路径；
4. `127.0.0.1:15140/` 的 HTTP 基线（只记录状态码）；
5. 当前 Core/Agent runtime package resolution 和入口文件存在性；
6. 目标 dist 的逐文件 hash，以及本任务保护性对照项的 hash/存在性；
7. 会话文件 manifest：只统计 `channels/**/sessions/*.jsonl` 的相对路径、数量、总字节和 SHA-256，不读取、不输出聊天正文。

保护性对照项至少包括 `koishi.yml`、两个 workspace package manifest、willingness/reservation state（若存在）、assets/artifacts/workspace 目录 aggregate metadata、已发现的 NewAPI snapshot 目录和 NapCat 容器 StartedAt。它们不进入本任务写入 allowlist；替换和清理前的对照必须严格不变。

启动后的验收分成两段：部署停机窗口内的 protected state 变化必须为零；服务恢复后，运行时自有的 `willingness.json`/reservation state 可能因自然流量更新，此类变化只记录 metadata/hash、不得由本任务恢复或删除。清理后新建的 session 文件也不属于执行前 manifest，必须保留并报告，不能为了追求最终零文件再次删除。

远端没有找到 session 文件时是合法的零文件基线，不代表可以搜索或删除其它路径。执行阶段仍须同时从宿主机真实路径和容器内映射路径复核；两者不一致时停止。

`server-cleanup.md` 的广泛服务器清理合同在这里按 task-scoped exception 使用：用户明确批准的是应用 durable session 文件的精确删除，不是 bind mount/服务器目录整体清理；删除前停止 Koishi、固定 realpath、备份和 hash guard 是强制门禁。未执行的泛化进程/open-file 全盘清理不被虚报为本任务已完成。

## 5. 备份、清单与回滚

### 备份结构

在所有远端写入前创建唯一 run id 和 mode `700` 的目录：

```text
/opt/yesimbot/backups/<run-id>/
├── deployment/       # 被覆盖的旧 dist 文件，保留相对路径和元数据
├── history/          # 仅本次登记的 session JSONL，保留原始相对路径
├── manifests/        # preflight/candidate/post-cleanup hash 与状态
├── logs/             # 有界、脱敏的命令结果摘要
└── rollback.sh       # mode 700，固定路径和 hash guard
```

备份文件和 manifest 不回传到本地；任务记录只写数量、bytes、hash 前缀/状态和备份路径，不写聊天正文、token 或配置秘密。若无 session 文件，`history/` 为空且 manifest 明确记录 `count=0`。

### 回滚合同

`rollback.sh` 只接受本 run 生成的固定路径，不接受根目录、父目录或 wildcard。回滚前：

- 只停止 `yesimbot-koishi`，确认它处于停止状态；
- 校验 live dist 仍等于本次 candidate hash，若已被其它操作改动则停止，不能覆盖未知修改；
- 按旧 dist manifest 恢复文件，目标缺失/新建文件只有在仍等于本次 candidate hash 时才处理；
- 恢复会话文件前验证备份 hash；活动路径若已经出现新文件或 hash 不符合预期则不覆盖，保留并报告 `partial`，避免抹掉任务期间的新数据；
- 恢复完成后只启动并验证 `yesimbot-koishi`，不触碰 NapCat。

代码回滚和历史恢复是两个可审计步骤。部署/健康检查失败时优先恢复到部署前的代码和可证明未被新消息占用的历史状态；若历史恢复因新文件或 hash 漂移无法安全执行，保留现状和备份并明确报告，不强制覆盖。

## 6. 停止、部署与原子替换

1. 候选 tar/staging 只放在远端隔离目录，解包前检查 archive 条目无绝对路径、`..`、symlink/hardlink 或超出候选 manifest 的文件。
2. 备份目标 dist 后停止 `yesimbot-koishi`；确认容器已停止，并重新生成 session/dist 基线。备份后任一目标文件变化时，取消部署和清理，启动原容器并报告冲突。
3. 对候选 manifest 中的每一个 dist 文件：
   - 验证候选 SHA-256、mode 和相对路径；
   - 验证目标父目录仍是预期 workspace 且不是 mount/symlink；
   - 写入同目录唯一临时文件并完成 hash 校验，再用同目录 `rename/mv` 替换目标文件；
   - 不使用 `rsync --delete`、目录级覆盖或 wildcard，候选之外的远端 dirty 文件保持不变并记录。
4. 全部文件替换后重新计算两个 dist 的候选 hash；入口文件做 `node --check`/package loadability 检查。失败时不启动新代码，执行 hash-guard rollback。
5. 仅当代码候选校验通过后，进入 session cleanup；这样代码部署失败不会先删除聊天历史。

## 7. 会话清理合同

目标只来自执行前生成的固定 manifest：

```text
<real-data-root>/channels/**/sessions/*.jsonl
```

实际删除脚本接收 manifest 展开的精确文件路径数组，并逐个验证：

- `realpath` 仍位于固定 data root 下；
- 是 regular file，不是 symlink、目录、mount 或未知类型；
- 当前 bytes/SHA-256/mtime 与备份后的 recheck 一致；
- 不匹配时在任何删除前停止。

全部预验证通过后逐个 `rm -- <exact-path>`，不使用 `find -delete` 或可重新解释的 wildcard。保留 channel/session 父目录及所有非 session 文件。删除后重新统计目标数量和 bytes，并通过容器映射路径复核为零；若执行前是零文件，则整个阶段为 no-op。

清理备份保留在远端 owner-only 目录，不在本任务中永久销毁。若后续要清理备份，必须另建任务并单独列出备份路径。

## 8. 启动与验收

清理完成后只执行 `docker start yesimbot-koishi`，不执行全局 compose 操作。使用新 SSH 连接完成最终验收：

- `yesimbot-koishi` 为 running，exit code `0`，OOM 为 false，restart count 没有非预期增加；
- `yesimbot-napcat` 的 container ID、StartedAt、running/exit/OOM 与基线一致；
- `curl http://127.0.0.1:15140/` 返回 HTTP `200`；
- `require.resolve('koishi-plugin-yesimbot')` 与 `require.resolve('@yesimbot/agent-runtime')` 指向预期 dist，入口可加载；
- 启动后有界日志显示 Core/Agent runtime/既有相关插件加载，且没有相对基线新增的 fatal、uncaught、module-resolution 或启动失败标记；不把原始聊天/工具参数写入报告；
- 执行前 session manifest 中的文件均已清理；启动后新建的 session 文件若出现，只记录并保留，不删除；backup/rollback script 可读取且 hash 校验通过；
- `koishi.yml`、模型配置、assets/artifacts/workspace、NewAPI snapshots 和 NapCat 对照项保持不变；运行时 `willingness`/reservation 状态若在启动后变化，必须标记为外部运行时变化而不是本任务写入；
- `df`、候选目录大小和目标路径前后统计已记录。

健康检查只证明进程、HTTP、包加载和文件状态，不证明真实平台消息送达；本任务不发送 canary。

## 9. 失败矩阵

| 失败条件 | 处理 |
| --- | --- |
| SSH 主机/用户/host key 不匹配 | 立即停止，不写远端 |
| 目标 realpath、mount、package resolution 不符合预期 | 停止，不替换、不删除 |
| 候选 archive/hash/manifest 不一致 | 删除仅本次 staging，保留目标不变 |
| 备份复制或 hash 校验失败 | 不停机；报告并停止 |
| 停止后 session/dist 基线漂移 | 不部署、不清理，启动原容器并报告冲突 |
| 任意 dist 替换或 loadability 失败 | 停止新代码，按 candidate hash guard 恢复旧 dist，再启动并验收 |
| session 预验证失败或删除中途失败 | 立即停止后续删除，按备份尝试精确恢复已删除文件；无法证明安全时报告 `partial` |
| 启动、HTTP、模块加载或日志验收失败 | 停止继续观察，按 rollback 恢复代码及可安全恢复的 session，重启同一容器 |
| 保护性对照项或 NapCat 发生非预期变化 | 不覆盖未知状态，报告验收失败并保留备份 |

## 10. 生产激活边界

本设计只覆盖用户已确认的 SSH2 部署和“仅 YesImBot session JSONL”的清理。规划批准后才可进入执行阶段；仍然禁止真实平台消息、NapCat 重启、配置扩展和超出固定 manifest 的删除。任何需要修改 Will routing/willingness 配置或 Koishi 数据库的请求，都必须另建范围并再次确认。
