# 清理 ssh2 垃圾和缓存文件

## Goal

在 `ssh2`（`VM-0-13-debian`）上回收已经确认可删除、可重建或明确属于历史保留项的空间，重点清理 NewAPI 请求体快照、过期备份、可安全收缩的未使用 Docker 镜像，以及 Docker BuildKit / APT 缓存；同时保持线上服务、业务数据、配置、历史记录和至少一个对应回滚点可用。

## Background and confirmed inventory

- 远端根分区约 79G，已用约 41G，可用约 38G；清理目标是降低已确认的非业务占用，不追求全盘“归零”。
- Docker 当前有 21 个容器，其中 19 个运行中、2 个 `caimogu-bot-before-*` 已停止；停止容器及其镜像属于需要保留的历史回滚资源。
- Docker BuildKit cache 约 99MB 可回收，APT archive cache 约 170MB 可清理。
- `/root/.cache` 约 829MB（主要为 `go-build` 和 `node-gyp`），`/root/.yarn/berry` 约 627MB；这些是跨项目开发缓存，本次不处理。
- `/opt/yesimbot/.tmp` 约 688MB，主要为临时工作树，不按普通缓存删除；`/var/log` 约 445MB，不做无范围的历史日志删除；全量 `/tmp` 也不处理。
- 实际 NewAPI 容器名为 `newapi`，不是 `newapi1`；其宿主机数据目录为 `/opt/newapi/data`，请求快照位于 `/opt/newapi/data/request_snapshots`，约 13,013 个加密 `.snap` 文件、约 10.7GB。该目录与 `one-api.db`、`one-api.db-wal`、`one-api.db-shm` 分离，盘点时未发现快照目录被进程打开。
- `/opt/newapi/backups` 当前有 `pre-request-snapshot-clear-20260910T043246Z` 和 `cleanup-pre-retention-20260909T034218Z` 两个备份目录；最新备份需保留。
- 已明确的备份根白名单为：
  - `/opt/9router/backups`
  - `/opt/9router-data/db/backups`
  - `/opt/caimogu-bot.deployments/*/backup`（每个已存在的 deployment backup 根单独处理）
  - `/opt/cliproxyapi-compose/backups`
  - `/opt/cmdcode2api/backups`
  - `/opt/gemini-web2api/backups`
  - `/opt/newapi/backups`
  - `/opt/resin/backups`
  - `/opt/yesimbot/backups`
- Docker 中存在旧的 NewAPI、CLIProxyAPI、cmdcode2api、通用 Go/Alpine 等镜像候选；其中两个停止的 `caimogu-bot-before-*` 容器引用的镜像必须保留。本次以容器实际引用的 image ID 为准，不以镜像名称猜测是否安全。

## Requirements

- **R1 — 清理前审计**：记录清理前根分区、目标目录、Docker、APT、备份根和全部容器的非敏感元数据；不读取或输出请求正文、数据库内容、凭据、API key、token、QQ/NapCat 登录状态或历史消息。
- **R2 — 明确边界**：所有删除动作只能来自本 PRD 的路径白名单或清理前生成的精确 Docker image ID 清单；根路径、符号链接、挂载边界、容器状态或文件类型不符合预期时必须中止对应阶段。
- **R3 — 清理 NewAPI 请求快照**：清理 `/opt/newapi/data/request_snapshots` 中已有快照，保留 `/opt/newapi/data/one-api.db` 及其 WAL/SHM 文件；不修改快照功能配置，因此后续请求仍可能产生新的快照。清理不能通过重启 NewAPI 完成。
- **R4 — 备份保留策略**：对显式白名单中的每个 backup 根，按“一个服务/项目的一个明确备份根”为保留单位，只保留最新的、可识别为版本化备份 bundle 的直接子目录；没有明确版本化目录的直接文件、未知命名项、根目录本身和仅有一个候选的根不删除。`/opt/9router/backups` 与 `/opt/9router-data/db/backups` 因为是两个独立回滚根，分别保留一个；`caimogu-bot.deployments/*/backup` 逐个 deployment 根分别处理。
- **R5 — 未使用镜像保留策略**：保留所有被运行中或已停止容器引用的 image ID；对剩余、带明确 repository/project 归属的未引用镜像，按 repository/project 分组，每组保留最新一个未引用 image ID，仅删除同组更旧且未被任何容器引用的 image ID。未标注 repository、归属不明、无法安全分组或删除时出现依赖冲突的镜像跳过并报告。
- **R6 — 可重建缓存**：清理 Docker BuildKit build cache 和 APT archive cache；不执行 `docker system prune`、`docker image prune -a`、`docker volume prune` 或其他未列入白名单的缓存清理。
- **R7 — 服务不变**：不主动停止、重启、重建或升级任何线上容器；清理前后容器集合、运行/停止状态、健康状态和 restart count 应保持不变，任何外部或自然变化都要如实报告。
- **R8 — 清理后验证**：重新记录磁盘、目标目录、Docker、APT 和服务状态，确认请求快照目录已清空或只包含清理期间重新生成的文件，数据库文件仍存在，停止容器和 Docker volumes 未被删除，并计算实际释放空间及跳过项。

