# 技术设计：刷新 ssh2 cmdcode2api 模型目录

## 1. 变更边界

最小行为缺口是：`cmdcode2api` 的模型目录保存在进程内存中，当前实例的 `/v1/models` 返回空 `data`；服务重启时才会从 CommandCode 官方 provider endpoint 重新拉取目录。目标是刷新进程内目录并让管理台看到完整官方目录，同时不改变现有模型暴露选择。

本任务不修改业务代码、不构建新镜像、不改账号或任何凭据。预计只会在 ssh2 做一份远程配置备份和一次目标容器重启；正常情况下不改写 `config.yaml`。

## 2. 现有数据流与契约

```text
CommandCode /provider/v1/models
        │  每个已启用账号返回 JSON model IDs
        ▼
cmdcode2api 启动时 FetchProviderModels(primary account)
        │  写入进程内 modelCatalog
        ├── GET /admin/api/models：返回完整目录 + exposed 状态
        └── GET /v1/models：只返回未命中 exclude_models 的目录项
```

- 官方目录基准：执行时通过两个 ssh2 账号访问 `/provider/v1/models`，要求 ID 集合一致。
- 目录展示边界：`/admin/api/models` 使用 `modelCatalog` 全量数据，适合确认“列表已刷新”。
- 对外暴露边界：`/v1/models` 继续应用当前 `exclude_models`，因此本任务完成后不应自动变成全量开放。
- 配置边界：`exclude_models` 仍是用户后续在 WebUI「模型」页自行调整的持久化来源。

## 3. 执行方案

1. **预检**
   - 确认 ssh2 目标目录、容器名、镜像 ID、运行状态和监听端口。
   - 从两个已配置账号分别请求官方 provider endpoint，只在远程临时文件中保存响应；输出只保留模型 ID、数量和集合差异，不输出凭据。
   - 记录当前 `config.yaml` 的 SHA-256、`exclude_models` 数量，以及 `/health`、`/v1/models` 的基线结果。
2. **远程备份**
   - 在 `/opt/cmdcode2api/data/` 创建带 UTC 时间戳的 `config.yaml` 备份，保留原权限。
   - 不把包含凭据的配置备份复制到本地仓库或最终回复。
3. **刷新目录**
   - 不调用模型暴露管理 API，不清空或重排 `exclude_models`。
   - 使用 `docker restart cmdcode2api` 让现有镜像重新启动，并触发 `app.go` 中对 primary account 的 `FetchProviderModels`。
4. **验证**
   - 等待容器恢复运行并检查启动日志中的模型加载数量。
   - 用远程脚本在容器内分别请求：官方 provider endpoint、`/admin/api/models`、带客户端 key 的 `/v1/models`。
   - 比较官方集合与管理 API 的完整目录；比较 `/v1/models` 与“官方集合减去当前排除项”的结果。
   - 确认 `config.yaml` hash、`exclude_models` 及镜像 ID 未被本任务改变，其他容器仍正常运行。

## 4. 兼容性与风险

- **官方目录变化**：执行时目录可能不再是 69 个；以执行时两个账号都返回的实际集合为准，并在报告中记录实际数量。
- **账号权限差异**：若两个账号返回集合不一致，不擅自取并集或修改配置，先停止并报告差异。
- **上游请求失败**：若官方 endpoint 不可访问，重启不会产生可信目录；验证失败时不继续做暴露调整。
- **重启期间短暂不可用**：仅重启 `cmdcode2api`，不重建镜像、不触碰其他容器；需等待健康检查恢复。
- **配置保护**：配置含账号与密钥，所有读取命令必须在远程完成脱敏处理，禁止将配置全文写入日志、研究文件或聊天。

## 5. 回滚

如果重启后服务无法恢复、配置校验失败或目录验证不一致：

1. 保留失败现场日志和当前容器状态摘要，不删除备份。
2. 将本次备份恢复为 `/opt/cmdcode2api/data/config.yaml`，保留 `0600` 权限。
3. 重启 `cmdcode2api`，重新验证 `/health` 和基础 API。
4. 若官方目录本身不一致，则保持服务恢复状态，不自动修改模型暴露策略，并将差异交给用户决定。
