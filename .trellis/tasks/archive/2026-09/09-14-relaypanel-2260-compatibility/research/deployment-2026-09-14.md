# VPS 部署验证记录

日期：2026-09-14
范围：仅 VPS `vps`（`67.103.169.18`）；未连接、检查或修改其他 SSH 主机。

## 已执行

- 运行 `task.py start` 后开始部署。
- 预检确认 Debian 12、`2260/tcp` 空闲、现有 `sing-box.service` active/enabled，`2262/tcp` 和 `2263/tcp` 正常监听。
- 使用官方 `MHSanaei/3x-ui` `v3.7.0` 安装脚本和 amd64 release；原始脚本及 SHA-256 保存在 VPS root-only 备份目录。
- 因官方安装脚本在配置阶段默认访问多个公网 IP 提供商，而本任务禁止公网出口 IP 查询，使用只删除该探测代码的本地副本执行；补丁 diff 保存在同一 root-only 备份目录。
- 3x-ui 使用 SQLite；面板使用公网 HTTP、随机高位端口和随机 Web 根路径；不生成面板证书。
- 创建 Xray VLESS + TCP + Reality 入站：`0.0.0.0:2260`，一个初始客户端，出站为 `freedom/direct`。
- 发现 3x-ui 默认订阅子服务会公网监听 `2096/tcp`；已将 `subListen` 设置为 `127.0.0.1`，不保留额外公网 HTTP 入口。
- 初次安装器输出的临时凭据未被输出过滤器正确遮蔽；这些值已立即全部轮换（管理员凭据、API token、Web 根路径），旧临时日志已删除，当前凭据只保存在 VPS root-only `/etc/x-ui/install-result.env`。本记录不包含任何敏感值。

## 最终验证结果

- `x-ui.service`：enabled/active；运行版本 `3.7.0`。
- Xray 运行版本：`26.7.28`。
- 面板本机 HTTP 状态：200；API token 鉴权：200。
- 管理员凭据经带 CSRF token 的本机登录检查成功；TOTP 仍待管理员首次登录后启用。
- API 中目标入站存在：VLESS、`0.0.0.0:2260`、TCP/Reality、一个客户端、Reality 密钥字段存在。
- 从面板返回的目标入站生成临时 root-only Xray 配置，`xray run -test` 通过。
- Xray 静态配置包含 `freedom:direct` 和 `blackhole`，没有 SOCKS/HTTP 等外部代理出站。
- `2260/tcp` 对外监听；`22/tcp`、`2262/tcp`、`2263/tcp` 仍存在；`2096/tcp` 仅监听 `127.0.0.1`。
- `/etc/sing-box/config.json` 和 `sing-box.service` SHA-256 与部署前一致；sing-box 仍 enabled/active。
- nftables 规则集未发生变化；未执行全量防火墙重置。
- 初始客户端分享信息保存在 VPS root-only 备份文件中，未写入仓库或聊天。

## 未执行

- 未执行真实 VLESS 代理请求、测速、出口 IP 查询、第三方目标探测或其他远程主机操作。
