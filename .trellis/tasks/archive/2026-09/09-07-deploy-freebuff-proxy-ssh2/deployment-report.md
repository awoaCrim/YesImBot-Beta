# 部署结果：freebuff-proxy / ssh2

执行日期：2026-09-06

## 已完成

- 目标主机：`ssh2`（Debian 12）。
- 部署目录：`/opt/freebuff-proxy`。
- 上游仓库：`HengXin666/freebuff-proxy`，浅克隆提交：`93ef6bd36491b19f7ac8461bb3423b141f5d9743`。
- 使用上游 GHCR 镜像：`ghcr.io/hengxin666/freebuff-proxy:latest`。
- 部署时实际镜像 ID：`sha256:4d2cf44a0ca7da4fecaf4f78d29627264f95e8d75acce5e8c3028f7ee885d6c2`。
- Compose 配置校验：通过。
- 容器：`freebuff-proxy`，状态 `running`，重启策略 `unless-stopped`。
- 数据目录：`/opt/freebuff-proxy/data/` 已创建且可写。
- Caddyfile 备份：`/var/lib/docker/volumes/cpm_caddy-config/_data/Caddyfile.bak.20260906T180307Z`。
- 仅追加批准的 `freebuff.uwoacrimson.com` 站点，upstream 为 `172.23.0.1:8787`；追加结果与备份内容逐字校验通过。
- Caddy `validate`：通过；已执行 graceful `reload`。
- 现有 `caddy_proxy` 容器 ID：`7c38ce0d24ad562fb558456d987571c2c92db1ed329927df11dddf272e6c411d`，仍为 `running`，未停止或重建。

## 验证结果

- `http://127.0.0.1:8787/healthz`：HTTP `200`。
- `https://freebuff.uwoacrimson.com/healthz`（SNI/Host 指向本机）：HTTP `200`。
- 首页：HTTP `200`，检测到登录页标记。
- 证书 SAN：包含 `freebuff.uwoacrimson.com`；签发者为 Let's Encrypt。
- DNS：`freebuff.uwoacrimson.com` 解析到 `43.131.249.217`。

## 独立最终复核

主会话再次执行了只读验收：

- 公共 DNS `1.1.1.1` 返回 `43.131.249.217`。
- Compose 配置、容器 `running`、`unless-stopped`、本机 `/healthz` 和 Caddy `validate` 均通过。
- 通过 SNI `freebuff.uwoacrimson.com` 访问首页返回 HTTP 200，登录页标记存在。
- 证书由 Let's Encrypt 签发，SAN 包含 `freebuff.uwoacrimson.com`。
- Caddyfile 备份存在且非空，`caddy_proxy` 仍为 `running`。

## 安全与未执行事项

- 未读取或输出首次启动密码日志；未设置或记录管理员密码。
- 未执行 Freebuff 账号授权、代理池配置或真实上游对话测试。
- 未修改防火墙规则、应用源码或现有 Caddy 站点。

## 回滚

Caddy 回滚：用上述备份覆盖当前 Caddyfile，先执行容器内 `caddy validate`，通过后执行 `caddy reload`。应用失败时执行 `cd /opt/freebuff-proxy && docker compose down`，保留 `data/`，不使用 `down -v`。

## 剩余风险

- 上游使用可变的 `latest` 标签；后续升级前应重新记录镜像 ID。
- host network 使应用监听宿主机 `0.0.0.0:8787`；本次未修改防火墙，8787 是否可从公网访问取决于 ssh2 现有网络策略。
- Caddy upstream 使用 `cpm_cpm-net` 当前网关 `172.23.0.1`；网络重建后需重新确认网关地址。
