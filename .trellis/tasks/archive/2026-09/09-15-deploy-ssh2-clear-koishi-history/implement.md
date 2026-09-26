# 执行计划：部署 SSH2 Koishi 构建并清理会话历史

> 用户已批准本计划；执行已于 2026-09-15 完成。实际结果、2 个 session 文件清理、候选部署、一次 mount-order guard 误报及恢复过程见 `research/execution-result.md`。本文件保留执行门禁和回滚顺序。

## 0. 规划批准与任务入口

- [x] 向用户展示 Goal、In Scope、Out of Scope、验收标准、风险和本文件中的回滚边界。
- [x] 用户明确回复批准按本计划在 `ssh2` 部署并清理。
- [x] 批准后运行：

  ```bash
  python ./.trellis/scripts/task.py start .trellis/tasks/09-15-deploy-ssh2-clear-koishi-history
  ```

- [x] 启动后重新读取 `prd.md`、`design.md`、`implement.md`、`implement.jsonl`、`check.jsonl` 和适用的 backend/ops spec；实际路径和用户范围与计划一致。

## 1. 本地候选构建与门禁

1. 记录本地 `git status --short`、任务文件 hash 和构建环境；不清理、回滚或覆盖既有 dirty changes。
2. 保存本任务依赖的 source/test manifest。候选源码以已经验证的 `09-15-disable-willingness-auto-compaction` 结果和当前批准的 YesImBot/Core 代码为准；只把生成的 package dist 作为传输内容，不复制整个 checkout。
3. 在本地执行并记录：

   ```bash
   corepack yarn workspace @yesimbot/agent-runtime build
   corepack yarn workspace koishi-plugin-yesimbot build
   npx tsc --noEmit -p packages/agent-runtime/tsconfig.json
   npx tsc --noEmit -p core/tsconfig.json
   npx vitest run packages/agent-runtime/tests --exclude '.tmp/**' --exclude '.trellis/**'
   npx vitest run plugins/will-policy/tests --exclude '.tmp/**' --exclude '.trellis/**'
   TMP=$PWD/.tmp/vitest-tmp TEMP=$PWD/.tmp/vitest-tmp npx vitest run core/tests --exclude '.tmp/**' --exclude '.trellis/**'
   ```

   以当前 package scripts 和 Windows shell 可用语法为准；不因无关测试失败去修改其它任务代码。已有无关失败必须分类记录。

4. 对本任务涉及的 source/test/dist 运行 `npx oxfmt --check`、`npx oxlint` 和 `git diff --check`；检查 staging 不含 `.env`、credentials、生产 data、JSONL、`node_modules` 或临时调试代码。
5. 在 `.tmp/<run-id>/candidate/` 生成候选 tar 和精确 manifest：相对路径、bytes、SHA-256、mode、package 名称。候选只包含：
   - `packages/agent-runtime/dist/**`；
   - `core/dist/**`。
6. 对候选入口运行 `node --check`/等价 loadability 检查；保存构建日志和 hash，不把 source map 中的绝对本机路径或任何秘密写入最终报告。

**Gate A：** 两个 package build、类型检查、适用 tests 和质量门禁通过；候选 manifest 固定；若发现未解释的 source/package scope 漂移，停止并回到 planning。

## 2. SSH2 远端只读预检

使用新的 SSH 连接和既有 host-key 校验执行，只读命令不得输出凭据、聊天正文或完整配置：

1. 记录主机身份、用户、OS、磁盘余量、关键监听端口和 Docker 根目录。
2. 记录 `yesimbot-koishi` 与 `yesimbot-napcat` 的 container ID、名称、镜像、running、exit code、OOM、restart count、StartedAt、重启策略和 mounts。
3. 解析并确认以下 realpath 与 mount 状态：
   - `/var/lib/docker/volumes/yesimbot_koishi-app/_data/yesimbot-v4`；
   - `/opt/yesimbot/data/koishi/yesimbot`；
   - 容器内 `/koishi/yesimbot-v4`、`/koishi/data/yesimbot`。
