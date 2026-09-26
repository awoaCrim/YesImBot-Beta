# 执行计划：cmdcode2api 上游模型刷新按钮

## 阶段 1：代码实现

### 后端

- [x] 在 `internal/app/models.go` 抽取返回 `([]ModelInfo, error)` 的上游抓取函数；对非 200、网络错误、非法 JSON、尾随 JSON 和空目录返回错误，失败时保持旧 catalog。
- [x] 增加 catalog 快照/替换 helper 和 `sync.RWMutex`，更新所有生产读取者：`handler.go`、`admin.go`、`cc.go`、`app.go`。
- [x] 增加刷新 single-flight 保护；重复刷新返回 `409`，不重复请求上游。
- [x] 让刷新提交与 `PUT /admin/api/models` 共用模型变更锁，避免刷新追加默认隐藏项时覆盖用户选择；settings 的模型策略/上游 URL 更新也加入同一提交序列。
- [x] 注册 `POST /admin/api/models/refresh`：使用 enabled primary account 拉取上游，计算 added/removed，保留旧模型暴露状态，新模型追加为精确 `exclude_model_ids`（已有前缀覆盖时不重复追加），持久化失败时恢复旧 catalog/策略。
- [x] 定义非敏感刷新响应：`loaded`、`available`、`added`、`removed`、`newly_hidden`、`refreshed_at`。
- [x] 更新启动/新增账号路径，继续兼容原有 `FetchProviderModels` 调用。

### 前端

- [x] 在模型页标题按钮组加入“从上游刷新模型”按钮。
- [x] 增加刷新函数、POST 调用、成功后重新 GET 模型列表、数量提示和失败提示。
- [x] 请求期间禁用刷新/搜索/全选/全不选/复选框，`finally` 恢复控件；失败不清空现有页面列表。
- [x] 保持搜索、全选、全不选和逐项即时保存语义不变。

### 文档

- [x] 更新 `README.md` 与 `README.zh-CN.md` 的管理 API 列表和模型刷新说明。
- [x] 更新 `.trellis/spec/v7/backend/cmdcode2api-model-catalog.md`，记录新增刷新接口、默认隐藏新模型、精确 ID 兼容和并发契约。

## 阶段 2：测试与本地/远程验证

- [x] 新增 Go 测试覆盖刷新成功、相同目录、ID trim/dedup、尾随 JSON、上游 500/网络/非法 JSON/空目录、无账号、鉴权失败、配置保存失败回滚和精确 ID 碰撞。
- [x] 新增并发刷新测试，断言第二次请求得到 `409` 且上游只收到一次请求。
- [x] 新增刷新与模型暴露 PUT 竞争测试，断言不丢用户选择；补充 catalog/policy 快照一致性和 config exact-ID round-trip 测试。
- [x] 使用 Go 1.25 Docker 工具链运行 `go test ./...`、`go vet ./...` 和 `CGO_ENABLED=1 go test -race ./...`；ssh2 宿主机 Go 1.19.8 未作为验证工具链。Go 1.25.14 Linux/amd64 最终全部通过。
- [x] 从 `internal/web/index.html` 提取内嵌 JavaScript，运行 `node --check` 并通过定向检查。
- [x] 静态检查按钮 ID、事件绑定、POST 路径、成功/失败状态恢复；远程 WebUI marker 检查通过。

## 阶段 3：ssh2 备份与部署

- [x] 在 ssh2 创建带时间戳的备份目录 `/opt/cmdcode2api/backups/20260910T101553Z`，保存 `/opt/cmdcode2api/src`、`data/config.yaml`、`docker-compose.yml`、当前容器 inspect 和镜像摘要；敏感文件只留在远程，备份文件 mode 600。
- [x] 在 Go 1.25 Docker 环境通过测试后，构建新镜像 `cmdcode2api:refresh-button-20260910T101553Z`；不覆盖当前生产 tag，旧镜像仍保留。
- [x] 备份 Compose 后只替换 `cmdcode2api` 的镜像 tag，运行 `docker compose up -d --force-recreate cmdcode2api`，未操作其他容器。
- [x] 容器恢复 running，`/health` 返回 `{"status":"ok"}`，管理员 GET 模型接口和新增 POST 刷新接口均可用。
- [x] 使用远程脚本验证官方目录、管理目录、刷新摘要和 `/v1/models`；只输出数量/状态/摘要，不输出 key、密码或完整配置。
- [x] 验证刷新新增模型默认隐藏、原有模型开放状态保持；生产实测 catalog `69`、admin exposed `2`、public count `2` 且集合一致，刷新响应为 `loaded=69 available=2 added=0 removed=0 newly_hidden=0`。

## 阶段 4：回滚点

- [x] 若测试或构建失败，不切换生产镜像；本次最终验证通过后才部署。
- [x] 若部署或健康检查失败，保留旧 Compose/镜像 tag，可按 `/opt/cmdcode2api/backups/20260910T101553Z` 回滚；本次未触发回滚。
- [x] 保留新旧镜像和远程备份，未执行 Docker 全局清理。

## 完成定义

- [x] 模型页存在一键上游刷新按钮。
- [x] 刷新无需重启即可更新管理台模型目录。
- [x] 新模型默认隐藏，用户可手动开放；旧模型状态不被破坏。
- [x] 并发、错误、回滚和敏感信息保护验证通过。
- [x] ssh2 生产部署完成，服务健康，相关 API 验证通过。

## 完成记录（2026-09-10）

- 本地 Windows Go `1.26.5`：`go test ./... -count=1` 通过（192 tests）；Linux/amd64 无 CGO 构建通过。
- ssh2 Go `1.25.14` Docker 工具链：普通测试、`go vet`、race 测试全部通过；race 容器临时安装 `gcc`/`musl-dev`，未改生产容器。
- 远程运行时：镜像 digest `sha256:2bc3f9a461a6daa9768f5a1ef5d13c9bed2059c2d5b3de4d74b33fab87f1c320`，容器 `restart=0`；配置 hash 与部署前备份一致，config/Compose mode `600`，日志错误/凭据扫描无输出。
