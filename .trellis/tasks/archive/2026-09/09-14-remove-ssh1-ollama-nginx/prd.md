# 删除 ssh1 Ollama 和 Nginx

## Goal

删除 ssh1 宿主机上的 Ollama 和 Nginx 服务、程序、配置、日志、模型/缓存及 SSL 证书，使 Ollama API 和 Nginx 提供的 80/443 网站完全停止；保留 Natfrp、SSH、Docker/containerd 和系统核心文件。

## Confirmed facts

- 用户已允许创建本次 Trellis task，并明确允许删除 Ollama 和 Nginx 的全部相关文件。
- 目标主机是 `ssh1`，远端为 Debian GNU/Linux 13，root 登录。
- Ollama 和 Nginx 是宿主机 systemd 服务，不是 Docker 容器。
- `ollama.service` 当前 enabled/active，ExecStart 为 `/usr/local/bin/ollama serve`，unit 文件为 `/etc/systemd/system/ollama.service`。
- Ollama 相关路径包括 `/usr/local/bin/ollama`、`/usr/share/ollama`、`/root/.ollama`；`/usr/share/ollama/.ollama/models` 和 Ollama 私钥/历史文件属于本次删除范围。
- `nginx.service` 当前 enabled/active，二进制为 `/usr/sbin/nginx`，配置目录为 `/etc/nginx`，日志目录为 `/var/log/nginx`，运行状态目录为 `/var/lib/nginx`，运行库目录为 `/usr/lib/nginx`。
- Nginx 当前有 80/443 监听，并存在站点配置、SSL 证书和私钥；用户已明确允许全部删除，因此相关网站和 HTTPS 将不可用。
- Debian 包模拟结果显示已安装 `nginx` 和 `nginx-common`，`nginx-core` 未安装；可精确 purge 前两个包，不执行 `apt autoremove`。
- 当前 Natfrp 容器 `natfrp-service` 正常运行，镜像为 `ghcr.io/natfrp/launcher`，使用 `/etc/natfrp`，监听 7102；Natfrp 不依赖 Nginx，必须保留。
- SSH、Docker、containerd 和系统核心文件不属于删除范围。
- 当前只读盘点没有修改远端文件。

## Requirements

- 删除前记录 Ollama/Nginx service 状态、精确路径、磁盘占用、监听端口、已安装包和 Natfrp/SSH/Docker 基线。
- 停止并禁用 `ollama.service` 和 `nginx.service`，删除关联 unit/config/binary/data/log/cert 文件。
- Ollama 使用精确路径删除：`/usr/local/bin/ollama`、`/usr/share/ollama`、`/root/.ollama`、`/etc/systemd/system/ollama.service`；不删除其它 `/usr` 内容。
- Nginx 使用精确包和路径删除：purge `nginx`、`nginx-common`（不执行 autoremove），并清理 `/etc/nginx`、`/var/log/nginx`、`/var/lib/nginx`、`/usr/lib/nginx` 及残留 `/usr/sbin/nginx`；SSL 证书和私钥只在 `/etc/nginx` 范围内删除。
- 执行 `systemctl daemon-reload`；不删除 SSH、Natfrp、Docker、containerd、系统包数据库或系统核心目录。
- 删除后通过新 SSH 连接验证：Ollama/Nginx 不再 enabled/active，Ollama 11434、Nginx 80/443 停止；Natfrp 7102、SSH 22、Docker/containerd 保持正常。
- 不使用根目录 wildcard，不执行 `apt autoremove`，不执行 Docker prune，不修改 `/var/lib/docker`。

## Acceptance Criteria

- [x] 形成精确删除清单和保留清单，用户授权范围已记录。
- [x] `ollama.service`、Ollama 程序、模型/缓存、私钥、unit 文件已删除。
- [x] `nginx`/`nginx-common` 包、Nginx 配置、日志、运行目录、SSL 证书和残留二进制已删除。
- [x] 删除后 Natfrp、SSH、Docker、containerd 正常，`/etc/natfrp` 保留。
- [x] 删除后 80/443/11434 停止，7102/22 等保留端口正常，且没有非预期 failed unit。
- [x] 记录释放空间、删除对象、保留对象和不可逆影响。
