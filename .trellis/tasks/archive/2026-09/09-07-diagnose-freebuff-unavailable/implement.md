# 实施计划：恢复 VPS HTTP 转换入口

## 实施前置

- 当前任务已获得用户对“恢复 VPS 现有转换层”的明确批准。
- 任务仍处于 planning；完成本文件和 `design.md` 后再执行 `task.py start`。
- 不输出任何密码、UUID、token、完整代理 URL 或 API Key。

## 有序步骤

### 1. 激活任务与记录基线

- [x] 执行 `python ./.trellis/scripts/task.py start diagnose-freebuff-unavailable`。
- [x] 记录 VPS 当前 `sing-box` 版本、监听和服务状态。
- [x] 记录 freebuff 当前状态接口的失败结果，作为红色基线。
- [x] 确认当前 Freebuff 代理池仍是单条全局 `socks5h:` 配置，但不输出其值。

### 2. 候选配置检查

- [x] 只读确认旧 relay 配置与当前 sing-box 协议不一致，不直接启动旧 `vps-static-relay.yaml`。
- [x] 读取当前 sing-box 配置的结构性字段，不输出凭据。
- [x] 在 VPS 临时目录生成不含凭据的候选配置，加入专用 HTTP/mixed 入口。
- [x] 使用 `/usr/bin/sing-box check` 验证候选配置。
- [x] 候选配置通过检查，认证边界复用现有 SOCKS 用户且未回显。

### 3. VPS 最小变更

- [x] 在 VPS 原配置旁创建 mode 600 的时间戳备份。
- [x] 原子替换 sing-box 配置，保留 `2262`、`2263` 和原 outbound。
- [x] 重启 `sing-box.service`。
- [x] 检查 systemd 状态、监听端口和服务日志摘要；不回显敏感字段。
- [x] 确认新 HTTP/mixed 入口只提供预期能力，不形成无认证公网开放代理。

### 4. 连通性验证

- [x] 从 ssh2 主机测试新 HTTP 入口的 HTTPS CONNECT 能力，返回 200。
- [x] 认证匹配；未认证请求未被放行。
- [x] 确认 VPS 原有 `2262` / `2263` 仍在监听。

### 5. 更新 freebuff

- [x] 备份 freebuff 代理配置或通过受保护管理接口更新。
- [x] 将协议改为 `http://`，只在内存/受控管道中处理认证信息。
- [x] 重启 freebuff。
- [x] 验证 `/healthz`、带服务凭据的 `/v1/models` 和 `/v1/freebuff/status`。

### 6. NewAPI 回归

- [x] 从 NewAPI 容器访问 freebuff `/healthz`。
- [x] 已确认现有服务凭据可使 freebuff `/v1/models` 返回 200；NewAPI 容器到 `/v1/models` 的网络边界返回预期 401 而非连接失败。
- [x] 未修改 NewAPI SQLite 数据库、渠道数量或模型映射。
- [x] 不修改 NewAPI SQLite 数据库；若发现必须修改，另开任务。

### 7. 回滚点

- [x] 候选检查已通过；临时文件已清理。
- [x] sing-box 重启后监听正常，mode 600 备份已保留。
- [x] freebuff 验证成功，无需回滚原 `socks5h:` 配置。
- [x] 清理了候选临时文件，未创建额外代理服务。

## 验证命令

```bash
# VPS
systemctl is-active sing-box.service
ss -ltnp
/usr/bin/sing-box check -c <candidate-config>

# Freebuff
curl -fsS http://127.0.0.1:<freebuff-port>/healthz
curl -fsS http://127.0.0.1:<freebuff-port>/v1/freebuff/status

# NewAPI network boundary
# Execute from the NewAPI container without printing service credentials.
```

## 停止条件

- 旧 relay 配置与当前服务协议不兼容。
- 没有可用的 HTTP/mixed runtime。
- 认证信息无法安全复用或无法建立受控访问边界。
- sing-box 配置检查失败。
- VPS 当前配置基线在执行前发生变化。
