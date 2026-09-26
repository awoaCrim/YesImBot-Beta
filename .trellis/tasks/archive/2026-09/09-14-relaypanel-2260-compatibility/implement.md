# 执行计划：仅在 VPS 部署 3x-ui + Xray

> 本文件已在用户明确批准并运行 `task.py start` 后执行；当前部署已完成，最终结果和偏差记录在 `research/deployment-2026-09-14.md`。

## 前置条件和固定决策

- 目标仅为 SSH 别名 `vps`，即 `root@67.103.169.18:22`。
- 固定 3x-ui 稳定版本：`v3.7.0`。
- 使用官方裸机安装方式和默认 SQLite，不安装 Docker/PostgreSQL。
- 新 Xray 入站：VLESS + TCP + Reality，监听 `0.0.0.0:2260`。
- 新用户流量默认使用 VPS `freedom/direct` 出站。
- 现有 `sing-box.service`、`/etc/sing-box/config.json`、`2262/tcp`、`2263/tcp` 和 SSH `22/tcp` 不修改。
- 3x-ui 面板公网 HTTP，使用非默认高位端口、随机 Web 根路径、强凭据和 TOTP 2FA；用户已明确接受明文传输风险，不生成面板证书。
- 不执行真实代理请求、出口 IP 查询、测速、外部目标探测或任何其他主机操作。

## 阶段 1：任务启动和 VPS 预检

1. 用户明确批准本文件后运行：
   - `python ./.trellis/scripts/task.py start 09-14-relaypanel-2260-compatibility`
2. 只读采集基线：
   - hostname、OS、架构、时间；
   - `free -h`、`df -hT /`；
   - `ss -lntup`；
   - `systemctl is-enabled/is-active sing-box.service`；
   - `sha256sum /etc/sing-box/config.json /lib/systemd/system/sing-box.service`；
   - `nft list ruleset` / `iptables -S`（仅记录，不重置）。
3. 确认 `2260/tcp` 空闲，`2262/tcp` 和 `2263/tcp` 仍由现有 sing-box 监听。
4. 在 VPS 本地创建 root-only、带 UTC 时间戳的备份目录，保存：
   - sing-box 配置备份、服务单元备份；
   - 监听/服务/资源摘要；
   - 包管理器状态和已有 `/etc/x-ui`、`/usr/local/x-ui` 路径存在性。
5. 若发现 `2260` 已被占用或现有 x-ui 文件，停止执行并重新规划，不覆盖任何内容。

## 阶段 2：获取并安装 3x-ui v3.7.0

1. 从官方仓库获取 `v3.7.0` 的 `install.sh` 到 VPS 临时目录，不直接执行未经落盘检查的远程管道。
2. 记录下载文件 SHA-256，并检查脚本中仓库、版本和目标架构与计划一致。
3. 以 root 运行官方安装脚本，允许其安装所需的 `curl`、`cron`、`tar`、`tzdata`、`socat`、`ca-certificates`、`openssl` 等基础依赖；不启用 Docker/PostgreSQL。
4. 让安装程序生成随机管理员用户名、密码、面板端口、Web 根路径和 API token；安装结果只保存在 `/etc/x-ui/install-result.env`，权限必须为 `0600`。
5. 记录新建文件路径和服务状态，但不读取或输出凭据值。
6. 立即确认 `x-ui.service` 已启用/运行，3x-ui 版本为 `v3.7.0`，Xray 二进制存在并能输出版本。

## 阶段 3：保护面板管理面

1. 不生成面板 TLS 证书，按用户决定使用公网 HTTP；明确接受密码和会话明文传输风险。
2. 使用 3x-ui 支持的设置入口配置：
   - `webListen=0.0.0.0`；
   - 安装生成的非默认高位面板端口；
   - 长随机 `webBasePath`；
   - 不设置 `webCertFile` / `webKeyFile`；
   - 关闭 `XUI_TUNNEL_HEALTH_MONITOR`，不设置主动探测 URL。
3. 通过本机 HTTP 检查面板只返回可用响应；不在命令输出中打印 Cookie、Authorization 或密码。实际首次安装输出发生过一次敏感值过滤失效，后续已立即轮换全部初始值并删除临时日志，详见部署记录。
4. 将 3x-ui 订阅子服务的 `subListen` 固定为 `127.0.0.1`，避免默认 `2096/tcp` 形成额外公网 HTTP 入口；客户端分享信息保留在 VPS root-only 文件或由管理员登录面板查看。
5. 登录面板后：
   - 修改安装生成的管理员凭据；
   - 启用 TOTP 2FA；
   - 确认面板使用 HTTP 且风险已知；
   - 不打开 PostgreSQL、Telegram、外部订阅拉取或不必要的通知功能。

## 阶段 4：创建 VLESS + Reality 入站

1. 在 3x-ui 中创建独立 Xray 入站：
   - 协议：VLESS；
   - 监听：`0.0.0.0`；
   - 端口：`2260/tcp`；
   - 网络：TCP/Raw；
   - 安全：Reality；
   - 使用新生成的 Reality 密钥对和 short ID；
   - 使用独立的 VLESS 客户端 UUID；
   - SNI/dest 使用既定静态 HTTPS 伪装配置，不在验收阶段主动探测目标。