4. 确认目标 dist 文件为 regular file，父目录不是 symlink/mount；确认远端 package manifest 的 `main`/`exports`/`types` 与当前 `require.resolve()` 结果。
5. 记录 `http://127.0.0.1:15140/` 的 HTTP 基线状态码。
6. 生成两份不含正文的清单：
   - 当前两个 dist 的逐文件 path/bytes/hash；
   - `channels/**/sessions/*.jsonl` 的 path/bytes/hash/mtime、数量和总字节数。
7. 记录 `koishi.yml`、模型配置、Will/willingness state、assets/artifacts/workspace、NewAPI snapshot 目录的存在性/hash 或 aggregate metadata；这些路径不进入写入 allowlist。

远端候选上传只能放入本 run 的隔离 staging；上传后由远端重新计算 SHA-256，任何不一致都停止且不解包/不部署。

**Gate B：** SSH 主机/用户、容器、mount、realpath、HTTP、package resolution、候选 hash 和 session path 映射全部符合预期；host dirty worktree 中的未列入文件保持 untouched。

## 3. 生成 owner-only 备份并停止服务

1. 创建唯一 `/opt/yesimbot/backups/<run-id>/`，目录 mode `700`；保存 `deployment/`、`history/`、`manifests/`、有界日志摘要和后续 `rollback.sh`。备份文件不下载到本地。
2. 按逐文件 manifest 复制旧 `core/dist`、`packages/agent-runtime/dist` 中实际将被覆盖的文件；每个文件复制后重新校验 bytes/hash/mode。候选之外的远端 dist 文件只记录，不删除。
3. 按 session manifest 复制所有目标 `sessions/*.jsonl` 到 owner-only `history/`，保留原始相对路径和 hash；不读取/打印聊天内容。零文件时写入 `count=0` manifest。
4. 写入 rollback script 的固定路径数组、旧 hash、候选 hash、容器名和受保护对照项；script mode `700`。
5. 只停止 `yesimbot-koishi`，确认它已停止；不停止 `yesimbot-napcat`。
6. 停止后重新生成 dist/session manifest，与备份后的 baseline 逐项比较。任一文件发生变化时：不替换、不删除，按原状态启动 Koishi，保留备份并报告冲突。

**Gate C：** 备份逐文件 hash 校验通过；停止后目标未漂移；NapCat 状态未改变。否则不进入部署/清理。

## 4. 受保护替换候选 dist

1. 校验远端 staging archive 条目为候选 manifest 的精确集合；拒绝绝对路径、`..`、symlink/hardlink、额外文件和路径逃逸。
2. 对每个候选 dist 文件执行 hash-guarded、同目录临时文件写入：完整复制到唯一临时名，校验 hash 后使用同目录 `rename/mv` 替换目标。禁止目录级覆盖、`rsync --delete`、wildcard 或删除候选外文件。
3. 每个目标替换前确认父目录 realpath、mount、owner/mode 和 preflight hash 未改变；变化即停止。
4. 全部替换后重新计算候选 manifest，并在容器停止状态下执行入口 `node --check`、`require.resolve()` 和 `require()`/等价包加载检查。
5. 若任一文件失败或 loadability 失败，立即用 candidate hash guard 回滚旧 dist；不启动半成品，不执行聊天清理。

**Gate D：** Core 与 Agent runtime 候选 hash、入口加载和 package resolution 全部通过；生产配置和候选外 source/session 数据未被修改，NapCat 未被触碰。部署后另外完成了 9 个 dist 文件 mode 规范化为 `0644`，并更新了可执行 rollback script。

## 5. 按固定清单清理聊天历史

1. 仅使用 Gate C 生成并复核过的 session file path 数组；不得重新解释为根目录、父目录或新的 wildcard。每个路径再次确认：
   - realpath 在固定 YesImBot data root 下；
   - 是 regular file，不是 symlink、目录、mount 或未知类型；
   - bytes/hash/mtime 与停止后的 manifest 一致。
2. 先完成全部路径的预验证，再逐个执行精确 `rm -- <path>`；不使用 `find -delete`、`rm -rf` 或目录清理。
3. 删除后从宿主机和容器映射路径重新统计 `sessions/*.jsonl` 数量和总字节数，预期为 `0`；保留空的 channel/session 父目录和所有非 session 数据。
4. 若预验证失败或删除中途失败，停止后续动作，按 history backup 逐文件恢复已删除且仍为空/可证明未被新数据占用的路径；无法安全恢复则报告 `partial`，不覆盖新文件。

