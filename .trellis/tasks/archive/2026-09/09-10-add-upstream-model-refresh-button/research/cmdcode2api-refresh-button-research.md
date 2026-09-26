# cmdcode2api 上游模型刷新按钮研究

> 研究日期：2026-09-10
> 目标：ssh2 `/opt/cmdcode2api`

## 当前实现

- `internal/app/models.go`：`FetchProviderModels(baseURL, apiKey)` 请求 `${baseURL}/provider/v1/models`，将结果写入进程级 `modelCatalog`；当前返回值为 `void`，失败只写日志。
- `internal/app/app.go`：服务启动时使用 `AccountPool.Primary()` 的账号调用 `FetchProviderModels`。
- `internal/app/admin.go`：目前只有 `GET /admin/api/models` 和 `PUT /admin/api/models`。GET 遍历 `modelCatalog` 并按 `exclude_models` 计算 `exposed`；PUT 把用户提交的 exposed ID 转换为 `exclude_models` 后写回配置。
- `internal/app/handler.go`：`GET /v1/models` 遍历 `modelCatalog`，过滤命中 `exclude_models` 的模型。
- `internal/app/cc.go`：`resolveModelName` 直接遍历 `modelCatalog` 做无 provider 前缀的模型名解析。
- `internal/web/index.html`：模型页已有搜索、全选、全不选、逐项勾选即时保存；`loadModels()` 只调用 GET，空目录显示“模型目录为空（上游未返回）”。

## 关键约束

1. 刷新是管理员操作，应复用现有 `/admin/` 管理认证，不新增客户端 API key 认证路径。
2. 模型列表和暴露权限是两个概念。刷新要更新上游 catalog，但不能把新模型直接放入 `/v1/models`；新增 ID 应默认隐藏并由用户手动勾选。
3. `modelCatalog` 当前有多个生产读取者，新增运行时刷新会暴露 data race；必须提供快照读取和受控替换。
4. 刷新与 `PUT /admin/api/models` 都可能持久化 `exclude_models`，需要共享模型变更锁或等效的提交序列化，避免刷新覆盖用户刚保存的选择。
5. 上游请求、空目录、无 primary 账号、JSON 解析失败和配置写入失败都要保持旧 catalog/旧排除状态，并返回可理解的非 2xx 错误。
6. 当前源码 `go.mod` 要求 Go 1.25；ssh2 宿主机只有 Go 1.19.8，宿主机 `go test ./...` 会因 `http.Request.PathValue` 编译失败。实现后需使用 Go 1.25 Docker 工具链或 Docker build 环境测试。

## 推荐的数据流

```text
WebUI refresh button
  -> POST /admin/api/models (refresh endpoint)
  -> adminAuth
  -> refresh lock / primary account
  -> fetch + validate non-empty upstream catalog
  -> catalog snapshot diff
  -> append only newly discovered IDs to exclude_models
  -> atomically replace catalog and persist config
  -> return loaded/added/removed/newly_hidden/available/refreshed_at
  -> GET /admin/api/models
  -> render checked/unchecked states
```

## 测试方向

- 测试成功刷新：旧模型状态不变，新模型进入 catalog 且默认未暴露。
- 测试上游 500、空 `data`、网络错误、无账号和保存失败：旧 catalog 和配置不变。
- 测试两次并发刷新：只有一个上游请求，另一个返回冲突/忙碌状态。
- 测试 `/admin/api/models`、`/v1/models`、`resolveModelName` 与刷新并发时无竞态。
- 测试前端按钮忙碌态、成功后重新载入、失败保留现有列表、恢复可点击。

## 部署约束

- 先备份 ssh2 源码、`config.yaml`、Compose 和当前镜像元数据。
- 使用新的镜像 tag 构建，不覆盖当前生产镜像 tag；测试与构建通过后再更新 Compose 并重建目标容器。
- 部署后验证 `/health`、管理员 GET/POST 模型接口、完整管理目录、新模型默认隐藏、既有暴露集合和基础请求路径。
- 失败时恢复 Compose/源码/镜像引用并重启；不删除 usage、账号、密钥或历史备份。
