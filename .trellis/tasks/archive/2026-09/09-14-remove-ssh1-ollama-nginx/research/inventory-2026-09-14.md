# ssh1 Ollama/Nginx 删除前盘点

## 主机与服务

- 主机：`debian`，Debian GNU/Linux 13，root
- `ollama.service`：enabled/active，ExecStart `/usr/local/bin/ollama serve`
- `nginx.service`：enabled/active，二进制 `/usr/sbin/nginx`
- Natfrp Docker：`natfrp-service` running，镜像 `ghcr.io/natfrp/launcher`，`/etc/natfrp` bind mount，7102 监听

## Ollama 目标

- `/usr/local/bin/ollama`
- `/usr/share/ollama`（含 `.ollama/models`、缓存和 Ollama 私钥）
- `/root/.ollama`（历史、Ollama 私钥）
- `/etc/systemd/system/ollama.service`
- 11434 当前由 Ollama 监听

## Nginx 目标

- Debian 包：`nginx`、`nginx-common`；`nginx-core` 未安装
- `/etc/nginx`
- `/var/log/nginx`
- `/var/lib/nginx`
- `/usr/lib/nginx`
- `/usr/sbin/nginx`
- `/etc/nginx/ssl` 下的 Nginx 证书/私钥
- 80/443 当前由 Nginx 监听

## 保留

- SSH 服务、22 端口、SSH 凭据
- Natfrp 容器、镜像、`/etc/natfrp`、7102 端口
- Docker、containerd、`/var/lib/docker`
- 其它系统核心目录和包数据库

## 不可逆影响

- Ollama API、模型和 Ollama 私钥/历史消失。
- Nginx 反向代理、站点配置、SSL 证书和 80/443 消失。
- apt purge 不会自动执行 autoremove；若未来恢复，需要重新安装软件并从外部恢复配置/证书。
