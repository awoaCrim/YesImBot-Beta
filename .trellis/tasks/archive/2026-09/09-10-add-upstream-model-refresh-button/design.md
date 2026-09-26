# 技术设计：cmdcode2api 上游模型刷新按钮

## 1. 变更边界

### 最小行为缺口

模型目录目前只在进程启动或新增首个账号时拉取；模型页只能读取已有目录，无法在不重启容器的情况下获取 CommandCode 新增/移除的模型。

### 行为实际所在位置

- 上游请求与进程目录替换在 `internal/app/models.go`。
- 管理 API 注册和 `exclude_models` 持久化在 `internal/app/admin.go`。
- `/v1/models` 与模型名解析在 `internal/app/handler.go`、`internal/app/cc.go`。
- 模型页渲染和事件绑定在 `internal/web/index.html`。

### 预计变更文件

- `internal/app/models.go`：拆分可返回错误的上游抓取函数；增加 catalog 快照/原子替换和刷新状态所需的同步保护。
- `internal/app/admin.go`：注册 `POST /admin/api/models/refresh`，实现 primary 账号选择、差异计算、默认隐藏新模型、失败回滚和非敏感摘要响应；让模型暴露 PUT 与刷新提交互斥。
- `internal/app/handler.go`、`internal/app/cc.go`、`internal/app/app.go`：将生产读取路径改为 catalog 快照读取，避免刷新时 data race。
- `internal/app/*_test.go`：补充刷新成功/失败/并发/持久化和快照读取测试。
- `internal/web/index.html`：增加按钮、忙碌态、提示和刷新后重新加载。
- `README.md`、`README.zh-CN.md`：补充管理 API 与模型刷新说明。
- `internal/app/types.go`：如需要，定义刷新响应 DTO；优先放在最贴近 API 的文件，避免无必要公共抽象。

不修改模型转发协议、账号凭据、代理、计费、Dockerfile 或其他页面。

## 2. 数据流与边界契约

```text
管理员点击按钮
  -> POST /admin/api/models/refresh
  -> adminAuth
  -> refresh single-flight guard
  -> AccountPool.Primary()
  -> GET {base_url}/provider/v1/models
  -> decode + reject non-2xx/empty catalog
  -> calculate old/new ID sets
  -> keep old exposure; add new IDs to exclude_models
  -> persist config if exclusions changed
  -> replace in-memory catalog atomically
  -> return refresh summary
  -> UI GET /admin/api/models
  -> render server-authoritative exposed state
```

### Refresh response

建议成功响应：

```json
{
  "loaded": 69,
  "available": 2,
  "added": 1,
  "removed": 0,
  "newly_hidden": 1,
  "refreshed_at": "2026-09-10T08:00:00Z"
}
```

字段只表达数量、时间和状态，不返回上游原始响应或任何凭据。失败统一使用现有 `{"error":"..."}` 管理 API 格式。

### HTTP 状态

- `200`：刷新成功。
- `409`：已有刷新进行中，防止并发请求重复打上游。
- `502`：上游网络、HTTP 状态、JSON 解析或空目录失败。
- `503`：没有可用的 primary CommandCode 账号。
- `500`：上游目录已获取，但配置持久化失败；必须回滚内存目录和排除列表。

## 3. 后端实现策略

### 3.1 抓取函数

将现有逻辑拆成类似以下职责：

```go
func fetchProviderModels(baseURL, apiKey string) ([]ModelInfo, error)
func FetchProviderModels(baseURL, apiKey string) // 启动/兼容调用的日志包装
```

`fetchProviderModels`：

- 使用现有 15 秒 HTTP timeout。
- 非 200、网络错误、JSON 解码错误和空 `data` 返回错误。
- 不读取或拼接上游敏感错误正文到客户端。
- 只有成功拿到非空目录后才允许替换 `modelCatalog`。

### 3.2 Catalog 并发安全

- 增加 `modelCatalogMu sync.RWMutex`。
- `modelCatalogSnapshot()` 返回值切片副本；`availableModels`、`handleModels`、admin GET/overview、`resolveModelName` 全部使用快照。
- `replaceModelCatalog()` 在写锁下替换完整切片，不能边遍历边修改。
- 保持测试对 `modelCatalog` 的直接赋值兼容；生产代码不再直接遍历全局切片。

### 3.3 刷新与暴露保存互斥