2. 确认 Xray 的默认出站为 `freedom/direct`，并为新入站设置明确的 direct routing；不添加任何远程 SOCKS/HTTP 上游。
3. 生成一份客户端订阅/分享信息到 VPS root-only 临时文件，供用户登录面板后自行查看；不把 UUID、私钥、订阅密钥或完整分享链接写入任务文档或聊天。
4. 不新增 UDP 入站；VLESS Reality 首版只验收 TCP 监听和配置语法。

## 阶段 5：防火墙和暴露面

1. 记录安装前后的主机防火墙差异。
2. 默认不执行全量默认拒绝规则，不重置 nftables/iptables，不调用可能覆盖现有规则的防火墙向导。
3. 如果云安全组或现有主机规则阻断新增端口，只记录阻断原因并停止开放动作，等待用户单独确认；不得为修复访问而放行所有端口。
4. 验收口径：SSH `22`、VLESS `2260`、既有 `2262`/`2263` 仍可见；面板端口按用户确认的公网 HTTP 方式开放，并记录明文传输风险；`2096/tcp` 只允许本机订阅服务监听。

## 阶段 6：验证

### 允许执行

1. `systemctl is-enabled/is-active x-ui.service`。
2. `x-ui -v`、Xray 版本检查。
3. 找到 3x-ui 生成的 Xray 配置后执行只读语法检查；使用 Xray 官方 test/check 参数，不启动第二个实例。
4. `ss -lntup` 确认：
   - 新 Xray 监听 `2260/tcp`；
   - 原 sing-box 仍监听 `2262/tcp`、`2263/tcp`；
   - SSH 仍监听 `22/tcp`；订阅子服务 `2096/tcp` 不得对公网监听。
5. 对 `http://127.0.0.1:<panel-port>/<base-path>/` 进行本机 HTTP 状态检查，不打印响应体中的敏感值；同时确认面板 socket 绑定公网接口，但不对云安全组或公网路径做外部探测。
6. 比较部署前后：
   - `/etc/sing-box/config.json` SHA-256；
   - `sing-box.service` SHA-256；
   - sing-box enabled/active 状态；
   - `2262`/`2263` 监听状态；
   - 内存和磁盘余量。
7. 检查 `XUI_TUNNEL_HEALTH_MONITOR` 未启用，日志中没有任务主动外部探测记录。

### 禁止执行

- 任何真实 VLESS 代理请求或对外部目标的 CONNECT。
- 任何出口 IP 查询、测速、健康 URL 请求或第三方站点探测。
- 任何对其他 SSH 主机或远程 `2260` 的连接。
- 任何将密码、UUID、Reality 私钥、API token、订阅密钥写入日志或聊天的操作。

## 阶段 7：交付和回滚信息

交付给用户：

- 面板公网 HTTP 地址的主机、端口和路径；敏感凭据只提示用户在 VPS 上读取 `/etc/x-ui/install-result.env`，不在聊天回显。
- 新 VLESS 入站为 VPS `2260/tcp`；现有 `2262`/`2263` 未修改。
- 3x-ui/Xray 服务名、备份目录和状态检查结果。
- 面板使用明文 HTTP，管理员密码和会话存在被窃听风险；后续如有域名应优先升级到 HTTPS。
- 当前未执行真实代理/出口验证。

回滚：

1. 保存最终状态摘要和备份路径。
2. `systemctl disable --now x-ui.service`，确认 `2260` 释放。
3. 仅删除由本任务创建且安装前不存在的 3x-ui/Xray 目录、服务和数据库。
4. 如本任务添加过防火墙规则，按备份恢复；不重置既有防火墙。
5. `systemctl daemon-reload`。
6. 重新检查 `sing-box.service`、`2262`、`2263`、SSH `22` 和 sing-box 配置哈希。
7. 不删除安装过程引入的通用依赖包，避免影响 VPS 其他服务。

## 完成门槛

- 以上验证全部通过；
- 现有 sing-box 配置和服务状态无非预期变化；
- 面板 HTTP、强凭据、随机路径和 2FA 已完成或明确交由用户首次登录完成，并已告知明文传输风险；
- 任务文件和聊天记录没有敏感凭据；
- 任务完成后运行 `task.py finish`，按 Trellis 流程归档，不创建 git commit。

## 实际收尾状态

- 3x-ui/Xray 已部署；VPS 本机验证通过。
- TOTP 2FA 尚未启用，需管理员首次登录后完成。
- 安装器初始凭据曾短暂出现在会话输出中，已在继续操作前轮换管理员凭据、API token 和 Web 根路径；最终值未写入本地任务文件。
- 默认订阅子服务 `2096/tcp` 已限制为 `127.0.0.1`，未形成额外公网 HTTP 入口。
- 未验证云安全组或公网实际可达性，未执行真实代理请求、出口查询或外部目标探测。
