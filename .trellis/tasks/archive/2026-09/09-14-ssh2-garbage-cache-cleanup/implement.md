# 执行计划：ssh2 垃圾和缓存清理

## 前置门槛

- [x] 已创建子任务 `.trellis/tasks/09-14-ssh2-garbage-cache-cleanup`，状态仍为 `planning`。
- [x] 已完成远端只读盘点，确认 NewAPI 实际容器为 `newapi`，请求快照目录约 10.7GB。
- [x] 用户已确认推荐范围：按服务/项目保留最新备份、按 repository/project 保留最新未引用镜像、保留停止容器及其镜像，并清理 BuildKit/APT cache。
- [x] 将本最终规划摘要展示给用户并获得明确批准。
- [x] 获得批准前未执行 `task.py start`、任何远程写操作或删除命令。

## 1. 激活任务与读取上下文

1. 用户明确批准最新规划后，执行：
   `python ./.trellis/scripts/task.py start .trellis/tasks/09-14-ssh2-garbage-cache-cleanup`
2. 确认 `task.json.status` 变为 `in_progress`，并重新读取本任务的 `prd.md`、`design.md`、`implement.md` 及 `implement.jsonl` / `check.jsonl`。
3. 只使用本计划中的白名单；若远端现状与本计划发生实质漂移，先回到 planning 更新 PRD，不现场扩大范围。

执行结果：任务已激活为 `in_progress`，上下文清单验证通过；远端实际状态与计划边界一致，未扩大白名单。

## 2. 远程只读预检

使用 `ssh -o BatchMode=yes -o ConnectTimeout=10 ssh2 'bash -s'` 运行受控脚本；脚本启用 `set -euo pipefail`，不使用 `set -x`，不把任何文件内容、环境变量或 secret 输出到 stdout/stderr。Docker inspect 的可选字段必须通过 `index` 读取；镜像时间必须将 Docker `Created` ISO 时间转换为 Unix epoch 后再做数值排序。

执行结果：已完成远端预检，确认 21 个容器（19 running、2 exited）、12 个 volumes、NewAPI 挂载和关键数据库文件均符合预期；快照旧树为 13,014 个文件、10,738,334,960 bytes。

记录到短生命周期 root-only 状态（优先 `/run`，完成后删除）的内容：

- `df -P` 根分区和每个目标目录的 `du` 大小/文件数。
- `docker ps -a` 的容器 ID、名称、状态、健康状态、restart count、image ID；保存完整容器集合以便前后比较。
- Docker volumes 名称集合。
- 所有容器 image ID 引用集合；单独确认停止的 `caimogu-bot-before-*` 容器仍存在。
- 目标 `newapi` 的状态、挂载 `/opt/newapi/data -> /data`、restart count，以及 `/opt/newapi/data/request_snapshots` 的类型、owner/group/mode、文件数和字节数。
- `one-api.db`、WAL/SHM 的存在性、类型、大小和时间元数据；不读数据库内容。
- 白名单 backup 根的直接子项类型、名称、mtime、大小；不读 bundle 正文。
- `docker system df` / BuildKit cache 与 APT archive cache 统计。
- apt/dpkg 是否存在运行事务或锁占用。

预检守卫：目标快照根必须是真实目录；NewAPI 挂载必须匹配；关键数据库文件不得缺失；白名单根不得解析到白名单之外；容器集合和状态在正式变更前不得漂移。任何失败都停止，不执行删除。

## 3. 生成并复核删除清单

1. 从预检元数据生成两份清单：
   - `backup_delete_list`：每个白名单根中除最新版本化直接子目录外的旧候选目录。
   - `image_delete_list`：不被任何容器引用、带明确 repository/project 归属、且属于同组较旧项的 image ID；分组排序必须使用 Docker `Created` ISO 时间转换后的 Unix epoch 数值，不能直接按带时区的展示字符串排序。
