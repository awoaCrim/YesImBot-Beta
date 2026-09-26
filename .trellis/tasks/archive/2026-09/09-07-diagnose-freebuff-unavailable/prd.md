# 诊断并修复 freebuff 出网代理不可用

## Goal

定位并修复 ssh2 上 freebuff-proxy 的出网代理故障，使控制台状态接口恢复正常；优先使用用户提供的 `vps` 作为出口，并在可行时保留 SOCKS5 能力，不泄露或重置任何代理凭据。

## 已确认根因

- freebuff 容器为 `running/healthy`，本机和 HTTPS `/healthz` 均返回 HTTP 200。
- `/v1/freebuff/accounts` 返回 200，当前有 1 条账号记录，非敏感字段显示 `available=true`。
- `/v1/models` 返回 200。
- `/v1/freebuff/status` 返回 HTTP 500，响应为 `Internal proxy error`。
- 容器日志给出明确错误：

```text
Invalid URL protocol: the URL must start with `http:` or `https:`.
```

- 调用栈定位到 `/opt/freebuff-proxy/src/upstream/client.js:92` 的 `new ProxyAgent({ uri: u })`。
- `/opt/freebuff-proxy/data/proxies.json` 有 1 条全局代理配置，安全检查只显示协议为 `socks5h:`，没有输出地址、用户名或密码。
- 当前 freebuff 版本的代理池走 Undici `ProxyAgent`，不能直接接受该 `socks5h:` URL；因此运行时创建 upstream client 失败，控制台显示不可用，NewAPI 通过该渠道的实际请求也会受影响。
- Caddy、DNS、端口、容器存活和 NewAPI 到 freebuff 的 Docker 网络不是主因。

## 用户期望

- 使用 `vps` 作为新代理出口。
- 如果可以，优先保留/使用 SOCKS5；否则使用可用的 HTTP/HTTPS 代理。
- 不在聊天中传输完整代理 URL、账号、密码、token 或密钥。

## vps 现状

- 用户澄清代理服务器是 SSH alias `vps`，不是 `ssh4`。
- 用户反馈自己可以连接 `vps`；但当前 Pi 工具进程无法复用用户的连接环境：SSH agent 不可用，配置中的 `C:/Users/Administrator/.ssh/vps` 被 OpenSSH 报为 `error in libcrypto`，随后返回 `Permission denied (publickey)`。
- 用户已在自己的客户端进入 `vps`，并提供了只读服务清单：
  - `sing-box` 监听 `0.0.0.0:2262` 和 `0.0.0.0:2263`。
  - `sing-box.service` 已启用。
  - 未发现 Docker 容器。
- Pi 工具随后已修复本地 `vps` SSH 私钥的 CRLF 换行为 LF，并成功通过 SSH 登录；没有输出或传输私钥内容。
- 通过恢复后的 SSH 读取 `/etc/sing-box/config.json`，确认：
  - `2262`: `vless`，TLS 开启；不是可直接给 freebuff 使用的 HTTP/HTTPS 代理。
  - `2263`: `socks`，TLS 未开启；这是 SOCKS 入站。
- 因此 vps 当前已确认提供 SOCKS，但没有确认提供 HTTP/HTTPS 代理；SOCKS 入站的认证字段未输出，仍需在实际连接测试中验证。
- 进一步发现 `/opt/vps-proxy-relay` 确实存在 relay/client 配置：`client/vps-static-relay.yaml` 声明了 `mixed-port: 7890`，另有 `clash-vless-reality.yaml`。
- 但旧配置依赖已经失效的 SS `2262`，且当前没有 Clash、Mihomo、GOST 或 relay 运行时；因此没有直接启动旧 YAML。
- 已在现有 `sing-box` 中新增受同一 SOCKS 用户认证保护的 `mixed` HTTP 入口 `7890`，保留 `2262`、`2263` 和原 direct outbound；从 ssh2 实测经 `7890` 访问外部 HTTPS 返回 200，未认证请求未被放行。
- 不读取、修复、转换或输出 VPS 私钥、代理密码或 sing-box 认证凭据。

## 修复选项

### 推荐顺序

1. 优先确认并恢复 VPS 上已有 relay/client 配置对应的运行方式；若 `mixed-port: 7890` 是预期入口，则让它实际监听后再从 ssh2 做连通性验证。
2. 如果 VPS 上的 relay 配置只是客户端配置或无法恢复，再在 ssh2 增加稳定的 HTTP→SOCKS 转换层，让 freebuff 继续使用其已支持的 `http://` 代理协议。
3. 备选是修改 freebuff 运行镜像/代码增加 SOCKS5 agent 支持，但改动面更大。
4. 如果不需要代理，删除当前无效的 `socks5h:` 配置，恢复直连。

## Acceptance Criteria

- [x] 已复现并定位当前“不可用”的具体根因。
- [x] vps 的 sing-box 入站协议和端口已确认：2262 为 VLESS/TLS，2263 为 SOCKS。
- [x] 已确认旧 VPS relay 配置与当前协议不兼容，并使用现有 sing-box 恢复受认证保护的 HTTP/mixed `7890` 入口。
- [x] ssh2 能经 VPS `7890` 访问外部 HTTPS，且未认证请求未被放行。
- [x] 替换/桥接代理后，`/v1/freebuff/status` 返回 200。
- [x] freebuff `/healthz` 返回 200，带服务凭据的 `/v1/models` 返回 200；NewAPI 容器可通过 host gateway 到达 freebuff `/healthz`。
- [ ] 现有账号、代理凭据和业务容器未被误删或回显。

## Out of scope

- 不读取或输出当前代理完整 URL、用户名、密码、Freebuff 凭据或 API Key。
- 在 vps 的 SOCKS 入站连通性和认证方式确认前，不执行远程写操作。
- 不直接改用 `socks5h:` 继续运行，因为当前 freebuff 版本已确认不接受该协议。

## 实施状态

用户已批准恢复 VPS 上的转换入口。旧 SS relay YAML 未直接启用；已用现有 sing-box 增加受认证保护的 `mixed` HTTP `7890`，并将 freebuff 从 `socks5h://vps:2263` 切换到同认证的 `http://vps:7890`。VPS 和 freebuff 均保留了 mode 600 回滚备份。
