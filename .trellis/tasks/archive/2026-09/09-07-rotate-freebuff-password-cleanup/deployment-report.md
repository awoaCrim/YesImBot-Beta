# 执行报告：freebuff 密码轮换、NewAPI 接入与缓存清理

执行日期：2026-09-07
目标主机：`ssh2`

## 已完成

### freebuff

- 使用应用自身 `UserStore.setPassword('admin', ...)` 完成管理员密码轮换。
- 密码通过 SSH 标准输入传递，未写入任务文件、`.env`、命令参数或日志；未在报告中保存密码或哈希。
- 重启 `freebuff-proxy` 使用户存储重新加载。
- 容器状态：`running / healthy`。
- 重启策略：`unless-stopped`。
- 本机 `/healthz`：HTTP 200。
- HTTPS `/healthz`：HTTP 200。
- `/opt/freebuff-proxy/data/` 和 `users.json` 仍存在，未删除 Freebuff 凭据或原有用户。

### NewAPI

- 创建普通服务账号：`newapi-bridge`。
- 服务账号的本地随机密码未输出；其 API Key 未输出、未写入任务文件或命令日志。
- 通过该服务账号读取到 15 个 freebuff 模型目录项。
- NewAPI 新增渠道：`freebuff-proxy`。
- 渠道非敏感元数据：
  - `id=58`
  - `type=1`（OpenAI）
  - `status=1`（enabled）
  - `base_url=http://172.20.0.1:8787`
  - 模型列表非空
- NewAPI 渠道数量：由 12 增加到 13。
- NewAPI 数据库备份：

```text
/opt/newapi/staging/one-api.db.bak-20260907T025029Z
```

- 备份权限：`600`；备份中的渠道数量为 12。
- NewAPI 重启后状态：`running`。
- 从 NewAPI 容器访问 `http://172.20.0.1:8787/healthz`：HTTP 200。

### 缓存清理

清理前：

- Docker BuildKit cache：约 5.434GB。
- APT archive cache：约 132MB。
- 本次部署专属 `/tmp/freebuff-*` 文件：0 个。

清理后：

- Docker BuildKit cache：0B。
- APT archive cache：24KB。
- `/tmp/freebuff-*`：0 个。

预计释放空间约 5.56GB。只清理了 BuildKit cache 和 APT cache，没有执行全量 Docker prune。

## 保护范围

- 未删除 `/opt/freebuff-proxy/data/`。
- 未删除 Freebuff 凭据、用户、角色或 API Key。
- 未修改 NewAPI 原有渠道、用户、token 或计费数据；旧渠道数量从备份的 12 条变为当前新增后的 13 条。
- 未删除 Docker volumes、运行中容器、停止容器或未使用镜像。
- 未清理其他项目的 `/tmp` 文件。
- 未修改 Caddy、DNS、防火墙或应用源码。

## 未完成/限制

- 没有读取或验证新密码本身，也没有执行登录测试，避免把密码带入工具输出或日志。
- 没有执行真实 NewAPI 对话测试。freebuff 目前还需要在控制台添加至少一个 Freebuff 上游账号，否则渠道虽已接入，实际对话可能因没有可用上游账号而失败。
- NewAPI 渠道 key 已写入其必要的远端数据库配置，但报告不记录该 key。

## 回滚

- NewAPI：停止 `newapi`，用上述 `one-api.db` 备份恢复数据库后重新启动。
- freebuff：本次未保存旧密码明文或旧 hash，不能自动恢复旧密码；如需再次变更，应使用 freebuff 控制台或同一安全轮换流程。