- 增加刷新 single-flight guard（建议 `sync.Mutex.TryLock` 或 `atomic.Bool`），并发刷新直接返回 `409`，不产生第二次上游请求。
- 增加共享的模型变更提交锁，刷新提交和现有 `PUT /admin/api/models` 共用，避免刷新追加新排除项时覆盖用户刚保存的暴露选择。
- 上游请求尽量在共享提交锁之外完成；成功后重新读取最新 `cfg.Excludes()`，在短提交区间内计算并保存。

### 3.4 暴露状态规则

设 `oldCatalog` 为刷新前内存目录，`newCatalog` 为新目录：

- `oldID ∩ newID`：完全按当前 `exclude_models` 计算，状态不变。
- `newID - oldID`：若已有排除项（包括 provider-qualified 或短 ID 前缀）覆盖，则保持；否则追加该完整 ID 到 `exclude_models`，默认隐藏。
- `oldID - newID`：从 catalog 消失；原排除项不主动删除，以保留现有未知模型保护行为。
- 如果保存新排除项失败，恢复 `oldCatalog` 和 `oldExcludes`，再返回 `500`。

当进程启动后 catalog 为空时，刷新得到的模型全部视为新模型并默认隐藏；这是安全优先的 fallback，避免空 catalog 状态下意外开放全部上游模型。

## 4. 前端实现策略

- 在模型页标题的现有按钮组加入 `#model-refresh-btn`，不改变搜索/全选/全不选布局语义。
- 添加 `refreshModels()`：
  1. 检查本地刷新状态，避免重复调用；
  2. 禁用刷新、全选、全不选和模型复选框，按钮显示“拉取中…”；
  3. 调用 `POST /admin/api/models/refresh`；
  4. 成功后调用 `loadModels()`，以服务端的 `exposed` 状态重新渲染；
  5. toast 显示加载/新增/移除/默认隐藏数量；
  6. 失败时不清空 `state.models`，显示错误并恢复控件；
  7. `finally` 恢复按钮文字和控件状态。
- `loadModels()` 保留现有调用方行为；刷新路径需要能区分 GET 失败并给出提示。
- 模型保存请求期间刷新按钮也必须被禁用，或者由后端共享提交锁保证不会覆盖；优先两端同时保护。
- 不在前端自行推断新模型的开放状态；服务端返回的 `exposed` 是唯一渲染依据。

## 5. 测试设计

### 后端

使用现有 `newAdminTestEnv` 和 `httptest.Server`：

1. 成功刷新：旧暴露模型保持暴露，旧隐藏模型保持隐藏，新模型出现在 catalog 且被追加到 `exclude_models`，响应数量正确。
2. 相同目录刷新：不产生重复排除项，不改变配置选择，但可以更新上下文窗口等元数据。
3. 上游 500、网络错误、非法 JSON、空目录：返回非 2xx，catalog 和 exclusions 完全保持旧值。
4. 无 enabled primary：返回 503，不发上游请求。
5. 配置保存失败：返回 500，catalog 和 exclusions 回滚。
6. 并发刷新：阻塞上游响应，第二次请求返回 409，服务端只收到一次上游请求。
7. 刷新与模型 PUT 竞争：最终配置包含用户最新暴露选择以及新模型默认隐藏项，不丢更新。
8. `modelCatalog` 快照在刷新并发读取时通过 `go test -race`。

### 前端

- 从 HTML 提取内嵌脚本运行 `node --check` 或等效语法检查。
- 静态/定向检查按钮 ID、事件绑定、POST 路径、成功/失败 finally 恢复控件。
- 如已有浏览器测试入口，验证模型页点击一次、重复点击、成功重载和失败保留列表。

## 6. 部署与回滚

1. 在 ssh2 创建带时间戳的源码、配置、Compose 和当前镜像元数据备份；不把敏感配置带回本地。
2. 先用 Go 1.25 Docker 工具链运行测试，再构建新的镜像 tag；不覆盖当前生产 tag。
3. 备份 Compose 后切换到新镜像，使用 `docker compose up -d --force-recreate cmdcode2api` 只重建目标容器。
4. 验证容器 running、`/health`、`GET /admin/api/models`、`POST /admin/api/models/refresh`、新模型默认隐藏以及原有模型请求路径。
5. 失败时恢复旧 Compose/镜像引用，按备份恢复源码/配置（若被改写），重启并验证健康状态。
6. 部署完成后保留远程备份和版本化镜像，不执行 Docker 全局清理。
