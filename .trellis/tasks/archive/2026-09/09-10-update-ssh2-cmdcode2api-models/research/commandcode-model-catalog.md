# CommandCode 模型目录研究

> 研究日期：2026-09-10
> 任务：`update-ssh2-cmdcode2api-models`

## 结论

1. CommandCode 官方 Provider API 文档将 `GET https://api.commandcode.ai/provider/v1/models` 定义为模型列表 endpoint，并明确建议在运行时获取 live models list。
2. CommandCode 官方模型页、CLI 参考页和账号实际 endpoint 的目录数量可能随发布时间或账号能力变化，因此 ssh2 运行时同步应以两个已配置账号实际返回且相互一致的 provider endpoint 集合为准。
3. 2026-09-10 在 ssh2 的 `cmdcode2api` 容器内使用两个已配置账号分别请求官方 endpoint：两次返回均成功，模型 ID 集合一致，共 69 个模型。
4. ssh2 的 `cmdcode2api` 代码将目录保存在进程内的 `modelCatalog`：启动时由 `app.go` 调用 `FetchProviderModels`，使用启用账号池的 primary account；新增账号且目录为空时也会触发拉取。目录不会持久化到配置文件，因此当前 `/v1/models` 空列表需要通过重启或新增账号触发重新加载。
5. `exclude_models` 是暴露策略，而不是上游目录本身：它会同时影响 `/v1/models` 和请求调用；管理 API `/admin/api/models` 则返回已加载的完整目录及每个模型的 exposed 状态。
6. 用户已确认只刷新完整官方目录，模型是否开放由用户在 WebUI 中自行勾选。因此本任务不清空、不重排、不批量修改 `exclude_models`，只做备份、重启和集合验证。

## 远程证据

- 目标目录：`ssh2:/opt/cmdcode2api`
- 数据配置：`/opt/cmdcode2api/data/config.yaml`
- 容器：`cmdcode2api`
- 镜像：`cmdcode2api:custom-usage`
- 预检时两个账号 provider endpoint 响应：成功，均为 69 个模型，集合无差异。
- 预检时 `GET /v1/models`：HTTP 200，但 `data` 为空。
- 预检时配置：67 个精确 `exclude_models` 条目；当前未排除的两个 ID 为 `deepseek/deepseek-v4.1-flash` 和 `inclusionai/ling-3.0-flash-sante:free`。这些是暴露状态基线，不是本次要自动开放的集合。

## 官方来源

- Command Code Docs — **Provider API**：说明 Provider endpoint、`GET /provider/v1/models` 以及运行时获取 live models list 的方式。
- Command Code Docs — **Available Models**：说明 CLI 的模型列表来自模型 registry，并列出当前 CLI 可用模型 ID。
- Command Code — **Every model in Command Code**：官方模型页的静态目录/价格展示。

由于官方静态模型页、CLI 参考页和实际 provider endpoint 属于不同展示/权限边界，执行阶段不应手工从网页抄录列表，也不应依据静态页面数量强行覆盖账号实际返回结果。

## 验证要求

执行阶段应在远程容器内完成以下集合比较，避免把凭据带回本地：

```text
官方账号 1 /provider/v1/models == 官方账号 2 /provider/v1/models
官方集合 == /admin/api/models 的完整目录
/v1/models == 官方集合 - 当前 exclude_models
```

只输出数量、模型 ID 差异和状态码；不输出 API key、管理密码、完整配置或带凭据的请求头。
