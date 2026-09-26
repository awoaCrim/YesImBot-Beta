# ssh2 密码轮换、NewAPI 接入与清理范围研究

## freebuff 密码轮换

只读检查确认：

- 服务目录：`/opt/freebuff-proxy`。
- 容器：`freebuff-proxy`，当前 healthy，挂载 `/opt/freebuff-proxy/data -> /data`。
- 用户存储由 `/app/src/web/user-store.js` 管理，数据文件是 `/data/users.json`。
- `UserStore.setPassword(username, password)` 会重新生成 salt 和 scrypt password hash，然后原子替换 users.json；不会重置 API Key 或角色。
- 管理员用户管理 API 需要现有会话，因此不直接依赖旧密码执行轮换。

## NewAPI 接入

- NewAPI 容器：`newapi`，运行在 `shared-app-network`；宿主机网关为 `172.20.0.1`。
- 从 NewAPI 容器访问 `http://172.20.0.1:8787/healthz` 返回 HTTP 200。
- 数据库：`/opt/newapi/data/one-api.db`，当前 12 条渠道记录；NewAPI 现有渠道和用户不应被修改。
- NewAPI 源码中的 `ChannelTypeOpenAI` 是 `1`；OpenAI relay 使用 `base_url + request_path`，因此 freebuff 渠道 base URL 应是 `http://172.20.0.1:8787`，不带 `/v1`。
- freebuff `/v1/models` 需要 API Key；计划新增普通服务账号 `newapi-bridge`，通过内存管道把它的 API Key 写入新渠道，不输出 key。
- NewAPI 渠道写入前需要停止容器并创建 SQLite 一致性备份；成功后重启以刷新渠道缓存。

## 清理证据

- `docker system df`：Build Cache 约 `5.434GB`，全部可回收。
- APT archive cache 约 `132MB`。
- 当前无 dangling image。
- 有两个历史 `caimogu-bot-before-*` 停止容器，属于其他部署，不删除。
- `/tmp` 有大量其他项目文件和日志，无法安全归属于本次 freebuff 部署，不全量清理。
- freebuff 本次部署的临时健康检查文件不存在；应用代码目录仅约 `1.3MB`（不含 data）。

## 安全结论

- 密码应通过 SSH stdin 送入容器内一次性 Node 脚本，避免命令参数、环境变量、`.env` 和任务文件中的明文。
- NewAPI key 通过同一远程脚本的内存变量/参数绑定流转，不输出、不写本地文件；远端数据库中的 channel key 受文件权限保护。
- 只清理 BuildKit cache、APT archive cache 和明确的 `/tmp/freebuff-*` 文件。
- 不执行 `docker system prune`、`docker image prune -a`、`docker volume prune`，不删除容器、应用 data、NewAPI 数据库或 Caddy 数据。
