# 部署 freebuff-proxy 到 ssh2 并配置 Caddy

## Goal

在 `ssh2` 上部署 `HengXin666/freebuff-proxy` 的上游 Docker Compose 版本，并接入现有 Caddy 反向代理，使 Web 控制台通过 `https://freebuff.uwoacrimson.com/` 访问，同时保留应用数据和可回滚能力。

## Confirmed facts

- 目标主机 `ssh2` 可通过当前 SSH 配置访问，当前登录身份为 `root`。
- `ssh2` 为 Debian 12，已安装 Docker 26.1.3 和 Docker Compose v2.27.1。
- 目标机已有 Docker 容器 `caddy_proxy` 使用 `caddy:2`，占用宿主机 80/443；systemd 的独立 Caddy 服务未启用。
- `ssh2` 的 8787 端口当前没有监听，`/opt/freebuff-proxy` 尚不存在。
- 现有 Caddy 配置使用 `uwoacrimson.com` 下的多个子域名；`freebuff.uwoacrimson.com` 未出现在现有 Caddy 配置中。
- 用户已完成 DNS 配置；从 Cloudflare、Google、Quad9 公共 DNS 查询时，`freebuff.uwoacrimson.com` 均解析到与现有站点相同的 ssh2 地址。
- `caddy_proxy` 的配置卷映射到 `/var/lib/docker/volumes/cpm_caddy-config/_data`，其 Caddyfile 位于该卷的 `Caddyfile`；`cpm_cpm-net` 的宿主机网关为 `172.23.0.1`，可作为 Caddy 容器访问 host-network 应用的上游地址。
- 上游 Compose 使用 GHCR 预构建镜像 `ghcr.io/hengxin666/freebuff-proxy:latest`，默认 `host` 网络、端口 8787，数据持久化在部署目录的 `data/`，并提供 `/healthz` 检查端点。
- 上游未设置 `ADMIN_PASSWORD` 时会在首次启动日志中生成并打印随机管理员密码；密码不写入本任务文档，也不通过聊天输出。

## Requirements

- R1：在 `/opt/freebuff-proxy` 使用上游 Compose 部署 freebuff-proxy，默认监听 `0.0.0.0:8787`，容器设置为自动重启，数据落盘并可按上游方式升级。
- R2：使用上游 GHCR 镜像和 Compose 配置，不修改应用源码，不在仓库或任务文件中保存管理员密码、代理凭据或 Freebuff 账号凭据。
- R3：在现有 Caddyfile 中新增一个独立的 `freebuff.uwoacrimson.com` 站点，将请求反代到 `172.23.0.1:8787`，并保留原有站点配置不变。
- R4：修改 Caddy 配置前创建带时间戳的备份；配置校验失败或服务异常时可恢复原配置和容器状态。
- R5：完成部署后验证容器运行状态、应用本机 `/healthz`、经 Caddy 访问的 HTTPS、证书签发和 Web 登录页可用。
- R6：向用户说明首次管理员密码只能从 ssh2 上的首次启动日志安全获取，并给出后续修改密码的操作方式；不在聊天中回显密码。

## Acceptance Criteria

- [ ] `/opt/freebuff-proxy` 存在上游仓库和 Compose 文件；`freebuff-proxy` 容器处于 `running`，重启策略为 `unless-stopped`，`data/` 已创建并可写。
- [ ] ssh2 本机访问 `http://127.0.0.1:8787/healthz` 返回成功响应。
- [ ] `freebuff.uwoacrimson.com` 解析到 ssh2，Caddy 配置校验通过，Caddy 重新加载成功且原有 Caddy 容器保持运行。
- [ ] 通过 `https://freebuff.uwoacrimson.com/` 可建立 HTTPS 连接并显示 freebuff-proxy 登录页。
- [ ] Caddyfile 备份存在；失败时可按执行计划中的步骤恢复配置并重新加载 Caddy。
- [ ] 未执行 Freebuff 账号授权、代理池配置或真实上游对话测试；这些需要用户在控制台完成，除非用户另行要求。

## Out of scope

- 不修改 freebuff-proxy 源码或上游仓库。
- 不读取、复制或在聊天中输出 SSH 私钥、管理员密码、Freebuff 凭据、API Key、代理认证信息等敏感内容。
- 不重构现有 Caddy 配置，不迁移其他站点，不修改现有业务容器。
- 不代替用户完成 Freebuff 浏览器授权、账号导入或代理池配置。

## Key decisions and risks

- 使用上游推荐的 `host` 网络模式，以保持其对宿主机本地代理的兼容性；该模式不使用 Docker 端口映射，应用直接监听宿主机 8787。
- Caddy 继续使用现有容器和配置卷，只追加一个站点并执行 graceful reload，不停止或重建现有 Caddy 容器。
- `latest` 是上游可变镜像标签；部署时记录实际拉取的镜像 ID，后续升级仍按上游的 `git pull && docker compose pull && docker compose up -d` 执行。
- 应用按上游配置监听 `0.0.0.0:8787`，因此除了 Caddy 入口外，8787 是否对公网开放取决于 ssh2 的云防火墙/主机防火墙；本任务不改动现有防火墙规则，部署后记录该风险。

## Open questions

无。DNS、部署域名和反代目标均已确认，可进入最终规划审阅。
