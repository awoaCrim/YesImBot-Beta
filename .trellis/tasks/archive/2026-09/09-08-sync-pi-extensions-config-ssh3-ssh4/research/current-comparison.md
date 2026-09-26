# 本机、ssh3、ssh4 Pi 环境当前对比

日期：2026-09-08。本文记录当前最终状态；ssh3 已完成历史同步，ssh4 只读盘点已完成但尚未同步。

## 当前结论

- **ssh3**：同步已完成并通过当时的最终验收；该事实不因后续 model-preserve 策略更新而改写。
- **ssh4**：host key 已由用户通过可信渠道确认，本机 SSH 信任状态已由此前流程建立；登录和只读 Pi 盘点可用，**尚未执行同步写入或 package 安装**。
- **本轮 skill/task 更新**：只修改和检查本地文件，不连接 ssh3/ssh4，不执行远程命令，不修改 SSH 状态。
- **默认策略**：后续 ssh4 同步必须使用 model-preserve；凭据、真实模型、模型选择/路由/压缩/provider/toolkit/subagent model policy 配置均不进入同步。

## 版本与布局

| 项目 | 本机 | ssh3 | ssh4 |
| --- | --- | --- | --- |
| Pi CLI | `0.85.1` | `0.85.1` | `0.84.3` |
| 状态 | canonical 非模型 source | 已同步 | 只读盘点完成，未同步 |
| prompt 布局 | Pi 用户根目录 | 根目录 | `agent/prompts/` 子目录 |
| 根目录 `keybindings.json` | 存在 | 已同步 | 不存在 |

ssh4 的 Pi CLI 升级不属于环境同步范围。其 CLI 版本相关 settings 字段与不同目录布局都必须保留目标或先由用户决定，不能从本机推断覆盖。

## ssh4 package / 目标独有状态

ssh4 package 集与本机不同，目标独有项包括：

- `pi-intercom`
- `@juicesharp/rpiv-todo`
- `pi-ssh-remote`
- `pi-codex-goal`
- `@gotgenes/pi-subagents`

subagent lineage 在本机、ssh3、ssh4 三方不同；`pi-openai-toolkit` 也存在目标版本 pin 差异。二者都涉及模型/toolkit/model policy 行为，按 model-preserve **保留 ssh4 版本与活动引用**，不安装本机 fork，不卸载或删除目标旧 package。

ssh4 的 sessions、`fff/`、`intercom/`、`powerline-footer/inbox.jsonl`、`ssh-remote-memories/`、`bin/`、cache、backups 和其他运行状态均为 target-owned，不同步、不删除。

## model-preserve 分类

### 永不复制或修改

- `auth.json`
- `pi-web-credentials.json`
- 真实 `models.json` / `models-store.json`（ssh4 当前空状态也保持）
- provider credential fields、API/OAuth/token/authorization/private key
- 模型路由扩展与配置、模型 toolkit 配置、模型 profile 文档
- subagent model policy 配置
- SSH config/keys/agent/`known_hosts`

上述内容只允许存在性/类型/bytes/mtime/可选 hash 元数据核验；报告不记录内容、模型字段值或凭据。

### 可在写入授权后进入 allowlist

- `keybindings.json`：whole-file。
- 逐文件审核后确认非模型、非凭据、无本机绝对路径的 extension：whole-file。
- 经逐包审核且确认非模型的 package source：install-only；ssh4 当前尚无已确认安装项。

### 只能合并或跳过

- `settings.json`：只能 field-merge 确认非模型字段；`packages` / `extensions` 列表不进入字段补丁，模型字段、目标独有字段和 CLI 版本字段保留目标。存在未知嵌套语义或 schema 不兼容时跳过整个文件。
- `AGENTS.md` / `APPEND_SYSTEM.md`：本机文档含模型相关区块且 ssh4 布局不同，禁止整文件覆盖。只有布局决策完成并能安全切分时才允许合并非模型 section，否则 `preserved-target`。

## ssh3 已完成事实与残留风险

ssh3 当时完成了 35 个 allowlist 文件写入、package 安装、备份、hash 验收和临时目录清理；`auth.json`、真实模型文件、trust、sessions/cache/backups、SSH 状态及目标独有文件未变化。

该同步发生在 model-preserve 明确前，以下项目按旧策略进入过整文件 allowlist：

- `settings.json`
- `AGENTS.md`
- `extensions/pi-openai-toolkit/config.json`
- `extensions/model-prompt-router/index.ts`

这是已知历史残留，不得改写成“未发生”。是否从 ssh3 当次备份选择性恢复模型相关项，需要用户单独授权；本轮不执行恢复。

## 仍需用户决定

1. ssh4 prompt 文档使用本机根目录布局，还是保留 ssh4 `agent/prompts/` 布局；无论选择哪种，含模型区块的文档都不能整文件覆盖。
2. 是否仅同步 `keybindings.json`，还是再批准一份逐文件非模型 extension allowlist。
3. 是否有任何 package 经逐包审核后可归为非模型；当前默认安装清单为空。
4. `settings.json` 是否尝试严格的非模型 field-merge，还是直接跳过；未知结构必须跳过。
5. 是否另开 ssh3 模型相关项选择性恢复，以及是否另开 ssh4 Pi CLI 升级任务。
