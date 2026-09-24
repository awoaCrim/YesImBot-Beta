# Pi 用户环境迁移指南

> 适用于将本机 Pi CLI 的可复用用户级环境同步到 Windows SSH 主机。默认安全策略是 **model-preserve**；本指南不授权迁移凭据、模型配置、登录态或 Pi Web。

## 1. Scope / Trigger

- **触发条件**：用户要求把本机 Pi CLI 环境同步、迁移或恢复到远程 Windows 主机。
- **默认可同步**：`keybindings.json`、逐文件审核通过的非敏感非模型 extension、`settings.json` 中确认非模型的字段、确认不含模型区块的 prompt 文档或其非模型 section、经逐包审核的非模型 package source。
- **非默认项**：全局 skills/agents 只有在用户单独授权并建立逐文件 allowlist 后才能加入。
- **默认保护**：认证/凭据、真实模型文件、模型选择/路由/压缩/provider/toolkit/subagent model policy 配置、项目/运行时状态、SSH 状态、Pi 安装目录和 `node_modules`。
- **安全原则**：先本机盘点和分类，再远程只读预检；只对显式 allowlist 做备份和合并；无法分类即跳过，不扩大复制范围。
- **不可降级**：普通环境同步不能把 model-preserve 项改列为可同步。若用户以后要迁移模型定义或模型策略，必须另开迁移设计；凭据仍永不复制。

## 2. Merge modes

每个候选必须先归入一种方式，未分类项不得进入 staging：

| Mode | 内容 | 契约 |
| --- | --- | --- |
| `whole-file` | `keybindings.json`、审核后的非模型 extension；两侧均确认无模型区块的 prompt 文档 | 可按文件覆盖，禁止目录递归复制 |
| `field-merge` | `settings.json` 的确认非模型字段 | 禁止整文件覆盖；`packages` / `extensions` 列表不进入字段补丁；未知嵌套语义导致整个文件跳过 |
| `section-merge` | 含模型区块的 prompt 文档 | 只写确认非模型 section；标记缺失、嵌套或布局未决时保留目标版本 |
| `install-only` | 经逐包审核的非模型 package source | 只通过 `pi install <source> --no-approve`；模型策略包与不确定包不安装 |

目标原有字段、文件、package 和安装目录不能因 source 缺失而删除。

## 3. Signatures

### 本机 staging

```text
python <task>/.local_stage.py
```

输出只允许包含版本、数量、文件类别、相对路径/hash 和通过/失败状态，不得输出敏感匹配内容、模型字段值或私有绝对路径。

### 远程阶段

```text
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -File <remote-runner.ps1> -Phase backup|packages|merge|verify|cleanup
```

远程 runner 必须使用显式 staging 根目录、目标 Pi 根目录、唯一 run id 和备份目录；不得把整个 Pi 用户目录作为输入。

### Package 安装

```text
pi install <reviewed-nonmodel-source> --no-approve
```

source 必须来自本次 `packages.txt`，且通过 `npm:`/`git:` scheme、路径逃逸、credential URL、model-related 与逐包审核检查。安装器产生的 settings 变化必须与批准的非模型 package 结果一致；目标模型相关与目标独有条目保持不变。

## 4. Staging / archive contract

允许的 archive 控制文件：

```text
source-manifest.json
packages.txt
```

允许的 payload bucket：

```text
user-pi-agent/
field-patches/
section-patches/
user-agents-skills/   # 仅额外授权时
```

约束：

- `settings.json` 整文件不得进入 archive；只能出现 `field-patches/settings.nonmodel-fields.json`。
- 字段补丁只含确认非模型的 `fields`，不得含 `packages` / `extensions` 整列、模型字段、provider/toolkit/model policy 配置或 credential。
- 含模型区块的 prompt 文档不得作为 whole-file payload；只能包含已审核非模型 section。
- 每个 payload 必须在 manifest 中声明 `bucket`、`path`、`mergeMode`、bytes、SHA-256、apply order；合并项还要声明实际 `targetPath` 与独立 `backupRelativePath`。
- archive entries 必须精确等于 manifest 声明集合；拒绝绝对路径、drive/ADS、空段、`.`、`..`、反斜杠、symlink/reparse point、大小写折叠冲突、项目、Pi Web、`node_modules`、protected names 和备份/运行状态。
- runner 单独传输，不进入 archive；远程解压到 `%TEMP%` 隔离目录，不直接解压到目标 Pi root。

## 5. Protection contract

下列内容默认只做存在性/类型/bytes/mtime/可选 SHA-256 或目录 aggregate metadata 核验；不得复制、解析后写入输出、修改、删除、移动或重命名：

```text
auth.json
models.json
models-store.json
pi-web-credentials.json
模型路由/策略扩展及其配置
模型 toolkit 配置
模型 profile 文档
subagent model policy 配置
trust.json
sessions/
cache/
backups/
migration-backups/（既有内容）
run history / runtime state / missions / remote memory
SSH config / keys / agent state / known_hosts
```

补充规则：

