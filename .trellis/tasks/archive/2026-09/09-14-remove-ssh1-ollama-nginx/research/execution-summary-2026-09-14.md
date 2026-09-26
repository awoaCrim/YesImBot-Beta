# ssh1 Ollama/Nginx 删除结果

执行日期：2026-09-14

## 已删除

### Ollama

- 停止并禁用 `ollama.service`。
- 精确删除 `/usr/local/bin/ollama`、`/usr/share/ollama`、`/root/.ollama` 和 `/etc/systemd/system/ollama.service`。
- Ollama 模型目录、缓存、历史和 Ollama 私钥一并删除。
- 11434 端口已停止。

### Nginx

- 停止并禁用 `nginx.service`。
- 精确 purge Debian 包 `nginx`、`nginx-common`；没有执行 `apt autoremove`，`nginx-core` 原本也未安装。
- 删除 `/etc/nginx`、`/var/log/nginx`、`/var/lib/nginx`、`/usr/sbin/nginx` 以及其它存在的 Nginx 残留路径。
- Nginx 站点配置、SSL 证书和私钥一并删除。
- 80/443 端口已停止。

## 保留

- `natfrp-service` 容器仍为 running，容器 ID 未变，仍使用 `ghcr.io/natfrp/launcher`，bind mount 仍为 `/etc/natfrp -> /run`。
- `ghcr.io/natfrp/launcher` 镜像和 `/etc/natfrp` 保留。
- 7102 端口仍监听。
- SSH、22 端口、Docker、containerd 和 `/var/lib/docker` 保留。
- `systemctl --failed` 为空。

## 验证

- 新建 SSH 连接成功；主机仍为 `debian`，root 登录正常。
- `ollama.service`、`nginx.service` 均为 `not-found/inactive`。
- `nginx`、`nginx-common`、`nginx-core` 均不再安装。
- Ollama/Nginx 所有登记路径均不存在。
- 11434、80、443 不再监听；22 和 7102 正常监听。
- Docker 仅保留 Natfrp 容器，Natfrp 状态为 Up。
- Docker/containerd/SSH 仍 active，failed units 为空。
- 根分区仍约 20G（5%）；本次额外释放约 40MiB 级别空间，因磁盘显示取整比例未变化。

## 不可逆影响

Ollama 模型、私钥/历史、Nginx 站点配置、SSL 证书和私钥已永久删除；未来恢复需要重新安装软件并从外部来源恢复配置/证书。
