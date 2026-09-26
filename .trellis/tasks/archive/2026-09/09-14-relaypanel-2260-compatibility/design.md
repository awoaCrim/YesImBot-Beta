# 技术设计：VPS-only 3x-ui + Xray

## 1. 目标与边界

本设计只处理 VPS `67.103.169.18`。不访问、检查、修改或依赖任何其他主机；不把任何外部 `2260` 服务作为上游。

目标是新增一套由 3x-ui 管理的 Xray 数据面：

- 用户通过 VLESS + Reality 连接 VPS 的 `2260/tcp`；
- 3x-ui 管理用户凭据、订阅、流量、到期和禁用状态；
- Xray 默认通过 `freedom/direct` 从 VPS 本机公网出口发送流量；
- 现有 `sing-box.service`、`2262/tcp`、`2263/tcp` 完全并行保留。

## 2. 组件和边界

### 2.1 3x-ui 面板

- 固定稳定版本 `v3.7.0`，使用官方 Linux amd64 裸机安装方式。
- systemd 服务：`x-ui.service`。
- 数据库：SQLite，使用 3x-ui 默认数据库路径/受保护目录。
- 安装目录和 Xray 二进制使用 3x-ui 官方默认路径，实际路径以安装结果为准；不得与 sing-box 目录混用。
- 面板允许公网访问，按用户决定使用 3x-ui 原生 HTTP；使用非默认高位端口和随机 Web 根路径，并明确接受明文传输风险。
- 面板监听地址设为 `0.0.0.0`，以满足公网访问；面板端口不与 `2260`、`2262`、`2263` 或 `22` 冲突。
- 3x-ui 订阅子服务保留本地可用性，但固定监听 `127.0.0.1:2096`，不作为额外公网 HTTP 入口。

### 2.2 Xray 数据面

- 由 3x-ui 管理的 Xray 进程负责新入口。
- 新建 VLESS + TCP + Reality 入站：`0.0.0.0:2260`。
- Reality 密钥对、short ID、VLESS UUID 等由面板/安装过程生成，并只保存在 VPS 受保护路径。
- Reality 的 SNI/dest 使用一组静态配置；首版可沿用 VPS 现有 VLESS Reality 配置中已使用的 `www.npmjs.com` 作为 SNI/dest，不修改现有 2262 配置，不在部署验收阶段主动探测该域名。
- 新入站全部路由到 `freedom/direct`，不配置外部 SOCKS/HTTP 上游、不配置代理池、不配置 URLTest 或健康探测。

### 2.3 现有服务

- 现有 `/etc/sing-box/config.json`、`sing-box.service`、`2262/tcp` 和 `2263/tcp` 是只读保护对象。
- 新 Xray 不加入现有 sing-box systemd 服务，也不复用或覆盖 sing-box 配置。
- `2260/tcp` 在部署前为空闲端口，由新 Xray 入站占用；这不代表部署前已经存在一个 2260 服务。

## 3. 数据流和控制流

```text
浏览器/客户端
      │
      │ VLESS + Reality，用户 UUID
      ▼
VPS:2260/tcp
      │
      │ Xray 入站解密与用户校验
      ▼
Xray freedom/direct outbound
      │
      ▼
VPS 默认公网出口
```

控制面独立于数据面：

```text
管理员浏览器 ── HTTP + 强凭据/可选 2FA（用户已接受明文风险）──> 3x-ui 面板
                                             │
                                             ├─ SQLite 用户/流量/订阅数据
                                             └─ 生成/重载 Xray 配置
```

3x-ui 面板自身的更新检查、Telegram、地理数据或订阅拉取等外部行为不属于本任务验收路径；主动 tunnel health monitor 必须关闭。

## 4. 端口合同

| 端口 | 归属 | 处理方式 |
|---|---|---|
| `22/tcp` | SSH | 保持不变，始终保留访问能力 |
| `2260/tcp` | 新 Xray VLESS + Reality | 新建并对公网开放 |
| `2262/tcp` | 现有 sing-box VLESS Reality | 不修改 |
| `2263/tcp` | 现有 sing-box SOCKS5 | 不修改 |
| 面板随机高位端口 | 3x-ui HTTP | 公网开放；要求随机路径、强凭据和登录保护 |
| `2096/tcp` | 3x-ui 订阅子服务 | 仅监听 `127.0.0.1`，不对公网开放 |

