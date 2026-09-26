# 技术设计：删除 ssh1 Ollama 和 Nginx

## 1. 删除边界

### 删除

- `ollama.service`、`/etc/systemd/system/ollama.service`。
- `/usr/local/bin/ollama`、`/usr/share/ollama`、`/root/.ollama`。
- `nginx.service` 及 Debian 包 `nginx`、`nginx-common`。
- `/etc/nginx`（包含 sites、SSL 证书/私钥和 snippets）、`/var/log/nginx`、`/var/lib/nginx`、`/usr/lib/nginx`、残留 `/usr/sbin/nginx`。

### 保留

- `natfrp-service` 容器、Natfrp 镜像和 `/etc/natfrp`。
- SSH 服务、SSH 凭据、系统核心目录、Docker/containerd、`/var/lib/docker`。
- 不执行 `apt autoremove`、Docker prune 或根目录 wildcard。

## 2. 执行流程

1. 只读基线：确认主机、服务、包、路径大小、端口、Natfrp 容器和 failed units。
2. 停止/禁用 Ollama 和 Nginx；确认 SSH 和 Natfrp 仍在运行。
3. Purge 精确 Debian 包 `nginx`、`nginx-common`，不处理其它包；确认 package simulation 不会扩展到未批准包。
4. 删除 Ollama 和 Nginx 的精确残留路径。
5. 执行 `systemctl daemon-reload`，断开当前 SSH 后建立新连接。
6. 验证目标路径/包/服务/端口消失，Natfrp、SSH、Docker/containerd 和 failed units 正常。

## 3. 安全约束

- 删除前检查每个目录的真实路径，拒绝空路径、`/`、`/usr`、`/var` 等父目录。
- 仅使用 `apt-get purge -y nginx nginx-common`；先做 `apt-get -s purge` 并检查移除列表只包含这两个包。
- `rm -rf` 只允许用于已登记的完整路径：`/usr/share/ollama`、`/root/.ollama`、`/etc/nginx` 等，不使用 `*`。
- 确认 Natfrp 容器 ID、镜像和 `/etc/natfrp` 在删除前后不变。
- 保留 SSH 连接直到删除完成；任何 SSH、Natfrp 或 Docker 异常都停止后续动作。

## 4. 结果与回滚

Ollama 模型、Ollama 私钥/历史、Nginx SSL 证书和站点配置的删除不可逆；用户已明确授权。APT 包可从软件源重新安装，但本地配置和证书不会自动恢复。若验证发现 SSH/Natfrp/Docker 异常，停止后续动作并报告，不进行猜测性重建。