2. 清单只保存绝对路径或 image ID、类型、大小、mtime、所属根/分组和判定原因，不保存文件内容或 secret。
3. 复核：
   - 最新备份在每个根仍存在；只有零/一个候选的根不产生删除项。
   - backup 直接文件、未知命名项、符号链接、无法排序项没有进入清单。
   - image 清单不包含任何运行中或停止容器的 image ID，不包含 `<none>` 或归属不明镜像；同一 image ID 只要在任一组为保留项就移出删除清单。
   - 删除列表中没有当前快照目录、父目录、Docker volume 名称或容器 ID。
4. 将清单摘要写入临时审计状态；不在最终回复展示敏感文件内容。

执行结果：备份 dry-run 识别 42 个旧版本化 bundle、预计 453,411,017 bytes；镜像 dry-run 在修正 epoch 排序后只识别 1 个可删除镜像 `golang:1.26.1-alpine`。

## 4. 原子清理 NewAPI 请求快照

执行结果：原子替换和退休目录删除成功；旧树 13,014 个文件、10,738,334,960 bytes，当前目录 0 个文件；目录权限仍为 `700`、owner/group 为 `0/0`。

1. 再次检查 `newapi` 状态、目标路径类型、目录未被打开，并确认当前请求快照路径没有发生异常漂移。
2. 在 `/opt/newapi/data` 同一文件系统内把 `request_snapshots` 原子改名为本次唯一 retired 路径。
3. 以原 owner/group/mode（和可复制的 ACL）创建新的空 `request_snapshots` 目录。
4. 复核新路径可访问后，只删除本次 retired 路径；删除命令不得包含通配符。
5. 若改名或新目录创建失败，立即停止且保留原树；若 retired 树删除失败，保留失败路径并停止后续高风险阶段。
6. 复核当前目录为空或只有清理期间重新生成的 `.snap` 文件，且 `one-api.db`、WAL/SHM 未被删除。

回滚点：在 retired 树删除前且新目录为空时，可删除新目录并将 retired 树改回原名；新目录已有写入或 retired 树已删除后，不覆盖新目录、不伪造回滚。

## 5. 收缩备份保留量

执行结果：已删除 42 个旧版本化 bundle，共 453,411,017 bytes；每个有多个候选的根均保留最新项，两个 caimogu deployment 根的直接文件和未知目录未删除。

1. 删除前重新确认每个 `backup_delete_list` 项仍是对应白名单根的直接子目录，类型、mtime 与预检一致。
2. 逐项删除旧版本化 bundle；不删除直接文件、未知目录或根目录。
3. 每删一项立即记录成功/失败的路径、大小和错误类别；不重试已发生漂移的路径。
4. 复核每个根的最新候选仍存在，且没有误删 `/opt/yesimbot/backups` 的最新项或 `/opt/newapi/backups/pre-request-snapshot-clear-20260910T043246Z`。

回滚点：旧备份删除不可通过本机自动恢复；若出现路径漂移或最新项缺失，停止后续删除并报告，不用其他备份覆盖现场。

## 6. 收缩未使用 Docker 镜像

执行结果：已删除 `golang:1.26.1-alpine`（241,128,318 bytes）；运行中和停止容器引用的镜像均未删除。

1. 删除前重新获取全部容器 image ID，和预检保护集合做精确比较；若任何容器集合或 image 引用发生变化，放弃整个 image 删除阶段。
2. 逐个将 `image_delete_list` 中的 image ID 传给不主动清理 parent image 的删除操作；不执行任何 image/system prune。
3. Docker 返回“被引用/依赖/有冲突”时跳过该 ID并记录，不强制删除，不删除对应容器。
4. 复核：运行中和停止容器都存在，`caimogu-bot-before-*` 及其镜像仍存在，保护 image ID 未变化，Docker volumes 未变化。

回滚点：已删除的未引用镜像需重新拉取或重建；本阶段不得触碰运行中/停止容器使用的镜像，因此不需要通过停止服务回滚。

## 7. 清理 BuildKit 与 APT cache

