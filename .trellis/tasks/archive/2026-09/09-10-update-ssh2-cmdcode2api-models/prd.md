# 更新 ssh2 上 cmdcode2api 模型列表

## Goal

根据 CommandCode 官方可用模型目录，修正 ssh2 上 `cmdcode2api` 的模型目录，使管理台能看到完整的当前官方模型集合；模型是否实际对外开放由用户在管理台自行选择。

## Background / Confirmed Facts

- 目标服务位于 ssh2：`/opt/cmdcode2api`。
- 运行容器名为 `cmdcode2api`，镜像为 `cmdcode2api:custom-usage`；数据配置文件为 `/opt/cmdcode2api/data/config.yaml`。
- 服务代码在启动或新增账号时从 CommandCode 的 `/provider/v1/models` 拉取目录；`exclude_models` 同时决定模型是否出现在 `/v1/models` 以及是否允许调用。
- 2026-09-10 通过 ssh2 上两个已配置账号请求官方 provider models endpoint，均返回一致的 69 个模型。
- 当前 `config.yaml` 有 67 个精确 `exclude_models` 条目，没有发现已排除但已不在官方目录中的条目；当前配置只留下两个模型未排除：
  - `deepseek/deepseek-v4.1-flash`
  - `inclusionai/ling-3.0-flash-sante:free`
- 当前运行实例的 `/v1/models` 返回 HTTP 200，但 `data` 为空，说明进程内模型目录尚未正常加载；需要重新加载/重启并验证。
- 官方静态页面、CLI 参考页和账号实际 provider endpoint 可能因更新时间或账号能力出现数量差异；本任务以服务实际调用的官方 `/provider/v1/models` 目录作为运行时同步依据。官方文档也明确说明该 endpoint 用于运行时获取 live models list。

## Requirements

### R1. 官方目录同步

以 CommandCode 官方 provider models endpoint 返回的模型 ID 为基准，获取当前 ssh2 两个账号的目录并确认结果一致；账号凭据保持不变。

### R2. 只更新目录，不自动开放模型

按用户确认：将官方 provider endpoint 当前返回的完整模型目录加载到 `cmdcode2api` 管理台，但不自动修改现有 `exclude_models` 暴露策略。用户后续自行在 WebUI「模型」页勾选要开放的模型。

### R3. 可回滚操作

修改前备份当前 `config.yaml`，记录当前容器/镜像状态和模型目录；不得删除账号、客户端密钥、管理密码或用量数据。

### R4. 运行验证

完成目录加载后验证：服务仍在运行、健康检查成功、管理 API 能看到官方完整目录；`/v1/models` 的实际暴露集合保持现有策略，不因本次同步被批量开放。

### R5. 异常处理

若官方目录请求、配置写入、重启或验证失败，停止进一步修改并使用备份回滚；最终报告变更前后模型数量、暴露集合和验证结果。

## In Scope

- ssh2 上 `/opt/cmdcode2api` 的官方模型目录刷新。
- 必要的配置备份、容器重启/加载和只读 API 验证。
- 保留现有模型暴露策略，供用户后续自行勾选。
- 记录官方目录与实际运行目录的差异。

## Out of Scope

- 代替用户勾选或开放任何模型。
- 修改 CommandCode 账号、API key、客户端 key、管理密码或代理配置。
- 修改 `cmdcode2api` 业务代码、Docker 镜像构建逻辑或上游账号权限。
- 更新其他服务器（如 ssh3）上的服务。
- 删除历史备份、用量数据或旧配置。

## Key Decision

用户先选择了完整官方目录范围，随后明确“我自己开放就行”。因此本任务只负责让服务加载/展示当前官方 provider endpoint 的完整模型目录，不自动清空 `exclude_models`，也不扩大当前 `/v1/models` 的暴露集合。如果官方目录在实际执行时发生变化，以执行时从两个 ssh2 账号获取并相互验证一致的结果为准，并在最终报告中记录实际数量和集合。

## Acceptance Criteria

- [x] 远程修改前存在带时间戳的 `config.yaml` 备份，且原文件中的账号、密钥、管理密码和用量文件未被删除或改写。
- [x] 官方 provider endpoint 在执行时可用，两个已配置账号返回的模型 ID 集合一致。
- [x] `cmdcode2api` 重新加载后，管理模型目录包含执行时官方 endpoint 返回的全部模型。
- [x] 现有 `exclude_models` 暴露策略未被自动清空或批量改写；用户可在 WebUI 中自行选择。
- [x] `cmdcode2api` 容器重启后保持运行，镜像未被无必要地更换。
- [x] `/health` 返回成功。
- [x] `/v1/models` 返回 HTTP 200，且其集合等于“官方目录减去当前排除项”的结果，而不是无条件全部开放。
- [x] 验证未发现模型集合差异、配置损坏或其他容器受到影响；失败时可按备份回滚。