## Acceptance Criteria

- [x] 清理前审计和清理后审计均已完成，输出仅含路径、名称、数量、大小、时间和状态等非敏感摘要。
- [x] `/opt/newapi/data/request_snapshots` 的旧快照已清除；`one-api.db`、WAL/SHM 仍存在且未被删除；NewAPI 未因本次操作重启。
- [x] 每个白名单 backup 根至少保留其最新明确备份；旧备份删除范围仅限审计清单中的旧版本化 bundle，未删除未知项或根目录直接文件。
- [x] 未引用镜像的删除仅来自精确 image ID 清单；运行中和停止容器引用的镜像、容器本身、Docker volumes 均保持不变。
- [x] Docker BuildKit cache 和 APT archive cache 已清理；未执行全量 Docker prune、全量 `/tmp` 清理、日志清理或跨项目开发缓存清理。
- [x] `yesimbot-koishi`、`yesimbot-napcat`、`newapi` 以及清理前存在的其他容器保持原有运行/停止和健康状态；没有主动重启服务。
- [x] 报告实际释放量、保留的最新备份/镜像类别、跳过的风险项、后续缓存重建影响和不可逆操作的回滚限制。

## Key decisions and risks

- NewAPI 快照采用“同文件系统原子改名 + 创建同权限空目录 + 删除脱离的旧目录”的方式，而不是在原目录内逐个删除；这样可避免清理期间新写入的快照落入待删目录，也不需要重启服务。
- “最新一个”按服务/项目的明确 backup 根和 repository/project 归属解释，不采用整台主机全局只留一个。这样仍会删除各根的旧回滚材料，但不会把不同服务的回滚链混成一个全局候选集。
- 旧备份、未引用镜像和快照删除后不保证本机可逆；运行中/停止容器及其镜像的保留是主要本地回滚保障。BuildKit/APT 清理只会导致后续构建或安装重新下载。
- 本次不关闭 NewAPI 快照功能；如果用户希望以后不再生成请求快照，需要另行进行配置变更和单独验证。

## Out of scope

- 不删除 NewAPI 数据库、WAL/SHM、业务数据、渠道/用户/token、请求日志表或其他 `/opt/newapi/data` 内容。
- 不删除 `/opt/yesimbot/data`、`/opt/yesimbot/backups` 中保留的最新备份、Koishi/NapCat 配置、Persona/card、历史、消息/媒体文件或 Docker volumes。
- 不删除停止容器，不删除这些容器引用的镜像，不停止或重启任何线上服务。
- 不处理 `/root/.cache`、`/root/.yarn/berry`、`/opt/yesimbot/.tmp`、`/var/log`，不全量删除 `/tmp`，不修改项目源码或运行配置。
- 不自动发现并删除白名单之外的 `backup`/`backups` 目录，不删除备份根中的未知命名项或直接文件。
- 不读取、解密、输出或在任务文件中保存任何请求正文、数据库敏感字段、凭据、API key、token、QQ/NapCat 登录数据或 SSH 认证信息。

## Open questions

无。用户已批准上述范围并完成执行：按服务/项目保留最新备份、按 repository/project 保留最新未引用镜像，保留停止容器及其镜像，清理 NewAPI 现有请求快照和 Docker BuildKit/APT 缓存。
