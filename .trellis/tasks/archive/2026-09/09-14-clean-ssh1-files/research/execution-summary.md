# ssh1 清理执行结果

执行日期：2026-09-14

## 已执行

- 连接目标：`ssh1`，主机名 `debian`，root 权限。
- `/var/lib/docker` 未执行任何删除、prune、日志截断、卷操作或镜像操作。
- 按精确清单清理了 VS Code Server、未运行应用的构建依赖、Git 元数据、工具元数据、npm/Python/Claude 用户缓存和一个 Mihomo cache DB。
- 保留了 `/opt/mooc/frontend/.env`、`/opt/mooc/backend/.env`、Mooc 数据库和 uploads、`/root/ds2api/.env`；没有删除整个 Mooc 或 ds2api 应用目录。
- `/opt/terraria` 未删除，因为 `terraria-tmodloader.service` 虽当前 inactive，但已 enabled 并引用该目录。

## 释放空间

按删除前 `du/stat` 结果合计约 `5,657,309,184` bytes（约 5.27 GiB，十进制约 5.66 GB）。

主要释放项：

- `/root/.vscode-server`：约 2.88 GiB
- `/home/clawuser/.npm/_cacache`：约 1.08 GiB
- `/opt/mooc/backend/.venv`：约 683 MiB
- `/opt/mooc/frontend/node_modules`：约 247 MiB
- `/root/.cache`：约 177 MiB
- `/home/claude/.cache`：约 95 MiB
- 其它 npm cache、Git 元数据和小型工具缓存：约 93 MiB

## 验证结果

- 新建 SSH 连接成功；主机仍为 `debian`，root 登录正常。
- 根分区从约 38G（9%）降至约 33G（8%）。
- `/var/lib/docker` 盘上报告仍约 3.2G；本任务没有命令指向该路径。
- 清理前后 active systemd service 集合一致。
- 清理前后 enabled unit 集合一致；`terraria-tmodloader.service` 仍为 enabled/inactive，状态未被改变。
- 清理前后 failed unit 集合均为空。
- 清理前后 Docker 容器 ID、名称、镜像和状态集合一致，4 个容器仍为 Up。
- 清理前后监听 socket 集合一致，SSH 22、Nginx 80/443/9200、AstrBot、Ollama、Docker proxy、natfrp 等仍在监听。
- 保留路径和敏感数据检查通过：Docker、AstrBot、MCP、SillyTavern、natfrp、SSH、证书、Docker 配置、Mooc `.env`/数据库/uploads、ds2api `.env` 均存在。
- 所有目标目录/文件均已不存在，缓存父目录保留且为空目录。

## 跳过项目

- `/var/lib/docker` 及其所有内容。
- `/opt/terraria`、`/opt/atrbot`、`/opt/mcp-servers`、`/root/sillytavern-docker`、`/etc/natfrp`。
- SSH、证书、凭据、Docker 配置。
- `/opt/mooc` 和 `/root/ds2api` 中的源代码、配置、数据库、上传和用户数据。
- `/var/cache/apt`、systemd journal 和普通应用日志未处理；当前磁盘占用已降至 8%，没有继续清理的必要。