**Gate E：** 执行前 manifest 中的 2 个 session 文件已删除且 history backup/hash 可读；启动后出现的 1 个新 session 文件未被删除。未触及 Koishi DB、日志、其它 JSONL、assets、workspace、Will state 或 NewAPI snapshots。

## 6. 只启动 Koishi 并进行最终验收

1. 只执行 `docker start yesimbot-koishi`；不执行全局 compose、Docker prune 或 NapCat 重启。
2. 等待就绪后用新的 SSH 连接复核：
   - Koishi `running=true`、exit `0`、OOM false、restart count 无非预期增加；
   - NapCat container ID/StartedAt/running/exit/OOM 与 baseline 一致；
   - `127.0.0.1:15140/` HTTP `200`；
   - `koishi-plugin-yesimbot` 和 `@yesimbot/agent-runtime` 解析到目标 dist，入口正常加载；
   - bounded startup logs 含 Core/Agent/既有相关插件加载证据，新增 fatal/uncaught/module-resolution/startup failure 为零；不记录 raw logs、prompt、工具参数或聊天正文；
   - 执行前 session manifest 对应的文件为零；启动后新建 session 只记录并保留；备份与 rollback script 的 owner/mode/hash 校验通过，并通过 `rollback.sh --check`；
   - `koishi.yml`、模型配置、assets/artifacts/workspace、NewAPI snapshot 对照项和 NapCat 状态不变；若运行时 willingness/reservation metadata 在启动后变化，记录但不覆盖；
   - `df`、目标目录 size、active/enabled service/port/Docker 对照符合预期。
3. 不发送 QQ/Sandbox/平台 canary，不调用真实模型、不执行 MCP/业务副作用工具；健康结论只覆盖进程、HTTP、模块加载和文件状态。

**Gate F：** 所有可在当前自然流量窗口内证明的 PRD criteria 有脱敏证据；执行前会话已清理，启动后新会话和运行时状态变化按保护合同保留并报告。如果健康检查失败，立即停止继续观察并进入回滚，不盲目重试或发送消息。

## 7. 回滚与现场保留

- **候选/上传失败：** 删除仅本 run 的 staging，目标和容器保持原状；不清理历史 backup。
- **备份/停止后漂移：** 不部署/不清理，启动原 Koishi，报告 hash 冲突。
- **dist 替换失败：** 仅在 live dist 仍匹配 candidate hash 时恢复旧 dist；若 live 已被其它操作修改，停止并报告 `partial`。
- **清理失败：** 停止删除，按固定 history manifest 精确恢复可安全恢复的文件；不覆盖任务期间新建文件。
- **启动/HTTP/包加载失败：** 停止 Koishi，执行 rollback script 恢复旧 dist 及可安全恢复的 history，再只启动 Koishi；NapCat、配置、其它数据保持不变。
- **任何保护性对照项变化：** 不以本任务备份覆盖未知变化；报告验收失败并保留唯一 backup、manifest 和 rollback script。

回滚后再次使用新 SSH 连接验证 Koishi、NapCat、HTTP、端口、容器和保护性对照项。生产备份不在本任务中删除；永久销毁聊天备份必须另建任务并再次确认。

## 8. 记录与任务收尾

- [x] 将本地 build/test/type/format/lint/hash、远端 pre/post inventory、backup 路径、session count/bytes、container/HTTP/log/module 结果写入任务 research 或执行结果；未写聊天正文、凭据或完整敏感配置。
- [x] 运行：

  ```bash
  python ./.trellis/scripts/task.py validate .trellis/tasks/09-15-deploy-ssh2-clear-koishi-history
  ```

- [x] 由 `trellis-check` 完成独立质量复核；根据复核修正了 rollback 参数、Linux dist mode、动态 session/state 观察和 task context 登记，主会话已逐条核对 scope 与“不发送真实消息”边界。
- [x] 不创建 Git commit；未归档/删除本地或远端无关 dirty changes。
- [x] 最终报告明确：部署/清理是否完成、实际清理数量/bytes（不含正文）、健康检查、NapCat 是否未变、备份/回滚路径、失败或未验证项。
