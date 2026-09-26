# 修改 freebuff 管理员密码、接入 NewAPI 并清理 ssh2 垃圾缓存

## Goal

在已部署的 `ssh2` 环境中安全轮换 freebuff-proxy 的 `admin` 管理员密码，将 freebuff-proxy 作为一个 OpenAI 兼容渠道接入现有 NewAPI，并清理本次部署环境中可确认安全、可重建的缓存；不删除应用数据、Freebuff 凭据、API Key、Caddy 数据或其他业务容器资源。

## Confirmed facts

### freebuff-proxy

- 服务目录：`ssh2:/opt/freebuff-proxy`；容器名：`freebuff-proxy`；当前状态为 healthy。
- Web 用户数据位于容器 `/data/users.json`，由 `src/web/user-store.js` 使用 scrypt 哈希保存；`UserStore.setPassword(username, password)` 会重新生成 salt 和 password hash，并保留用户名、角色和 API Key。
- 应用的管理员用户管理 API 需要现有登录会话；不读取旧密码或密码日志，计划使用容器内一次性脚本从标准输入调用同一 `UserStore.setPassword`，然后重启应用使内存中的用户存储刷新。
- freebuff 的 `/v1/models` 需要 API Key，但返回模型目录来自应用内置 catalog；可为 NewAPI 创建独立的普通用户服务账号和 API Key，不复用 admin Key。

### NewAPI

- NewAPI 容器名：`newapi`；当前运行在 Docker `shared-app-network`，容器地址为 `172.20.0.2`，宿主机网关为 `172.20.0.1`。
- 从 NewAPI 容器访问 `http://172.20.0.1:8787/healthz` 已返回 HTTP 200，说明 NewAPI 到 freebuff 的网络路径可用。
- NewAPI 数据库：`/opt/newapi/data/one-api.db`；当前有 12 个渠道，现有管理用户和渠道不纳入修改。
- NewAPI 源码中的 `ChannelTypeOpenAI` 为 `1`；OpenAI relay 将请求路径追加到 `base_url`，因此渠道 base URL 应为 `http://172.20.0.1:8787`，不能带重复的 `/v1`。
- 推荐新增渠道：名称 `freebuff-proxy`，类型 OpenAI，状态 enabled，分组 `default`，模型列表取 freebuff `/v1/models` 的 catalog，模型映射留空。
- 不读取 NewAPI 管理员密码、现有 channel key、用户密码或 access token；由于没有使用管理员会话，本次计划在停 NewAPI 后备份 SQLite，再写入一个最小渠道记录并重启 NewAPI，让它重新加载渠道缓存。

### 清理证据

- 远程 Docker 当前 Build Cache 约 5.434GB，全部标记为可回收；APT archive cache 约 132MB。
- 当前没有 dangling Docker image；存在两个历史退出的 `caimogu-bot-before-*` 容器，属于其他部署，不纳入本次清理。
- `/tmp` 中有大量其他项目的脚本、日志、构建产物和检查文件；没有证据表明它们属于本次 freebuff 部署，因此不做全量 `/tmp` 清理。
- freebuff 部署产生的临时健康检查文件已不存在；部署目录约 1.3MB（不含 data 目录的敏感内容）。

## Requirements

- R1：将当前 freebuff `admin` 用户密码轮换为用户提供的新密码；密码只能通过 SSH 标准输入传递，不写入 Trellis 文件、`.env`、命令参数、日志或最终回复。
- R2：轮换过程不得删除或重建 freebuff `data/`，不得改变 Freebuff 账号凭据、普通用户、角色或 API Key；完成后重启 `freebuff-proxy`，确保新密码生效。
- R3：在 freebuff 中创建一个独立的普通用户服务账号 `newapi-bridge`（随机生成其本地登录密码，不回显），只把该用户的 API Key 通过内存管道用于 NewAPI 渠道，不复用 admin Key。
- R4：在 NewAPI 中新增一个 OpenAI 渠道 `freebuff-proxy`：base URL 为 `http://172.20.0.1:8787`，key 为专用服务账号 API Key，模型列表为 freebuff catalog，分组为 `default`，不修改现有渠道、用户、token 或模型映射。
- R5：修改 NewAPI SQLite 前创建一致性备份；操作失败时恢复数据库备份并重新启动 NewAPI。成功后保留一份带时间戳的回滚备份，不在任务文件或回复中输出其中的密钥内容。
- R6：清理可确认安全的 Docker BuildKit build cache 和 APT archive cache；若存在本次部署专属临时文件，只清理这些文件。
- R7：不执行全量 `/tmp` 删除、不删除 Docker volumes、不删除现有/停止容器、不执行全量 image prune、不清理 Caddy 数据或其他业务缓存。
- R8：完成后验证 freebuff 容器、NewAPI 容器、两端健康检查、NewAPI 渠道记录和 NewAPI 到 freebuff 的网络连通性；实际聊天请求若没有 Freebuff 上游账号则明确标记为未测试。

