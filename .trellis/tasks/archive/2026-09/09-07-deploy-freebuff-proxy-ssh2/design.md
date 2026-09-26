# 技术设计：freebuff-proxy + Caddy

## 1. 边界与组件

### 应用边界

- 部署对象：上游 `HengXin666/freebuff-proxy` GHCR 镜像。
- 运行目录：`/opt/freebuff-proxy`。
- 运行容器：`freebuff-proxy`，由上游 `docker-compose.yml` 管理。
- 网络：保持上游 `network_mode: host`，应用监听宿主机 `0.0.0.0:8787`。
- 数据：`/opt/freebuff-proxy/data/` 映射到容器 `/data`，不随容器删除。

### 入口边界

- 现有 `caddy_proxy` 继续负责 80/443 和其他站点。
- 现有 Caddyfile 只追加一个站点块：

```caddyfile
freebuff.uwoacrimson.com {
    reverse_proxy 172.23.0.1:8787
}
```

- `172.23.0.1` 是当前 `cpm_cpm-net` 的 Docker 宿主机网关；部署后必须用健康检查验证 Caddy 容器到该地址的实际连通性。
- 不修改 Caddy 容器的网络、镜像、挂载和其他站点；只编辑其配置卷中的 Caddyfile 并 graceful reload。

## 2. 请求数据流

```text
浏览器
  │ HTTPS :443 / HTTP :80
  ▼
caddy_proxy
  │ reverse_proxy 172.23.0.1:8787
  ▼
Docker 宿主机网关
  │ host-network 访问宿主机 :8787
  ▼
freebuff-proxy 容器
  │ HTTP /healthz、Web 控制台、OpenAI 兼容 API
  ▼
Freebuff 上游（仅在用户后续添加账号后使用）
```

TLS 在 Caddy 终止，Caddy 到应用使用本机 Docker 网段上的 HTTP；应用不需要知道公网域名。

## 3. 配置与数据合同

- 域名合同：`freebuff.uwoacrimson.com` 已由用户配置 DNS，解析到 ssh2。
- 应用端口合同：`8787` 当前空闲；Compose 默认值保持不变。
- 健康合同：`GET http://127.0.0.1:8787/healthz` 应成功；经 Caddy 访问同一路径也应成功。
- 管理员合同：不设置 `ADMIN_PASSWORD`，让上游在首次启动日志中生成随机密码；不在代理会话、任务文档或最终回复中回显。
- 数据合同：不删除 `data/`；Caddy 配置修改前保存备份。

## 4. 部署顺序

1. 重新验证 DNS、8787 空闲、Caddyfile 路径、Docker 网关和部署目录不存在。
2. 在 `/opt/freebuff-proxy` 浅克隆上游仓库，复制/生成不含密码的 `.env`，执行 `docker compose config --quiet`。
3. 拉取 GHCR 镜像并启动 `freebuff-proxy`。
4. 等待容器健康并用本机 `/healthz` 验证应用。
5. 复制 Caddyfile 到带时间戳的备份文件。
6. 追加 freebuff 站点块；用容器内 `caddy validate` 验证；成功后用 `caddy reload` 应用配置。
7. 验证 `https://freebuff.uwoacrimson.com/`、`/healthz`、登录页和原有 Caddy 容器状态。
8. 记录实际镜像 ID、部署目录、Caddy 备份路径和回滚命令；不读取管理员密码日志。

## 5. 回滚设计

### Caddy 回滚

- 只在新配置验证失败或域名入口异常时执行。
- 用部署前的时间戳备份覆盖当前 Caddyfile。
- 重新执行容器内 `caddy validate`，通过后 `caddy reload`。
- 验证原有站点容器仍处于运行状态。

### 应用回滚

- 如果首次启动失败：先保留 `/opt/freebuff-proxy/data/`，收集容器状态和非敏感错误信息，执行 `docker compose down`，不删除数据目录。
- 如果 Caddy 成功、应用异常：先恢复 Caddy 备份，再处理应用容器；避免把入口故障和应用故障混在一起。
- 本次没有旧版 freebuff-proxy，因此不执行镜像降级；后续升级需先记录当前镜像 ID。

## 6. 兼容性与风险

- 使用 `host` 网络保持上游对宿主机本地代理的兼容性；host 模式下不添加 `ports`。
- 使用 `latest` 镜像符合上游 Compose 默认部署，但可变标签降低可复现性；部署后记录 digest/镜像 ID作为当前基线。
- 应用会监听 `0.0.0.0:8787`，本次不调整防火墙。若公网扫描显示 8787 暴露，后续单独安排防火墙或网络隔离任务，避免在本次部署中修改 ssh2 上其他服务的网络策略。
- Caddy upstream 使用当前 Docker 网络网关，网络被重建后地址可能变化；若未来变更 `cpm_cpm-net`，需重新检查并更新站点块。
