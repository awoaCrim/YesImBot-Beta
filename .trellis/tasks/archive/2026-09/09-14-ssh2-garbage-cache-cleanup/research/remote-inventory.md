# ssh2 远端清理盘点摘要

盘点日期：2026-09-14。内容仅为非敏感 metadata，不包含请求正文、数据库内容、凭据或 token。

## 主机与容器

- 主机：`VM-0-13-debian`，根分区约 79G，已用约 41G，可用约 38G。
- Docker：21 个容器，19 个运行中，2 个停止的 `caimogu-bot-before-*`。
- NewAPI 实际容器名：`newapi`；挂载 `/opt/newapi/data -> /data`。

## 目标空间

- `/opt/newapi/data/request_snapshots`：约 13,013 个加密 `.snap` 文件，约 10.7GB；只有一个 node 子目录；盘点时未发现打开目录的进程。
- `/opt/newapi/data/one-api.db`、`one-api.db-wal`、`one-api.db-shm` 与快照目录分离，必须保留。
- `/opt/newapi/backups`：当前有 `pre-request-snapshot-clear-20260910T043246Z`（最新，约 389M）和 `cleanup-pre-retention-20260909T034218Z`（约 381M）。
- Docker BuildKit cache 约 99MB 可回收；APT archive cache 约 170MB。
- `/root/.cache` 约 829MB、`/root/.yarn/berry` 约 627MB、`/opt/yesimbot/.tmp` 约 688MB、`/var/log` 约 445MB；均不在本次清理范围。

## 备份根白名单

- `/opt/9router/backups`
- `/opt/9router-data/db/backups`
- `/opt/caimogu-bot.deployments/63e84cd3ad7e/backup`
- `/opt/caimogu-bot.deployments/frontend-928ea622024d/backup`
- `/opt/cliproxyapi-compose/backups`
- `/opt/cmdcode2api/backups`
- `/opt/gemini-web2api/backups`
- `/opt/newapi/backups`
- `/opt/resin/backups`
- `/opt/yesimbot/backups`

每个显式 backup 根作为独立回滚单位，只识别版本化直接子目录；直接文件和未知命名项保留。`/opt/yesimbot/backups` 约 48M，`/opt/newapi/backups` 约 770M。

## 镜像保留规则

已发现旧的 NewAPI、CLIProxyAPI、cmdcode2api、Go/Alpine 等镜像候选；停止的两个 `caimogu-bot-before-*` 容器引用的镜像必须保留。实际执行必须重新通过容器 image ID 建立保护集合，不能依赖此前可能错误的名称/空格匹配统计。

## 既有安全边界

此前同类清理只处理 Docker BuildKit cache、APT archive cache 和明确归属的部署临时文件；明确避免全量 Docker/system/image/volume prune、停止容器、业务数据、备份和全量 `/tmp`。本任务扩展范围后仍保留这些边界，只增加 PRD 明确批准的快照、旧备份和旧未引用镜像规则。
