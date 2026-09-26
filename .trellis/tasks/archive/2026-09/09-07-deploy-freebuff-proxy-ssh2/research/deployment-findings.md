# freebuff-proxy / ssh2 部署研究

## 结论

采用“上游 Compose + host network + 现有 Caddy 容器追加站点”的最小方案，不改应用源码，不重建现有 Caddy。部署目录为 `/opt/freebuff-proxy`，应用默认监听宿主机 `8787`，Caddy 通过 `cpm_cpm-net` 的宿主机网关 `172.23.0.1:8787` 访问它。

## 上游项目证据

来源：HengXin666/freebuff-proxy GitHub 仓库及当前默认分支内容。

- `docker-compose.yml` 使用 `ghcr.io/hengxin666/freebuff-proxy:latest`。
- Compose 使用 `network_mode: host`，通过 `PORT`/`FREEBUFF_PROXY_PORT` 默认监听宿主机 `8787`，不使用 `ports` 映射。
- `./data` 挂载到容器 `/data`，用于配置、用户、会话和账号凭据持久化。
- 未设置 `ADMIN_PASSWORD` 时，首次启动会在日志中打印随机管理员密码；本次不读取或回显该密码。
- 应用提供 `GET /healthz`，可用于部署后健康检查。
- 上游文档给出的升级方式是 `git pull && docker compose pull && docker compose up -d`。

来源：
- https://github.com/HengXin666/freebuff-proxy
- https://raw.githubusercontent.com/HengXin666/freebuff-proxy/main/docker-compose.yml
- https://raw.githubusercontent.com/HengXin666/freebuff-proxy/main/README.md

## 目标主机证据

通过只读 SSH 检查确认：

- `ssh2` 为 Debian 12；Docker 26.1.3；Docker Compose v2.27.1。
- `caddy_proxy` 容器使用 `caddy:2`，负责宿主机 80/443；systemd 独立 Caddy 服务未启用。
- Caddy 配置卷为 `cpm_caddy-config`，宿主路径为 `/var/lib/docker/volumes/cpm_caddy-config/_data`。
- Caddyfile 现有站点中没有 `freebuff.uwoacrimson.com`。
- `cpm_cpm-net` 中 `caddy_proxy` 的地址为 `172.23.0.3`，宿主机网关为 `172.23.0.1`；该网关可从 Caddy 容器访问宿主机服务。部署后仍需以 `/healthz` 做实际连通性验证。
- ssh2 的 8787 端口空闲，`/opt/freebuff-proxy` 不存在。
- 用户完成 DNS 配置后，`freebuff.uwoacrimson.com` 通过 Cloudflare、Google、Quad9 公共 DNS 均解析到与现有站点相同的 ssh2 地址。

## Caddy 方案与验证

- Caddy `reverse_proxy` 支持 `host:port` 形式的静态 HTTP upstream，因此站点块使用 `reverse_proxy 172.23.0.1:8787`。
- Caddy 对公开域名自动申请和续期 HTTPS 证书，并默认将 HTTP 重定向到 HTTPS；前提是 A/AAAA 指向服务器、80/443 可达、域名出现在配置中。
- 修改 Caddyfile 前先创建带时间戳备份，然后执行容器内的 `caddy validate`；验证通过后执行 `caddy reload`，不停止现有 Caddy 容器。
- 回滚时恢复备份并再次执行 `caddy reload`。Caddy 官方文档说明 reload 是生产环境修改配置的无停机方式，加载失败时保留原配置。

来源：
- https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- https://caddyserver.com/docs/automatic-https
- https://caddyserver.com/docs/command-line
- https://docs.docker.com/engine/network/drivers/host/

## 风险与取舍

- 上游 host network 会让应用直接监听宿主机 `0.0.0.0:8787`；这与上游对宿主机本地代理的兼容目标一致，但 8787 是否能被公网直接访问取决于现有云防火墙/主机防火墙。本次不擅自改动防火墙规则，部署后记录该风险。
- `latest` 是可变镜像标签。部署时记录实际镜像 ID，后续如需升级再按上游流程更新；本次不自行 pin 到未经用户要求的版本。
- Caddy upstream 使用现有 Docker 网络网关 `172.23.0.1`，避免修改或重建现有 Caddy Compose；如果未来重建该网络，需重新检查网关地址。
