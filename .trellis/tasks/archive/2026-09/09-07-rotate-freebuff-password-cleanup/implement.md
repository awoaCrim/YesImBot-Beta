# 执行计划：管理员密码轮换、NewAPI 渠道接入与保守清理

## 前置条件

- [x] 用户允许创建本次 Trellis 任务。
- [x] 已确认 freebuff 服务目录、容器、用户存储实现和远程空间占用。
- [x] 已确认 NewAPI 容器、数据库、网络网关、渠道类型和 freebuff 连通性。
- [x] 已确定只清理可重建缓存，不删除业务数据或其他容器资源。
- [ ] 本次扩大后的最终规划摘要经用户明确批准；批准前不执行 `task.py start` 和远程写操作。

## 1. 远程预检

- 检查 `freebuff-proxy`、`newapi`、`caddy_proxy` 状态、健康状态、重启策略和挂载。
- 检查 `/opt/freebuff-proxy/data/users.json` 和 `/opt/newapi/data/one-api.db` 存在，但不输出内容、哈希、API Key 或 token。
- 记录清理前 `docker system df`、BuildKit cache 总量和 APT archive cache 总量。
- 记录 NewAPI 当前渠道数量（预期 12）、数据库 WAL 状态和备份目录。
- 确认没有本次部署专属的残留 `/tmp/freebuff-*` 文件；若有，仅记录名称/大小并定向删除。

## 2. 安全轮换 freebuff 密码

- 在容器中确认 `/app/src/web/user-store.js` 存在，并确认目标 `admin` 用户存在，但不打印用户记录。
- 通过 SSH stdin 将用户提供的新密码传给一次性 Node 脚本；不把密码写入命令参数、环境变量、文件、`.env` 或日志。
- 脚本导入 `/app/src/web/user-store.js`，创建 `UserStore('/data/users.json')`，调用 `setPassword('admin', stdinPassword)`。
- 脚本 stdout 只输出固定的成功/失败状态，不输出输入、哈希、用户对象或异常中的敏感内容。
- 成功后执行 `cd /opt/freebuff-proxy && docker compose restart freebuff-proxy`。
- 等待容器重新变为 healthy；失败则停止后续清理和 NewAPI 修改并保留现场。

## 3. 创建 NewAPI 专用 freebuff 服务账号

- 在 freebuff 容器内使用应用 `UserStore.create` 创建 `newapi-bridge` 普通用户；其本地登录密码由容器内随机生成，不输出。
- 在同一受控脚本中只将该用户 API Key 传入内存管道；不打印 API Key，不写本地文件，不放入 shell 参数或环境变量。
- 使用该 key 请求 freebuff `GET /v1/models`，只在内存中提取 model ids；模型列表非空才继续。
- 若用户名已存在，停止并报告，不覆盖现有服务账号或其 key。

## 4. 备份并写入 NewAPI 渠道

- 停止 `newapi` 容器，确认它已停止且不影响 freebuff/Caddy。
- 使用 SQLite backup API 生成 `/opt/newapi/staging/one-api.db.bak-<timestamp>`，设置仅 root 可读；不输出数据库内容。
- 在 schema 仍为预期结构时，使用参数化 SQL 插入一条渠道：
  - `type=1`
  - `name=freebuff-proxy`
  - `status=1`
  - `key=<newapi-bridge API Key>`
  - `base_url=http://172.20.0.1:8787`
  - `models=<freebuff catalog ids>`
  - `group=default`
  - `model_mapping` 为空
- 启动 `newapi`，等待首页/容器恢复；让应用重新加载渠道缓存。
- 验证新渠道非敏感字段和总数量 13，不查询/输出 key、用户密码或 token。
- 任何 SQLite 错误、启动错误或数量异常都停止后续清理，按备份回滚。

## 5. 清理缓存

仅在密码轮换和 NewAPI 渠道验证成功后执行：

- 执行 `docker builder prune -af`，仅清理 BuildKit build cache。
- 执行 `apt-get clean`，仅清理 APT archive cache。
- 如复核发现 `/tmp/freebuff-*` 临时文件，仅定向删除这些文件。
- 不执行 `docker system prune`、`docker image prune -a`、`docker volume prune`，不删除停止容器，不清理其他 `/tmp` 文件。

## 6. 最终验证

- `freebuff-proxy`：`running/healthy`，重启策略仍为 `unless-stopped`。
- `newapi`：`running`，首页 HTTP 200，现有渠道仍可见且新增渠道已加载。
- `caddy_proxy`：保持运行，不改 Caddy。
- `curl http://127.0.0.1:8787/healthz`：成功。
- 从 `newapi` 容器访问 `http://172.20.0.1:8787/healthz`：HTTP 200。
- `curl --resolve freebuff.uwoacrimson.com:443:127.0.0.1 https://freebuff.uwoacrimson.com/healthz`：成功。
- `/opt/freebuff-proxy/data/`、`users.json`、NewAPI DB、Caddy 数据和 Docker volumes 仍存在；只检查元数据，不输出内容。
- 记录清理前后空间统计和实际释放量。
- 不使用新密码执行登录，不执行真实 Freebuff 对话；没有上游账号时明确标记。

## 7. 交付说明

- 告知用户密码已轮换，但不在回复中重复密码。
- 告知 NewAPI 已新增 `freebuff-proxy` 渠道、base URL 和模型目录已加载，但不输出 channel key。
- 告知服务健康检查、清理释放量和 NewAPI 数据库备份路径。
- 明确 Freebuff 上游账号授权/真实对话尚未完成，需要用户先在 freebuff 控制台添加账号。
- 说明重启造成的短暂中断已结束。
- 记录剩余风险：NewAPI SQLite 回滚备份含敏感配置、BuildKit cache 已清理、其他项目 `/tmp` 和停止容器仍保留。

## 验证命令

```bash
ssh ssh2 'docker inspect freebuff-proxy --format "{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}"'
ssh ssh2 'docker inspect newapi --format "{{.State.Status}}"'
ssh ssh2 'curl -fsS http://127.0.0.1:8787/healthz'
ssh ssh2 'docker exec newapi wget -qSO- --timeout=3 http://172.20.0.1:8787/healthz -O /dev/null'
ssh ssh2 'curl -fsS --resolve freebuff.uwoacrimson.com:443:127.0.0.1 https://freebuff.uwoacrimson.com/healthz'
ssh ssh2 'docker system df'
ssh ssh2 'du -sh /var/cache/apt/archives'
```

## 风险点

- 密码和 NewAPI channel key 必须避免 `set -x`、命令参数、环境变量和日志泄漏。
- NewAPI 停止/启动会产生短暂中断；若启动失败必须用一致性数据库备份回滚。
- SQLite 直接写入绕过管理 UI，必须先停服、备份、参数化插入并重启加载；schema 不符时不得强行写入。
- BuildKit cache 清理不可恢复，但只影响未来构建速度，不影响当前容器。
- 不做全量垃圾清理，避免删除其他服务的停止容器、镜像回滚点和 `/tmp` 工作文件。