执行结果：BuildKit cache 已清理到 0；APT archive cache 从 177,233,624 bytes 降至 24,576 bytes。

1. 确认没有 apt/dpkg 事务或锁占用；若有则跳过 APT 阶段，不删除锁。
2. 记录 BuildKit cache 与 APT archive cache 的清理前统计。
3. 仅执行 BuildKit build cache 的强制清理和 APT archive cache 清理；不删除 APT lists。
4. 记录命令结果和清理后统计；命令失败时保留现场并报告，不扩大到其他缓存。

回滚点：两类缓存可由未来构建/安装重新生成，无法按原命中状态恢复；不影响当前容器运行。

## 8. 清理后验证

执行与预检同口径的 metadata-only 审计并比较：

执行结果：21 个容器、12 个 volumes、停止容器及其镜像均仍存在；容器 ID、运行/停止状态、健康状态、restart count 和 image ID 与清理前一致；`newapi`、`yesimbot-koishi`、`yesimbot-napcat` 均未重启；数据库文件仍存在；无 retired 快照目录。

- `df -P /`、目标目录大小、快照文件数/字节数和实际释放量。
- `docker ps -a` 容器集合、状态、健康状态、restart count、image ID 与预检一致。
- `newapi`、`yesimbot-koishi`、`yesimbot-napcat` 及其他线上容器仍为原状态；不以“重新启动成功”替代“不曾重启”的验证。
- `/opt/newapi/data/request_snapshots` 存在且权限与原目录一致；旧 retired 路径已删除或明确报告未删；数据库及 WAL/SHM 仍存在。
- 每个白名单 backup 根的最新候选仍在；删除项和跳过项数量与审计清单一致。
- 所有停止容器仍在；停止容器引用的 image ID 仍在；Docker volumes 名称集合未变化。
- BuildKit/APT cache 已减少或已明确标记跳过；`/root/.cache`、Yarn cache、`.tmp`、日志和全量 `/tmp` 未被处理。

若服务状态或关键文件验证失败，停止交付结论，先报告失败阶段和未完成验证；不主动重启或清理更多内容。

## 9. 交付与收尾

执行结果：已写入 `research/execution-result.md`，包含清理前后非敏感统计、实际释放量、保留项、跳过项、回滚限制和过程质量记录。

- 输出清理前后非敏感统计、实际释放量、保留的最新备份根、镜像分组结果摘要、跳过项和缓存重建影响。
- 明确说明快照功能未关闭，后续可能再次生成 `.snap` 文件。
- 明确列出不可逆范围：已删旧备份、已删未引用镜像、已删历史请求快照、BuildKit/APT cache。
- 不输出请求正文、数据库字段、备份内容、API key、token、密码、哈希或原始日志。
- 已执行 `python ./.trellis/scripts/task.py validate .trellis/tasks/09-14-ssh2-garbage-cache-cleanup` 并通过；本任务无产品代码变更，未提交 git commit；完成本次质量复核后归档任务。

## 验证命令模板

以下模板只允许输出状态/大小/名称等摘要，不能增加 `cat`、数据库 dump、环境变量输出或日志打印：

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 ssh2 'docker ps -a --format "{{.ID}}|{{.Names}}|{{.Status}}|{{.Image}}"'
ssh -o BatchMode=yes -o ConnectTimeout=10 ssh2 'docker inspect newapi --format "{{.State.Status}}|{{.RestartCount}}|{{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}"'
ssh -o BatchMode=yes -o ConnectTimeout=10 ssh2 'df -P /; du -sh /opt/newapi/data/request_snapshots /opt/newapi/backups /opt/yesimbot/backups'
ssh -o BatchMode=yes -o ConnectTimeout=10 ssh2 'docker system df; du -sh /var/cache/apt/archives'
```

这些模板仅用于最终元数据核对；正式删除使用第 2–7 节的单次受控脚本及其临时状态，不拆成无保护的手工 `rm` 命令。