- `models.example.json` 必须保持模板名，不能自动改名或覆盖为真实模型文件。
- `settings.json` 的 model/provider/thinking/compaction 等字段保留目标值；精确值指纹只用于当前 run 私有比较，报告只写字段名、类别、计数和一致性结论。
- 目标端原本缺失的模型文件或模型策略配置在同步后仍必须缺失。
- 模型策略 package 冲突保留目标活动引用；旧 package 与目标独有 package 不删除。

## 6. SSH / target isolation

- 每个目标独立 preflight、inventory、授权、run id、temp、backup、apply、verify、cleanup 和报告。
- 使用现有已确认 host key，并以 `StrictHostKeyChecking=yes` 预检；不得自动写入或修改 SSH 信任状态。
- host key 缺失/变化、用户或目标路径不符、TCP 可达但 banner/KEX 前关闭时，当前目标标记 `blocked`，不继续 inventory/transfer/sync。
- 一个目标失败不能回滚或污染另一个目标；只有事先允许时才继续下一个目标。

## 7. Backup / apply / rollback

- 备份目录使用毫秒时间戳 + 随机后缀；碰撞时生成新 run id，不能覆盖。
- 备份的是实际目标文件，不是 field/section patch payload。`settings.json` 与 prompt 文档即使只做字段/区块合并，也要先完整备份目标原文件。
- package 先安装并验证，再写 whole-file/section，最后 field-merge settings。
- native command 只按 exit code 判断成功；普通 stderr/notice 不自动等于失败。
- 写入使用同目录临时文件与安全替换；不能先删除原文件。目标锁定或 baseline 变化时停止，不杀进程。
- package 失败后检查安装器是否改动 settings；若有未批准/不完整变化，只从当前目标备份恢复 settings，不删除 package 目录。
- 回滚只处理当前 run 的实际目标 allowlist。新建文件只有在仍等于本次 applied target hash 时才能删除；不能证明完整恢复时报告 `partial`。
- cleanup 只允许删除批准 temp base 下精确匹配当前 run id 的目录；保留唯一备份与脱敏报告，不清理历史状态。

## 8. Validation & Error Matrix

| 条件 | 必须行为 |
| --- | --- |
| 源文件含 credential、模型配置或机器私有路径 | 从 staging 排除；只记录类别/数量，不回显匹配值 |
| `settings.json` JSON 失败、schema 不兼容或存在未知嵌套语义 | 跳过整个文件，不得整文件覆盖 |
| 字段补丁包含 `packages` / `extensions`、模型/provider/thinking/compaction 字段 | 阻止 patch/archive |
| prompt 文档标记缺失、反序、嵌套，或目标布局未决 | 保留目标文档，不得回退 whole-file |
| package source 未审核、模型相关、不合法或含 credential URL | 不安装，记录 `kept-target` / `not-installed` / `blocked` |
| 出现项目、Pi Web、`node_modules`、路径逃逸或 reparse point | 阻止 archive |
| 远程 allowlist 目标为目录、锁定或 baseline 改变 | 停止当前目标，不停止进程 |
| protected state 或目标模型字段变化 | 验收失败；按授权从目标备份恢复 allowlist，不用 source 修复 protected state |
| cleanup 失败 | `success-with-cleanup-failure` 或 `partial`，不能报告完全成功 |

## 9. Tests Required

### 本机/静态

- skill frontmatter、relative links、Markdown fences 通过；
- skill 目录不含真实 alias/host/port/user/path/fingerprint/credential/model/provider 实例值；
- 无可执行的 host-key 绕过用法、整目录/node_modules 复制、进程终止或历史状态清理命令；
- PowerShell 代码块以显式 UTF-8 解码后通过 Windows PowerShell 5.1 parser；Python 代码块通过 `compile()`；
- archive good/bad cases 覆盖：路径、重复、symlink、manifest 精确集合、field patch、section patch、package scheme/credential/model blocklist；
- native stderr/exit-code、目录 aggregate hash、target-path rollback 和 cleanup guard 通过本地 smoke；
- `task.py validate <task>` 通过。

### 每个远程目标

- `node --version`、`npm --version`、`git --version`、`pi --version`、`pi --help`、`pi list` 成功；
- whole-file hash、section merge 结果、settings `field-merged`/`skipped`、package result 均有逐项证据；
- 目标认证、真实模型、模型策略/provider/toolkit/model policy、session/cache/backup/trust/SSH 状态保持不变；
- 目标独有 package/files 与旧 package 安装目录仍存在；
- 远程临时目录已删除，唯一备份和 manifest 保留；
- 模型请求、登录/OAuth、Pi Web 和进程终止次数均为 0。

## 10. CLI lineage / machine-specific files

- Pi CLI 升级或 package lineage 切换不属于普通环境同步；需要独立范围、精确 package/version 与单独验证。
- 不对齐全局 npm 包集合、shell 配置或系统工具。
- `settings.json` 中与目标 CLI 版本相关、语义不确定的字段保留目标；不能因 source 版本更高而覆盖。
- 含绝对用户路径的 fixture 默认排除并保留目标版本；不能用用户名盲替换推断安全。
