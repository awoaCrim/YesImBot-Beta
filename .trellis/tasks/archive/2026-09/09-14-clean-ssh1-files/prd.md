# 清理 ssh1 服务器文件

## Goal

在不破坏 ssh1 操作系统、SSH 登录、正在运行的服务和 Docker 数据的前提下，清理服务器上明确不再需要的应用目录、用户缓存、临时文件和旧日志，降低无效占用并留下可核查记录。

## Confirmed facts

- 已获得用户授权创建本次 Trellis task，并先进行只读盘点。
- SSH alias `ssh1` 可连接，远端为 Debian GNU/Linux 13（trixie），当前登录用户为 `root`。
- 根分区约 453G，总使用量约 38G（9%），当前不存在紧急磁盘空间压力。
- 主要占用目录：`/usr` 约 19G、`/var` 约 6.7G、`/opt` 约 7.1G、`/root` 约 4.2G、`/home` 约 1.7G。
- `/opt` 下存在 `atrbot`、`terraria`、`mooc`、`mihomo` 等应用目录；`/root` 下存在 `.vscode-server`、`sillytavern-docker` 等目录。
- 当前有 Docker 服务和 4 个运行中的容器；本任务明确不修改 `/var/lib/docker`，也不执行任何 Docker prune、日志截断或卷/镜像清理。
- 发现一个约 556MiB 的 Terraria mod 备份压缩包，以及一个约 742MiB 的 Docker 容器日志文件；Docker 日志属于本任务明确跳过的范围。
- `/var/lib/docker` 约 3.1G，其中容器日志约 1.3G、卷约 1.7G；当前有 4 个运行中的容器，因此不能把整个 Docker 数据目录当作垃圾清空。
- `/root/.vscode-server` 约 2.9G，`/opt/atrbot` 约 2.7G，`/opt/terraria` 约 3.5G，`/opt/mooc` 约 973M，均可能包含代码、运行环境或业务数据。
- `/var/cache/apt` 约 91M、systemd journal 约 84M，属于低风险候选清理对象；`/tmp` 当前几乎没有可回收空间。
- 活跃的 `astrbot.service` 使用 `/opt/atrbot/astrbot`；Docker 容器还绑定使用 `/opt/atrbot/napcat`、`/root/sillytavern-docker` 和 `/etc/natfrp`。这些路径及其运行所需数据必须保留。
- 活跃的 MCP 服务使用 `/opt/mcp-servers`；Ollama、Nginx、SSH、Docker、containerd 等服务保持运行。
- `/opt/terraria` 当前虽然没有 active unit，但发现 `terraria-tmodloader.service` 已 enabled 并在开机目标中引用它，因此 `/opt/terraria` 按服务依赖保留，不纳入本次删除候选。`/opt/mooc`、`/root/ds2api` 仍需在执行前再次检查进程、计划任务、Docker 挂载、配置引用和精确路径。
- 已执行的远程操作仅为只读盘点，没有删除或修改远端文件。

## Scope and requirements

- 用户已确认：除 `/var/lib/docker` 外，可以清理非核心内容；本任务将该授权限定为可清理的应用/用户数据、缓存、临时文件和旧日志。该授权只表示允许评估这些范围，不构成对任何具体目录的无条件删除批准；系统目录、凭据、服务依赖、Docker bind mount、用户数据和用途不明内容始终优先保留。
- **绝不修改** `/var/lib/docker`，也不调用 `docker system prune`、`docker volume prune`、`docker image prune`，不截断 Docker 容器日志。
- 保留操作系统核心目录和系统运行文件：`/etc`、`/usr`、`/bin`、`/sbin`、`/lib*`、`/boot`、`/dev`、`/proc`、`/sys`、`/run` 以及 `/var/lib` 下的系统状态；不执行根目录级清空。
- 保留 SSH、证书、凭据和 Docker 连接配置，包括 `/root/.ssh`、`/root/ssh-credential`、`/root/.acme.sh`、`/root/.docker` 等；不删除未知用途的敏感文件。
- 保留正在运行服务和 Docker 容器使用的宿主机数据，包括 `/opt/atrbot`、`/opt/mcp-servers`、`/root/sillytavern-docker`、`/etc/natfrp`，除非后续发现某个子路径明确是非运行备份且不影响服务。
- 允许清理已通过执行前检查的非活动应用目录、用户缓存、包缓存和临时文件。候选包括 `/opt/mooc`、`/root/ds2api`、旧的 `/root/.vscode-server` 内容，以及明确的 npm/Python/Claude/用户缓存；每一项必须绑定到精确路径。大型应用目录不能仅凭“没有 active systemd unit”删除，必须完成挂载、进程、计划任务、配置引用和敏感文件检查；如果包含数据库、上传、备份、配置、凭据或用途不明内容，则拆分到精确子路径或整体跳过。`/opt/terraria` 因 enabled 的 `terraria-tmodloader.service` 保留。
- 删除前生成不包含敏感内容的路径、大小、类型和判定依据清单，并再次验证排除路径、systemd 工作目录、Docker bind mount 和运行进程引用。
- 不使用 wildcard 猜路径，不对 `/`、`/opt`、`/home`、`/root` 或 `/var` 做未经分类的目录级清空。目录删除仅允许针对已登记、已验证的精确候选路径。
- 旧日志默认不做广泛删除；如执行 journal vacuum，至少保留最近 30 天并保留当前 boot 日志。普通日志必须逐个登记精确路径，不能按年龄批量删除。
- 删除后通过新建 SSH 连接验证磁盘占用、已知 systemd 服务状态、Docker 容器状态和失败单元，并比较清理前后 active unit、failed unit、容器 ID/名称/镜像/状态、监听端口和候选路径引用；记录实际清理量、跳过对象和残留占用。

## Acceptance Criteria

- [x] 形成不包含敏感内容的最终分类盘点：保留、可清理候选、执行时跳过。
- [x] `/var/lib/docker` 及其容器日志、镜像、卷在本任务中未被修改。
- [x] 用户确认的安全边界得到遵守：未删除系统核心文件、SSH/凭据文件或活跃服务所需数据。
- [x] 所有删除动作均绑定到盘点出的精确路径或明确的安全清理命令。
- [x] 清理完成后，SSH 仍可连接，已知服务和 Docker 容器状态正常，且没有新增 failed unit。
- [x] 记录已清理对象、释放空间、跳过对象和仍需后续确认的项目。
