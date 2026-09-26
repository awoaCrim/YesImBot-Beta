# 技术设计：恢复 VPS 上的 HTTP 转换入口

## 1. 问题与目标

freebuff 当前保存的是 `socks5h:` 代理，但运行时使用 Undici `ProxyAgent`，只接受 `http:` / `https:`，因此 `/v1/freebuff/status` 返回 500。

VPS 当前状态：

- `/etc/sing-box/config.json` 由 `sing-box 1.13.19` 运行。
- `2262` 是 VLESS/TLS 入站。
- `2263` 是 SOCKS 入站。
- `/opt/vps-proxy-relay/client/vps-static-relay.yaml` 声明 `mixed-port: 7890`，但它依赖旧的 SS `2262` 配置；当前没有对应 Clash/Mihomo/GOST 运行时，也没有 `7890` 监听。
- 当前 `sing-box` 只有 `direct` outbound。

目标是恢复一个可供 freebuff 使用的 HTTP 代理入口，优先复用 VPS 现有运行时和既有配置，不在 `ssh2` 新建一套转换服务。

## 2. 变更边界

### 本次允许修改

- VPS 上 `sing-box` 的代理入口配置，或为兼容的既有 relay 运行方式补齐最小服务配置。
- 必要的 VPS systemd 服务状态。
- freebuff 的全局代理配置，使其使用 `http://` 入口。
- 必要的备份、验证脚本和任务文档。

### 明确不修改

- 不修改 VPS 的 VLESS/TLS `2262` 入站和现有 SOCKS `2263` 入站行为，除非验证证明必须且有独立回滚点。
- 不修改 VPS 的 sing-box 上游凭据、Freebuff 账号、NewAPI 数据库或 NewAPI 渠道。
- 不把密码、UUID、token、完整代理 URL 或 API Key 写入任务文档、日志或聊天。
- 不直接启用已确认协议过时的 `vps-static-relay.yaml`。
- 不安装新的第三方代理运行时，除非发现现有 sing-box 无法安全提供兼容入口且重新确认范围。

## 3. 目标数据流

```text
freebuff container on ssh2
  -> HTTP proxy URL
  -> VPS HTTP/mixed listener (target port 7890 or an explicitly chosen replacement)
  -> existing sing-box direct outbound
  -> Freebuff upstream
```

freebuff 只接收 `http://` / `https://` 代理 URL。VPS 端入口必须提供 HTTP CONNECT/forwarding 能力；纯 SOCKS `2263` 不直接填入 freebuff。

## 4. 分阶段方案

### 阶段 A：只读兼容性门禁

1. 备份前读取并记录非敏感元数据：sing-box 版本、当前监听、入口类型、outbound 类型、旧 relay 配置的端口/协议字段。
2. 使用 `sing-box check` 验证候选配置，不先重启生产服务。
3. 确认候选 HTTP/mixed 入口不会覆盖现有 `2262` / `2263`，且使用明确的认证或网络边界，避免产生公网开放代理。

### 阶段 B：最小恢复

优先使用当前已经安装的 `sing-box` 提供一个专用 HTTP/mixed 入口。候选配置必须：

- 保留原有所有入口和 direct outbound；
- 只新增一个专用监听端口；
- 复用已存在的 SOCKS 用户认证信息时只在受控内存/管道中处理，不回显；
- 写入前创建 mode 600 的 sing-box 配置备份；
- `sing-box check` 通过后再重启服务。

如果现有 sing-box 不能安全支持兼容入口，停止在此门禁处，不盲目启动旧 SS 配置，也不自动安装新代理运行时。

### 阶段 C：freebuff 接入

1. 先从 ssh2/Freebuff 所在网络验证 VPS HTTP 入口可达。
2. 通过现有受保护的 freebuff 配置途径，将代理协议改为 `http://`，保留必要认证但不打印完整 URL。
3. 重启或 reload freebuff，使代理池重新创建。
4. 使用 `/v1/freebuff/status` 作为红绿反馈回路。

### 阶段 D：回归与清理

- 验证 VPS 原有 `2262` / `2263` 仍监听。
- 验证 freebuff `/healthz`、`/v1/models` 和 `/v1/freebuff/status`。
- 验证 NewAPI 容器到 freebuff 的健康路径和模型探测；不修改 NewAPI 数据。
- 删除临时文件、调试输出和临时 systemd 状态；保留必要的 mode 600 回滚备份。

## 5. 回滚设计

- sing-box 候选配置检查失败：不写入、不重启。
- 重启后监听或健康检查失败：恢复最近一次 mode 600 配置备份，重启 sing-box，确认 `2262` / `2263` 恢复。
- freebuff 修改后状态仍失败：恢复原代理配置，重新加载 freebuff；保留 VPS 端变更仅在独立验证成功时。
- 任何认证字段不匹配、配置来源不明确或发现旧配置与当前协议不一致：停止并报告，不猜测凭据或协议。

## 6. 成功标准

- VPS 有可达且受控的 HTTP/mixed 代理入口。
- freebuff 不再把 `socks5h:` 交给 Undici `ProxyAgent`。
- `/v1/freebuff/status` 返回 200。
- 现有 Freebuff 账号、VPS 代理凭据、NewAPI 数据和其他容器未被删除或回显。