## Acceptance Criteria

- [x] freebuff `admin` 的密码哈希已更新，`data/`、Freebuff 凭据、普通用户和 API Key 未被删除或重置。
- [x] `freebuff-proxy` 重启后仍为 `running/healthy`，重启策略保持 `unless-stopped`。
- [x] 本机 `http://127.0.0.1:8787/healthz` 和 HTTPS 域名 `/healthz` 均返回成功。
- [x] freebuff 中存在 `newapi-bridge` 普通服务账号，NewAPI 渠道使用该账号的 API Key；任何密码和 key 均未出现在输出中。
- [x] NewAPI 新增一个 enabled 的 OpenAI 渠道，名称为 `freebuff-proxy`，base URL 为 `http://172.20.0.1:8787`，模型列表非空，现有 12 个渠道保持不变。
- [x] NewAPI 重启后仍为 running，能从其容器访问 freebuff `/healthz`；渠道记录可被 NewAPI 重新加载。
- [x] Docker Build Cache 和 APT archive cache 已清理，清理前后空间变化已记录。
- [x] 没有删除其他业务容器、Docker volumes、Caddy 数据或 `/opt/freebuff-proxy/data/`。
- [x] 密码、API Key、哈希、NewAPI 数据库敏感字段未出现在任务文件、shell 参数、日志、工具输出或最终回复中。

## Out of scope

- 不读取或输出旧密码、新密码、用户密码哈希、Freebuff 凭据、API Key、NewAPI channel key、用户 access token 或 SSH 密钥。
- 不删除 `/opt/freebuff-proxy/data/`，不删除 `users.json`，不重置现有 freebuff 用户或 API Key。
- 不修改 NewAPI 现有渠道、用户、token、模型路由或计费数据；不删除 NewAPI 现有数据库备份。
- 不清理其他项目的 `/tmp` 文件，不删除退出容器，不删除未使用 Docker 镜像或 volumes。
- 不修改 Caddy 配置、DNS、防火墙或 freebuff/NewAPI 源码。
- 不执行需要真实 Freebuff 账号授权的完整对话测试；用户需先在 freebuff 控制台添加至少一个上游账号。

## Key decisions and risks

- 使用 freebuff 自己的 `UserStore.setPassword` 轮换密码，而不是直接编辑 hash，避免破坏 scrypt 格式和其他用户字段。
- 为 NewAPI 创建独立普通服务账号，降低把 admin Key 写入第三方渠道配置的风险；该账号的随机本地密码只保存在哈希中，NewAPI 仅持有 API Key。
- NewAPI 采用停服、SQLite 一致性备份、最小化插入、重启的方式加载渠道，因为本次不读取 NewAPI 管理员凭据；这会造成一次短暂 NewAPI 不可用窗口。
- 只清理可重建的 BuildKit cache 与 APT archive cache，预计释放约 5.5GB，不影响运行中的容器，但会降低后续 Docker 构建的缓存命中率。
- 不通过 `.env` 持久化 freebuff 管理员密码；不通过命令参数或环境变量传递 NewAPI channel key。
- freebuff 没有上游账号时，NewAPI 渠道可以存在并列出 catalog，但真实对话会因没有可用上游账号而失败；这不是本次部署故障。

## Open questions

无。新增 NewAPI 渠道按上述推荐参数执行；用户已批准将其纳入本次操作，但由于范围相对原计划发生实质变化，需要在执行前重新确认以下最终规划摘要。
