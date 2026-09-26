# 执行计划：freebuff-proxy + Caddy

## 前置条件

- [x] 用户确认创建 Trellis 任务并进入规划。
- [x] DNS 已配置并由多个公共解析器验证到 ssh2。
- [x] 已确认 ssh2、Docker、Caddy 容器、配置卷、空闲端口和 Docker 网关。
- [ ] 最终规划摘要经用户明确批准；批准前不执行 `task.py start` 和远程写操作。

## 执行步骤

### 1. 远程预检

- 通过 `ssh2` 重新检查 DNS、8787 空闲、`/opt/freebuff-proxy` 不存在或无用户改动、Caddyfile 路径和 `cpm_cpm-net` 网关。
- 记录 Caddyfile 校验前的 hash、Caddy 容器 ID 和当前站点数量。
- 不读取任何 `.env`、凭据文件、SSH 密钥或现有应用敏感配置。

### 2. 部署应用

- 创建 `/opt/freebuff-proxy` 并浅克隆上游仓库。
- 生成仅包含非敏感默认项的 `.env`：`PORT=8787`、`ADMIN_USERNAME=admin`、`TZ=Asia/Shanghai`；不设置管理员密码。
- 运行 `docker compose config --quiet`。
- 运行 `docker compose pull`，记录实际镜像 ID但不把任何日志中的密码带回聊天。
- 运行 `docker compose up -d`，确认 `freebuff-proxy` 为 `running` 且重启策略为 `unless-stopped`。
- 确认 `data/` 存在、属主/权限可供容器使用。

### 3. 应用验证

- 从 ssh2 本机请求 `http://127.0.0.1:8787/healthz`，等待服务启动完成后确认成功响应。
- 使用非敏感的容器状态、端口和 HTTP 状态进行诊断；不读取首次启动日志中的随机管理员密码。

### 4. Caddy 配置

- 将 `/var/lib/docker/volumes/cpm_caddy-config/_data/Caddyfile` 复制为带时间戳的备份。
- 追加 `freebuff.uwoacrimson.com` 站点块，upstream 为当前已验证的 `172.23.0.1:8787`。
- 在 `caddy_proxy` 容器内执行 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`。
- 仅在验证通过后执行 `caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`。
- 不停止、不重建 `caddy_proxy`，不改变其他站点配置。

### 5. 入口验证

- 在 ssh2 上以 SNI/Host 为 `freebuff.uwoacrimson.com` 检查 HTTPS 连接和证书域名。
- 检查 `https://freebuff.uwoacrimson.com/healthz` 和首页登录页返回成功状态/预期 HTML。
- 确认 Caddy 容器仍运行，现有站点配置块仍在，freebuff upstream 可连通。
- 如验证失败，按设计中的 Caddy 回滚步骤恢复备份，再重新校验和 reload。

### 6. 交付说明

- 告知用户部署目录、访问域名、健康检查结果、Caddy 备份路径和升级方式。
- 告知用户首次管理员密码需要在 ssh2 上自行查看首次启动日志，并建议登录后立即改密；不要在最终回复中输出密码。
- 明确 Freebuff 账号授权、代理池、真实上游对话尚未配置/验证。
- 记录 8787 可能直接暴露的风险；不在本任务中擅改防火墙。

## 验证命令

```bash
ssh ssh2 'cd /opt/freebuff-proxy && docker compose config --quiet'
ssh ssh2 'cd /opt/freebuff-proxy && docker compose ps'
ssh ssh2 'curl -fsS http://127.0.0.1:8787/healthz'
ssh ssh2 'docker exec caddy_proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'
ssh ssh2 'curl -fsS --resolve freebuff.uwoacrimson.com:443:127.0.0.1 https://freebuff.uwoacrimson.com/healthz'
ssh ssh2 'curl -fsS --resolve freebuff.uwoacrimson.com:443:127.0.0.1 https://freebuff.uwoacrimson.com/ | grep -E "<title>|登录|Freebuff"'
```

## 风险点与回滚点

- `docker compose pull` 可能拉取上游 `latest` 的新内容；以部署时记录的镜像 ID作为基线。
- Caddyfile 追加前必须有时间戳备份；任何 validate 失败都不得 reload。
- 应用失败时保留 `data/`，不使用 `docker compose down -v`，不删除数据。
- 入口失败时先恢复 Caddyfile，不修改其他站点或重建 `caddy_proxy`。
- 不在任务文件、shell 历史可见输出或最终回复中写入管理员密码、Freebuff 凭据或代理凭据。
