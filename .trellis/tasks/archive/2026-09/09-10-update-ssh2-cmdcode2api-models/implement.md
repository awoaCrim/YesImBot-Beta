# 执行计划：刷新 ssh2 cmdcode2api 模型目录

## 前置条件

- [x] 任务 artifacts 完成并经过用户最终规划批准。
- [x] 用户确认：同步完整官方目录，但模型开放由用户自行完成。

## 有序步骤

### 1. 预检与基线

- [x] 确认 ssh2 可通过 `ssh2` 登录，目标目录为 `/opt/cmdcode2api`，容器名为 `cmdcode2api`。
- [x] 记录容器 ID、镜像 ID、运行状态、启动时间，以及其他容器清单；未输出容器环境变量。
- [x] 记录 `/opt/cmdcode2api/data/config.yaml` 的 SHA-256 和文件权限。
- [x] 在容器内用两个已配置账号请求官方 `/provider/v1/models`，只输出 ID、数量和集合差异；账号密钥只在 ssh2 容器内使用。
- [x] 记录 `/health`、管理模型目录和带客户端 key 的 `/v1/models` 基线数量。

### 2. 创建远程回滚点

- [x] 创建带 UTC 时间戳的远程备份：`/opt/cmdcode2api/data/config.yaml.bak-model-refresh-20260910T082855Z`。
- [x] 确认备份权限为 `600`、大小为 `2378` 字节，并与修改前配置逐字节一致。
- [x] 保存并核对 `exclude_models` 数量/集合；未输出任何凭据。

### 3. 触发模型目录刷新

- [x] 未调用 `PUT /admin/api/models`，未清空或批量重排 `exclude_models`。
- [x] 未修改 `config.yaml`、账号、密钥、代理、usage 或 Docker 镜像。
- [x] 执行 `docker restart cmdcode2api`，触发 `FetchProviderModels` 重新加载官方目录。

### 4. 运行验证

- [x] 容器恢复 running，容器 ID 和镜像 ID 未变化，其他容器的名称/镜像集合未变化。
- [x] `/health` 返回 `{"status":"ok"}`。
- [x] 启动日志确认：`models: 69 loaded from https://api.commandcode.ai/provider/v1/models`，并显示 `models: 69 loaded, 2 available`；未发现本次启动的模型抓取失败。
- [x] `/admin/api/models` 返回 69 个模型，集合与两个官方账号的 69 个模型完全一致。
- [x] `/v1/models` 返回 2 个模型，集合等于官方 69 个模型减去原有 `exclude_models`，没有因本次刷新批量开放。
- [x] 配置 SHA-256、`exclude_models` 集合、镜像 ID 和运行环境不变量均保持不变。
- [x] 本地操作临时目录已清理；远程只保留有意创建的配置备份。

### 5. 异常与回滚

- [x] 本次未触发回滚；服务重启和集合验证均通过。
- [x] 回滚路径已保留：恢复上述备份为 `config.yaml` 后重启 `cmdcode2api`，再验证 `/health`。

## 实际执行结果

- 执行时间：2026-09-10 08:28:55Z 起。
- 官方账号 1：69 个模型；官方账号 2：69 个模型；集合一致。
- 重启前 `/v1/models`：0 个模型。
- 重启后管理目录：69 个模型。
- 重启后预期暴露集合：2 个；实际 `/v1/models`：2 个；集合一致。
- 容器：`cmdcode2api` running；镜像保持 `cmdcode2api:custom-usage`，镜像 digest 未变化。
- 配置：SHA-256 保持为 `71b85caf6aa0d6e09fca6f916d6a0ea823679dee1463c99d19684d4e36d5bf7b`；备份权限为 `600`。
- 结果：成功。用户可以继续通过 WebUI「模型」页自行勾选要开放的模型。

## 验证命令要点

所有读取 API key / 管理密码的命令均在 ssh2 容器内执行，并且只输出数量、集合差异和状态码。没有使用 `set -x`，没有输出完整 `config.yaml`，没有把带凭据的请求头写入 shell 历史或任务文件。

官方响应、管理 API 响应和本地 API 响应只在远程临时文件中处理；比较完成后已删除临时文件。模型 ID 可以用于集合校验，凭据和完整配置不进入任务报告。

## 完成定义

- [x] 远程服务恢复运行。
- [x] 管理 API 能看到执行时官方 provider endpoint 的完整模型目录。
- [x] 现有暴露限制保持不变，用户可以随后自行在 WebUI 勾选模型。
- [x] `/health` 和模型集合验证通过。
- [x] 远程备份路径、实际目录数量、暴露数量和验证结果已记录。