不使用 Docker，不创建额外的面板反向代理，不引入 PostgreSQL 或其他数据库。

## 5. 安全设计

### 5.1 面板

- 安装生成的管理员信息保存在 `/etc/x-ui/install-result.env`，权限 `0600`；不复制到仓库、不写入任务文档、不在聊天回显。
- 设置强随机 Web 根路径和非默认面板端口，按用户决定使用原生 HTTP。
- 不生成、不配置面板 TLS 证书，也不创建额外反向代理；订阅子服务不作为公网额外入口。
- 首次登录后修改安装生成的凭据并启用 TOTP 2FA。
- 依靠 3x-ui 登录失败限制器；不启用可能影响 SSH 的激进默认拒绝防火墙。
- 明确管理员密码和会话将在公网明文传输；该风险已由用户接受，后续仍应优先升级到 HTTPS。

### 5.2 Xray

- 用户只获得自己的 VLESS 订阅/凭据；不获得面板管理员凭据、Reality 私钥或系统文件。
- 不配置 SOCKS/HTTP 上游凭据，因为本任务的出口是 VPS `direct`。
- 不启用自动出口检测、URLTest、健康 URL 或出口 IP 查询。
- 2260 只提供 VLESS + Reality；首版不新增 UDP 入站。

### 5.3 防火墙

- 部署前记录 VPS 当前 nftables/iptables 状态；默认不执行全量防火墙重置。
- 如确实需要新增主机防火墙规则，只允许 `22`、面板端口、`2260`、`2262`、`2263`，并先确认 SSH 会话仍可用。
- 云厂商安全组不在本任务自动修改范围内；本机只能验证监听，不宣称云防火墙已放行。

## 6. 资源和运行风险

- VPS 约 1 vCPU、926 MiB 内存、512 MiB Swap。裸机 3x-ui + Xray 比面板、节点、协议网关叠加部署更节省组件开销，但仍需观察内存。
- 使用 SQLite 和单节点配置，避免 PostgreSQL、Docker 和多节点同步。
- 不启用额外的 tunnel health monitor，避免探测流量和自动重启造成连接中断。
- Xray 与 sing-box 同机运行，主要风险是端口冲突、内存压力和 3x-ui 误操作覆盖配置；通过预检端口、服务隔离和哈希对比控制。

## 7. 备份与回滚

### 备份

在安装前将以下内容保存到 VPS 本地带时间戳目录，权限限制为 root：

- `/etc/sing-box/config.json` 的只读备份和 SHA-256；
- `sing-box.service` 单元文件和状态摘要；
- 安装前监听端口、内存、磁盘、包管理器状态；
- 若存在任何预先创建的 3x-ui 路径，只记录并停止，不覆盖。

备份不得复制到本地项目或聊天输出。

### 回滚

- `systemctl disable --now x-ui.service`，确认 `2260` 释放；
- 删除或隔离本任务新建的 3x-ui/Xray 目录、服务单元和 SQLite；只删除安装前不存在且由本任务创建的路径；
- 如本任务添加了防火墙规则，按备份恢复；默认不重置既有规则；
- `systemctl daemon-reload` 后确认 `sing-box.service`、`2262`、`2263` 正常；
- 不删除 3x-ui 安装带来的通用依赖包，避免误伤 VPS 上其他任务。

## 8. 验证边界

允许：

- 3x-ui/Xray 版本和配置语法检查；
- systemd 启用/运行状态；
- VPS 本机 HTTP 面板状态码检查；
- VPS 本机监听端口检查；
- 现有 sing-box 配置/服务哈希和状态前后对比；
- 检查 tunnel health monitor 未启用。

不允许：

- 连接、探测、测速或查询任何其他主机/远程 2260；
- 使用真实代理请求验证出口；
- 查询公网出口 IP；
- 通过第三方站点验证 Reality 或代理链路；
- 在日志或聊天中回显任何密码、UUID、Reality 私钥、订阅密钥或 API token。
