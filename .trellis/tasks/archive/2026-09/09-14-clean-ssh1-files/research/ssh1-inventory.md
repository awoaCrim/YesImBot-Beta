# ssh1 只读盘点记录

盘点时间：2026-09-14（本地任务日期）

## 主机

- SSH alias：`ssh1`
- OS：Debian GNU/Linux 13 (trixie)
- 登录用户：`root`
- 根分区：约 453G，总使用量约 38G（9%）

## 主要占用

| 路径 | 约占用 | 当前处理判断 |
|---|---:|---|
| `/usr` | 19G | 系统目录，保留 |
| `/var` | 6.7G | 仅按子项分类，保留系统状态 |
| `/opt` | 7.1G | 按应用和运行依赖分类 |
| `/root` | 4.2G | 按凭据、运行环境、缓存和应用数据分类 |
| `/home` | 1.7G | 按用户数据和缓存分类 |
| `/var/lib/docker` | 3.1G | 本任务完全跳过 |

## 已发现的活跃依赖

- `astrbot.service` 使用 `/opt/atrbot/astrbot`。
- Docker 容器 bind mount 使用 `/opt/atrbot/napcat`、`/root/sillytavern-docker` 和 `/etc/natfrp`。
- `mcp-fetch.service`、`mcp-sequential-thinking.service` 使用 `/opt/mcp-servers`。
- Docker、containerd、Nginx、Ollama、SSH 等服务处于 active 状态。

## 主要候选

以下仅为执行前候选，不代表已删除：

- `/opt/terraria`：约 3.5G；虽然当前未 active，但 `terraria-tmodloader.service` 已 enabled 并在开机目标中引用，按服务依赖保留。
- `/opt/mooc`：约 973M；当前未发现对应 active systemd unit，仍需确认无 enabled unit、计划任务、进程引用和 Docker 挂载。
- `/root/ds2api`：约 44M；当前未发现对应 active systemd unit，执行前需确认无进程引用和 Docker 挂载。
- `/root/.vscode-server`：约 2.9G；执行前需确认没有活跃 VS Code Server 进程；删除后远程开发环境需要重新安装。
- `/var/cache/apt`：约 91M；可使用 `apt-get clean`。
- systemd journal：约 84M；只保留近期日志后再 vacuum。
- 用户和工具缓存：`/root/.cache`、`/root/.npm/_cacache`、`/home/claude/.cache`、`/home/clawuser/.npm/_cacache` 等，仅清理明确的缓存子目录。

## 明确保留

- `/var/lib/docker` 及其所有子路径。
- `/opt/atrbot`、`/opt/mcp-servers`、`/root/sillytavern-docker`、`/etc/natfrp` 及其运行所需子路径。
- `/root/.ssh`、`/root/ssh-credential`、`/root/.acme.sh`、`/root/.docker` 等 SSH、证书和凭据相关路径。
- `/etc`、`/usr`、`/bin`、`/sbin`、`/lib*`、`/boot`、`/dev`、`/proc`、`/sys`、`/run` 和系统状态目录。

## 风险说明

- 仅凭目录大小不能判断应用数据是否可删除；因此执行阶段必须重新生成精确清单。
- `sillytavern-docker` 虽然在 `/root` 下，但被运行中的 Docker 容器直接使用，不能按普通用户目录清理。
- `/opt/atrbot` 虽然包含备份和代码仓库，但服务和容器均依赖它，不能整体删除。
- Docker 的大日志、镜像和卷均不在本任务清理范围内。
