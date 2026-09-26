# 技术设计：管理员密码轮换、NewAPI 渠道接入与保守清理

## 1. 边界

### freebuff 密码轮换

- 目标容器：`freebuff-proxy`。
- 用户存储：`/opt/freebuff-proxy/data/users.json` → 容器 `/data/users.json`。
- 轮换方式：在运行容器内执行一次性 Node module，从标准输入读取新密码，调用应用源码已有的 `UserStore.setPassword('admin', password)`。
- 传输方式：本地通过 SSH 标准输入传递；不放在 SSH 命令参数、环境变量、`.env`、任务文件或日志中。
- 生效方式：轮换完成后执行 `docker compose restart freebuff-proxy`，让服务重新加载 `users.json`。
- 不删除 `web-sessions.json`，避免超出用户请求；旧 session 的失效由既有 TTL/应用行为决定。

### NewAPI 渠道接入

- 目标容器：`newapi`。
- 数据库：`/opt/newapi/data/one-api.db`，当前 SQLite 使用 WAL；写入前先停止 NewAPI，并用 SQLite backup API 创建一致性备份。
- 网络：NewAPI 位于 `shared-app-network`，访问 host-network freebuff 使用 `172.20.0.1:8787`。
- 专用服务账号：在 freebuff 中创建 `newapi-bridge` 普通用户。其随机登录密码只用于生成用户哈希，不输出、不保存明文；NewAPI 渠道只接收该用户的 API Key。
- 渠道记录：插入一条最小 OpenAI channel：
  - `type = 1`（OpenAI）
  - `name = freebuff-proxy`
  - `status = 1`
  - `key = newapi-bridge` API Key
  - `base_url = http://172.20.0.1:8787`
  - `models = freebuff /v1/models` 返回的 model ids（逗号分隔）
  - `group = default`
  - `model_mapping` 为空
- base URL 不带 `/v1`：NewAPI OpenAI relay 会将 `/v1/chat/completions` 等请求路径追加到 base URL；带 `/v1` 会造成重复路径。
- 操作顺序：创建/取得专用 key → 以该 key 获取模型列表（key 只在内存管道中流转）→ 停止 NewAPI → 备份数据库 → 写入渠道 → 启动 NewAPI → 验证渠道记录和网络。

### 清理

仅清理以下可重建对象：

1. Docker BuildKit build cache：当前约 5.434GB、全部可回收。
2. APT archive cache：当前约 132MB。
3. 本次部署专属的 `/tmp/freebuff-*` 临时文件（若复核时仍存在）。

明确不清理：

- `/opt/freebuff-proxy/data/`、`users.json`、Freebuff credentials、sessions、settings。
- NewAPI 数据库、现有渠道、用户、token、旧备份和 staging 文件。
- 任何 Docker volume、运行中容器、停止容器、未使用镜像。
- Caddy 配置/证书数据。
- 其他项目的 `/tmp` 内容。

## 2. 数据流与不变量

```text
新密码（仅内存）
  │ SSH stdin
  ▼
freebuff-proxy 容器内一次性脚本
  │ UserStore.setPassword()
  ▼
/data/users.json（仅 scrypt salt + hash，不保存明文）
  │ compose restart
  ▼
运行中的 UserStore 重新加载

newapi-bridge API Key（仅内存管道）
  │ freebuff /v1/models + SQLite 参数绑定
  ▼
NewAPI channels.key（必要的服务配置秘密，远端数据库权限保护）
  │ NewAPI restart / channel cache reload
  ▼
NewAPI → 172.20.0.1:8787 → freebuff-proxy
```

不变量：

- freebuff 用户名、role、既有 API Key 数量和值不改变；只新增 `newapi-bridge`。
- NewAPI 既有 12 个渠道、用户、token、路由和计费数据不改变；只新增一条渠道。
- Freebuff 上游凭据目录不改变。
- 清理命令不触碰应用数据卷、NewAPI 数据库和 Caddy 数据。
- 任何密码、API Key、哈希或 token 都不出现在 stdout/stderr、命令行参数、环境变量或本地文件。

## 3. 验证设计

### 密码轮换验证

不使用新密码进行登录，也不打印哈希。通过以下非敏感事实验证：

- `users.json` 文件仍存在且权限保持为私有。
- 容器重启后为 `running/healthy`。
- 本机和 HTTPS `/healthz` 返回成功。
- 应用首页登录页可访问。
- 轮换脚本只报告成功/失败和目标用户名，不报告密码或哈希。

### NewAPI 验证

- `newapi` 容器停止前后状态按计划恢复为 running。
- SQLite 备份文件存在且非空，渠道插入前后现有渠道数量从 12 增加到 13。
- 新增记录的公开字段为 `type=1`、名称 `freebuff-proxy`、enabled、base URL `http://172.20.0.1:8787`、模型列表非空；验证查询不输出 key。
- 从 NewAPI 容器访问 freebuff `/healthz` 返回 200。
- NewAPI 首页和容器状态恢复正常；不读取 NewAPI 用户密码、channel key 或 token。
- 不做真实聊天请求，除非已有 Freebuff 上游账号；没有账号时只验证渠道和网络，不把上游无账号误判为接入失败。

### 清理验证

- 清理前后执行 `docker system df`、`docker builder du` 和 APT cache `du`，只输出总量。
- 清理后 BuildKit cache 和 APT archive cache 降到预期范围。
- 对 `data/`、NewAPI DB、Docker volumes、容器列表做存在性/数量核对，不读取敏感内容。
- 确认 `freebuff-proxy`、`newapi` 和 `caddy_proxy` 仍在运行。

## 4. 回滚

### 密码

- 本次不保存明文旧密码，也不备份密码哈希，因此不能自动回滚到旧密码。
- 如果轮换后健康检查失败，停止后续清理和 NewAPI 修改；通过用户已知的可用凭据或应用现有密码管理流程重新设置。
- 因为写入使用应用自己的 `UserStore` 格式，脚本失败时不应替换原文件；需先检查退出码再重启。

### NewAPI

- 若渠道插入失败：启动 NewAPI 前保持停止状态，恢复 SQLite backup 文件及 WAL 相关状态，再启动 NewAPI。
- 若启动后渠道异常：停止 NewAPI，用备份恢复数据库，启动并确认现有渠道数量回到 12。
- 若 freebuff 专用账号已创建但 NewAPI 回滚：保留该账号，不把 API Key 输出；后续可在 freebuff 控制台删除该服务账号，或重新使用它进行重试。
- 成功接入后保留一份带时间戳的数据库回滚备份，不删除旧备份。

### 清理

- BuildKit cache 和 APT archive cache 属于可重建缓存，无业务回滚数据。
- 不执行不可逆的 volumes/容器/镜像清理，因此不需要从备份恢复业务资源。

## 5. 风险

- 密码和 NewAPI channel key 必须避免 `set -x`、命令参数、环境变量和日志泄漏；执行脚本使用固定非敏感状态输出。
- NewAPI 停止/启动会产生短暂面板和 API 中断；变更前需确认 freebuff 已健康，变更后等待 NewAPI 首页恢复。
- SQLite 直接写入绕过管理 UI，但使用停机、一致性备份和最小化字段；若 schema 校验不符合预期必须停止，不强行插入。
- BuildKit cache 清理会使后续 Docker build 重新下载/构建层，但不影响当前运行容器。
- freebuff 无上游账号时，NewAPI 渠道可配置但真实对话会失败；需在 freebuff 控制台先添加至少一个账号。
