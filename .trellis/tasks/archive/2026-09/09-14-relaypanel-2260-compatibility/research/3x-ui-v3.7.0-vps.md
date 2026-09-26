# 3x-ui v3.7.0 VPS 部署调研

日期：2026-09-14
范围：只研究和操作 VPS，不涉及其他主机。

## VPS 基线

- Debian 12 (bookworm), x86_64, 1 vCPU。
- 内存 926 MiB，Swap 511 MiB；根盘 9.9 GiB，可用约 7.3 GiB。
- `sing-box 1.13.19` 由 `sing-box.service` 运行。
- 现有监听：22/tcp、2262/tcp、2263/tcp。
- 2260/tcp 当前未监听；新任务将其分配给 Xray 的 VLESS + Reality 入站。
- 现有 sing-box 配置出站为 `direct`；现有服务配置哈希在部署前后必须保持一致。
- VPS 没有 Xray、3x-ui、Docker、Podman、Caddy 或 Nginx。

## 上游版本和安装方式

- 官方仓库：`MHSanaei/3x-ui`。
- 当前稳定 release：`v3.7.0`，发布日期 2026-08-24；部署固定此 tag，不使用 `main`/dev 滚动版本。
- 官方安装脚本支持 Debian amd64，并使用 systemd 服务 `x-ui.service`；默认 SQLite，数据文件默认位于 `/etc/x-ui/x-ui.db`，主目录默认 `/usr/local/x-ui`。
- 安装脚本会安装/使用 `cron`、`curl`、`tar`、`tzdata`、`socat`、`ca-certificates`、`openssl` 等基础包，并将随机管理员信息写入 root-only `/etc/x-ui/install-result.env`（mode 600）。不把该文件内容复制到仓库或聊天。

## 目标数据面

- 新 Xray 入站：VLESS + TCP + Reality，监听 `0.0.0.0:2260`。
- 为每个用户由 3x-ui 生成独立 UUID/订阅信息；用户不接触服务端管理配置。
- 新入站默认路由到 Xray 的 `freedom/direct` 出站，实际出口为 VPS 默认网络。
- 不改现有 sing-box；Xray 由 3x-ui 管理，使用其自己的配置和进程。
- Reality 的密钥对、short ID、客户端 UUID 等均为敏感值，只在 VPS 受保护路径保存/展示。

## 管理面

- 用户已明确允许公网明文 HTTP 登录，并接受密码和会话被窃听的风险。
- 按当前批准方案使用 3x-ui 原生 HTTP，设置 `webListen=0.0.0.0`、非默认随机高位面板端口和长随机 `webBasePath`；不生成或配置面板证书。
- 首次登录后修改安装生成的管理员凭据并启用 TOTP 2FA。
- 面板公网端口、VLESS `2260`、现有 `2262`/`2263` 按需放行；SSH `22` 必须保持放行。
- 3x-ui 的 tunnel health monitor 不启用，避免部署或验收阶段主动请求外部 URL。

## 安全和验证限制

- 不连接、检查、修改或依赖其他主机。
- 不执行真实代理请求、测速、出口 IP 查询、健康 URL 探测或外部目标探测。
- 可执行：Xray 配置语法检查、3x-ui/Xray systemd 状态检查、VPS 本地面板 HTTP 状态检查、VPS 本地监听检查、现有 sing-box 服务状态/配置哈希对比。
- 验收过程中不得回显管理员密码、API token、UUID、Reality 私钥或订阅密钥。

## 官方资料路径

- `README.zh_CN.md`：安装、支持系统、SQLite、功能和安全提示。
- `install.sh`：稳定版本安装、随机凭据、依赖和 systemd 行为。
- `docs/content/docs/zh/config/panel.mdx`：`webListen`、面板端口、基础路径、TLS 和 panel outbound。
- `docs/content/docs/zh/operations/security.mdx`：面板凭据、2FA、登录限制、Fail2ban 和防火墙。
- `docs/content/docs/zh/reference/ports-firewall.mdx`：SSH、面板和入站端口规划。
- `docs/content/docs/zh/guide/first-login.mdx`：`/etc/x-ui/install-result.env` 和首次登录加固。
- `docs/content/docs/zh/operations/outbounds-routing.mdx`：Xray outbound/routing 配置。
- Xray 官方文档：VLESS/Reality 入站与 `freedom` 出站的配置语义。
