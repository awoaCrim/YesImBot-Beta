# 删除 ssh1 容器及应用数据

## Goal

根据用户最新授权，删除 ssh1 上除 Natfrp 外的容器、应用目录和相关服务配置，同时保留 Natfrp、SSH 登录、系统核心文件、证书/凭据以及与删除目标无关的 Nginx 配置，避免留下自动重启或失效服务。

## Confirmed facts

- 用户已允许创建本次 Trellis task，并明确了实际删除范围。
- 目标 SSH alias 为 `ssh1`，远端主机为 Debian GNU/Linux 13，root 登录。
- 当前有 5 个 Docker 容器：运行中的 `napcat`、`sillytavern`、`natfrp-service`、`metacubexd`，以及已退出的 `mihomo`。
- 用户明确要求保留 `natfrp-service` 容器、Natfrp 镜像和 `/etc/natfrp` 数据；其它当前容器和相关数据可删除。
- `napcat` 使用两个 named volumes：`3329d80d19919fea5f925f06b248dabc1542550728233c41208e8836fc2f8920`（约 6KiB）和 `fb7438f5007b4c96fd30eb826d6d86ea87095953c8d917f37ca7fc258dc402a9`（约 486MiB）。
- 当前还有两个未被容器链接的 Docker volumes：`c21f6494811e298c37280a2e6b33cd6fa575ecfa8b51879a213b69956e665a70`（约 1.301GiB）和 `1c06b90226ee62ea0693bba98dae07ef59ca2185357f19947fe9fc9b130c76bd`（约 873B）；用户明确要求一并删除。
- 删除目标的容器镜像为 NapCat、SillyTavern、Mihomo、Metacubexd；Natfrp 镜像保留。
- 删除目标的宿主机数据包括 `/opt/atrbot`、`/opt/terraria`、`/opt/mcp-servers`、`/root/sillytavern-docker` 和 `/opt/mihomo`；用户明确表示这些目录可以删除。
- `/opt/atrbot` 当前由 `astrbot.service` 使用；`/opt/mcp-servers` 当前由 `mcp-fetch.service` 和 `mcp-sequential-thinking.service` 使用；`/opt/terraria` 被 enabled 的 `terraria-tmodloader.service` 引用。删除目录前必须停止、禁用并移除这些关联 unit 及其启用链接，随后执行 `daemon-reload`。
- `/etc/natfrp` 被 Natfrp 容器 bind mount 使用，必须保留；Natfrp 服务和端口也必须保持正常。
- Nginx 配置中 `mcp.xxkcrimson.cn`/`mcp` 指向 MCP 端口 9100/9101；`xxkcrimson.cn` 中只有 `st.xxkcrimson.cn` 指向即将删除的 SillyTavern 8000，`bs.xxkcrimson.cn` 和 `api.xxkcrimson.cn` 指向其它端口，不能整体删除整个配置文件。
- SSH、证书、凭据、系统目录、Nginx 其它业务配置、Ollama、Natfrp、Docker/containerd 和 SSH 本身不属于删除目标。

## Requirements

- 先执行当前只读基线，记录容器 ID/名称/镜像/状态、目标 volumes、bind mounts、宿主机目录、关联 systemd units、Nginx 引用、关键端口和 failed units。
- 删除 Docker 资源时只使用精确的容器、镜像和 volume 名称；不使用 `docker system prune -af --volumes`，不删除或清空整个 `/var/lib/docker`。
- 删除顺序：停止并禁用关联 systemd units → 停止并删除 4 个非 Natfrp 容器 → 删除对应镜像和 4 个明确 volumes → 删除已批准的宿主机目录 → 删除 MCP Nginx 配置和 SillyTavern 对应的单个 server block → reload/validate Nginx。
- 删除 `astrbot.service`、MCP 两个 service 和 Terraria service 的 unit 文件/启用链接前必须记录精确路径；不触碰 Natfrp、SSH、Docker、containerd、Ollama 等保留服务。
- 删除 Nginx 配置时只删除与已删除服务对应的精确文件或 server block；保留证书文件和 `bs`/`api` 等无关 server block。
- 保留 `/etc/natfrp`、Natfrp 容器、Natfrp 镜像及其 7102 监听；保留 SSH、证书、凭据、系统核心目录。
- 删除前后均通过新的 SSH 连接验证：SSH、Natfrp、Nginx、Ollama、Docker/containerd 状态、关键端口、failed units、剩余容器/镜像/volumes 和已删除路径。
- 所有远程删除动作绑定到本 PRD 列出的当前精确资源；不使用根目录 wildcard 或未登记路径。

## Acceptance Criteria

- [x] 形成当前状态的精确删除和保留清单，用户范围已记录。
- [x] `napcat`、`sillytavern`、`mihomo`、`metacubexd` 容器及其对应镜像被删除；`natfrp-service` 和 Natfrp 镜像保留。
- [x] 两个 NapCat volumes 和两个未链接 volumes 被删除；其它未批准 volumes 不受影响。
- [x] `/opt/atrbot`、`/opt/terraria`、`/opt/mcp-servers`、`/root/sillytavern-docker`、`/opt/mihomo` 被删除；`/etc/natfrp` 保留。
- [x] 关联 systemd units 已停止/禁用/移除，不产生失效自动启动项；Nginx 仅移除已删除服务的配置引用。
- [x] 删除后新 SSH 连接成功，Natfrp、SSH、Nginx、Ollama、Docker/containerd 状态符合预期，且没有非预期 failed unit。
- [x] 记录删除对象、释放空间、保留对象、停止的端口和不可逆影响。
