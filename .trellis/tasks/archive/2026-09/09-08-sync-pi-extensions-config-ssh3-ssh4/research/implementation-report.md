# ssh3 Pi 扩展与配置同步执行报告

日期：2026-09-08

## 结论

- ssh3 同步已完成并通过当时的最终验收；ssh4 后续已完成 host-key 确认、登录与只读 Pi 对比盘点，但**尚未同步**、未安装 package。
- 远程备份目录：`C:\Users\10497\.pi\agent\migration-backups\20260908-194453213`。
- 显式 allowlist 共 35 个文件：4 个核心文件 + 31 个 extension 文件；全部写入后与本机 canonical source 的 SHA-256 一致。
- 实际内容发生变化的文件共 4 个：`AGENTS.md`、`settings.json`、`extensions/anon-notify/index.ts`、`extensions/pi-openai-toolkit/config.json`。
- 其余 31 个 allowlist 文件原本已一致，但仍按显式 allowlist 经过备份、临时写入和哈希验证。
- `npm:@cr1ms0n/pi-subagent@0.8.1` 已安装并成为活动 source；旧 `@parke.dev/pi-subagent` 安装目录保留且目录聚合哈希未变。
- 所有 19 个保护项的存在性、计数、字节数和 SHA-256/目录聚合 SHA-256 均与执行前一致。

## 执行边界

- Canonical source：`C:/Users/Administrator/.pi/agent`。
- ssh3 同步执行阶段只操作 SSH alias `ssh3`；紧随该执行的当时，对 ssh4 仅运行 `StrictHostKeyChecking=yes` 的只读连通性预检。后续另行完成了 ssh4 host-key 确认、登录与只读盘点，但始终未执行 ssh4 同步写入。
- 未复制、修改、删除、移动或重命名 `auth.json`、`models.json`、`models-store.json`、`trust.json`、sessions、cache、backups、run history、remote memory、SSH 状态及其他目标状态。
- 未删除 ssh3 独有的 `extensions/disable-project-subagent-confirmation.ts`、`extensions/pi-openai-toolkit/config.json.bak-sync-20260904`、`pi-subagents.json` 或旧 package 目录。
- 未停止 Pi/Node 进程，未发送模型请求，未调用 Pi Web。

## Staging 与备份证据

- 本机 archive：65727 bytes，SHA-256 `5b91bae3298c1c4e12eab98ab95a2102cc1c3711326d81116c5ba2872f0952bd`。
- Source manifest SHA-256：`bc408ea7bec11d7ddaf5007f20336fae2a2200e35249e81e3a3520f3eb31f881`。
- 远程 baseline/backup manifest：`C:\Users\10497\.pi\agent\migration-backups\20260908-194453213\baseline-and-backup-manifest.json`。
- 备份 allowlist：35 个已存在文件；原本缺失 0 个。
- 写入前对全部目标 allowlist 文件执行了类型、独占读取/锁状态、当前哈希和备份副本哈希复核；未发现文件锁或并发变化。
- Archive 仅含 `source-manifest.json` 和显式 `payload/` 条目；zip 完整性、绝对路径、`..` 路径逃逸和高风险 credential literal 扫描通过。
- `extensions/anon-notify/server/notify-webhook.test.mjs` 未进入 archive。

### 远程备份内保留的非敏感证据

- `C:\Users\10497\.pi\agent\migration-backups\20260908-194453213\baseline-and-backup-manifest.json`
- `C:\Users\10497\.pi\agent\migration-backups\20260908-194453213\staging-verification.json`
- `C:\Users\10497\.pi\agent\migration-backups\20260908-194453213\applied-source-manifest.json`
- `C:\Users\10497\.pi\agent\migration-backups\20260908-194453213\package-install-result.json`
- `C:\Users\10497\.pi\agent\migration-backups\20260908-194453213\merge-result.json`
- `C:\Users\10497\.pi\agent\migration-backups\20260908-194453213\final-verification-attempt1.json`
- `C:\Users\10497\.pi\agent\migration-backups\20260908-194453213\final-verification.json`

## Package 安装

- 执行命令：`pi install npm:@cr1ms0n/pi-subagent@0.8.1 --no-approve`。
- ssh3 会话检测到进程级 `NODE_TLS_REJECT_UNAUTHORIZED` override；只在该安装进程内清除，以保持 strict TLS，没有修改持久环境。
- 第一次远程包装层因把 `npm notice` 的 stderr 按 `ErrorActionPreference=Stop` 处理而返回失败；随后只读检查确认 package 已完整安装、`settings.json` 尚未改变、旧 package 仍存在。该尝试已记录，原临时目录已清理，没有重复安装。
- 最终 package 状态：`installed-attempt1-wrapper-recovered`；新 package identity/version 验证通过，旧目录保留：true。

## Allowlist 写入结果

- 写入：35；写后立即验证：35；最终验收匹配：35/35。

| Path | Bytes | 执行前状态 | 最终 SHA-256 |
| --- | ---: | --- | --- |
| `AGENTS.md` | 5202 | 内容变化 | `228cf4964cfa240af1396cdb9ebec780ac26f62abdd0b4ba1f3dc0080caf0a35` |
| `APPEND_SYSTEM.md` | 7130 | 原本一致 | `6b9943d94d61c09524b2c5035b825560f86e9fad3169baca5379c722d705538c` |
| `keybindings.json` | 90 | 原本一致 | `f0b91362ff75219c1e85200cf6dd7cb18b3cdcf66b54f05127092c6acadd15a0` |
| `settings.json` | 2052 | 内容变化 | `e06b2745781e522ae3e7aeae0ab444e3b2bb4912f5de0c0965cd037df42a42ce` |
| `extensions/anon-notify/client.test.ts` | 5733 | 原本一致 | `5407335a945191b101de8869e2bd0851e13cba77722b5f3fa8d0e3ad8f25779a` |
| `extensions/anon-notify/client.ts` | 10319 | 原本一致 | `f339427104e5960953d2e9e630f41138a30d759fa84b5216ca2e0fc4f8e5ccd3` |
| `extensions/anon-notify/command-journal.test.ts` | 1820 | 原本一致 | `20411214dd9162a415dbd03cd8079cb1b968daf1ef2335864e6c059c3e54fdd8` |
| `extensions/anon-notify/command-journal.ts` | 4634 | 原本一致 | `eec2e882eb8e34116c10ff3b528e3fefacb4648aee7eace93c8a12c599390a87` |
| `extensions/anon-notify/command-polling.test.ts` | 4248 | 原本一致 | `75aadb7d5b42106a5a3da098e574e467d7ca83c1734aeb59c7dab3797870eb09` |
| `extensions/anon-notify/command-polling.ts` | 4456 | 原本一致 | `746ad456ce1448a415293aa22e0df7094c51e96a3a9d6a06084c21b8b75eed19` |
| `extensions/anon-notify/config.json` | 1263 | 原本一致 | `59fd3687addea2f2d126771b8f6e2c3426f8b6b6582910b3b67ef18360809056` |
| `extensions/anon-notify/config.ts` | 14354 | 原本一致 | `ab7ba25109c6d325b5cdf535f80049c3a963b7fc39d0f3a2e64a346ccf933c52` |
| `extensions/anon-notify/index.ts` | 31297 | 内容变化 | `31fc64a818fef7821b3ba635cd2ab044e03aa76958e2a9dff992a4d4f845f3e0` |
| `extensions/anon-notify/lifecycle.test.ts` | 2528 | 原本一致 | `f073c6d37a0f1b76d026d06c84043b39d09cfea7a91e7215c35b28bb486bc3b6` |
| `extensions/anon-notify/lifecycle.ts` | 2584 | 原本一致 | `17e735cef9ccaa89ba253bcc849cf95fe3ce2307b02ab098b54cc6f85d72aa76` |
| `extensions/anon-notify/prompt-surface.test.ts` | 1070 | 原本一致 | `8eaf3baee288bd18840764e8707fad791306026e899e900cd53bfa73bfeece3c` |
| `extensions/anon-notify/README.md` | 11490 | 原本一致 | `a72269f6491ebfeb6d36d0d54a0906d0299c44b37241e0ecd7651f483279a88d` |
| `extensions/anon-notify/server/command-queue.js` | 8344 | 原本一致 | `759e246c0e609c3f4c4bdcfd2a19583890495006bf775810de2b8adf8ea79ac7` |
| `extensions/anon-notify/server/command-queue.test.mjs` | 2866 | 原本一致 | `19ff55bc014e593f23b78f59c1e55c7eb140e74d2b108426fd86b15c87371fb3` |
| `extensions/anon-notify/server/notify-webhook.js` | 24658 | 原本一致 | `8cc3fb69f9abd3b1ef111b5142faff1fbe2fb720e8510f18d6b56b477758801f` |
| `extensions/anon-notify/session-state.test.ts` | 4638 | 原本一致 | `33ebddf234be87fb9aeac610f323295a462c6667f724e8c7bba95c3dcfcb0ffb` |
| `extensions/anon-notify/session-state.ts` | 3784 | 原本一致 | `1a75057319eb586d7fdf95413236dde9d53675cc45be5ba0feabde2eef5df19b` |
| `extensions/anon-notify/state-events.test.ts` | 3538 | 原本一致 | `9641e65cdfaf3388ece6edbe41740783321206c3fa8b236aeb462052b929095d` |
| `extensions/anon-notify/summary.ts` | 1573 | 原本一致 | `2c0b1616c37ea32cb01e758235bc8fa104042205d72a7b90d567a77baf68ed7d` |
| `extensions/anon-notify/target.test.ts` | 2288 | 原本一致 | `1fb2d1d6aa99250ba4b7c842f5f780ccfdc1d0caf9836ef93a82555267aa5837` |
| `extensions/anon-notify/target.ts` | 5520 | 原本一致 | `be16800a6b657daaabd7dd7a26ff762f59e8ea65f8d2109129ef8afaace344c9` |
| `extensions/cache-probe/index.ts` | 3220 | 原本一致 | `e6199123c357215ddb771b5de1bae898a5d811079118d05be87ed482f2a7e2b0` |
| `extensions/model-prompt-router/index.ts` | 4966 | 原本一致 | `d3dfcade249dfe632b8ec79be0ffa11c4a6beb63b7ad1c99528831afad1feb94` |
| `extensions/pi-openai-toolkit/config.json` | 1023 | 内容变化 | `df63391366ebeeedfe594882518e072868d6c734a61c3364d6cea467b6408433` |
| `extensions/pi-rtk-optimizer/config.json` | 684 | 原本一致 | `25a37db0dafc7c22c3e16387e21ed5cd2e8ad362a751db35b6449a9a26413013` |
| `extensions/pi-tool-display/config.json` | 3 | 原本一致 | `ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356` |
| `extensions/powerline-footer/theme.json` | 178 | 原本一致 | `0049e596f86899a25cccbecbe94fc2ce19fb1874a1cc3011714e718ef235e7e6` |
| `extensions/rtk.ts` | 2963 | 原本一致 | `caf4c59894f701ea9991e03b9a82afed8b542e7a452531e6339ca17f14c99803` |
| `extensions/subagent/config.json` | 39 | 原本一致 | `82d608901f31f2059ef1e0a9586df87b41520178021b81fcdb77b364164646c7` |
| `extensions/subagent-guidance/index.ts` | 857 | 原本一致 | `8ae3a7823d5f0ebbd5c1cdb004baa991084543c0ee887b5365a55ada7cb5dc63` |

## 保护项与目标独有状态

目录使用按相对路径、文件大小和文件 SHA-256 生成的聚合 SHA-256；`migration-backups-prior` 在复核时排除本次新建备份目录。

| 保护项 | Kind | Count | Bytes | 执行前 SHA-256 | 执行后 SHA-256 | 结果 |
| --- | --- | ---: | ---: | --- | --- | --- |
| `auth.json` | file | 1 | 95 | `74ed2f6f86667853a86cd43c0e076f80f0d44ea9d26b629aa6b5edb254988c0c` | `74ed2f6f86667853a86cd43c0e076f80f0d44ea9d26b629aa6b5edb254988c0c` | 一致 |
| `models.json` | file | 1 | 6047 | `a5121f8c8651d5897f57ad5b5d370af05a59542da22c0500d3417acaa926abf1` | `a5121f8c8651d5897f57ad5b5d370af05a59542da22c0500d3417acaa926abf1` | 一致 |
| `models-store.json` | file | 1 | 2892 | `fc9a859ba17e0e477db24fc66c3cb7375f1d11d5b99b1ca027dd1ed5e79065b9` | `fc9a859ba17e0e477db24fc66c3cb7375f1d11d5b99b1ca027dd1ed5e79065b9` | 一致 |
| `trust.json` | file | 1 | 365 | `292dc5ff830c17320e8fd818e0a2bca285309969b5e97e2f48fc6cbce37412c7` | `292dc5ff830c17320e8fd818e0a2bca285309969b5e97e2f48fc6cbce37412c7` | 一致 |
| `sessions` | directory | 414 | 828437976 | `9ecb4c6a38a4d9f628817ccbaef093758325ba7a9b55ac143005a5ee39a1a744` | `9ecb4c6a38a4d9f628817ccbaef093758325ba7a9b55ac143005a5ee39a1a744` | 一致 |
| `cache` | missing | 0 | 0 | `—` | `—` | 一致 |
| `backups` | directory | 104 | 9267248 | `54990040283dace2836af320fab35fc0f6de474f564dcb2775b933f7007f61d7` | `54990040283dace2836af320fab35fc0f6de474f564dcb2775b933f7007f61d7` | 一致 |
| `run-history.jsonl` | file | 1 | 34055 | `51e27fd7bbbebf124ba8686d1b780f9dd7cc2aef754471663714d85d9ebb31f8` | `51e27fd7bbbebf124ba8686d1b780f9dd7cc2aef754471663714d85d9ebb31f8` | 一致 |
| `remote-memory` | missing | 0 | 0 | `—` | `—` | 一致 |
| `ssh-remote-memories` | directory | 2 | 1609 | `fc3ced31bceb4202baf06a2d9009196cdd82f874cbf08a596249936df1afb59d` | `fc3ced31bceb4202baf06a2d9009196cdd82f874cbf08a596249936df1afb59d` | 一致 |
| `pi-subagents-state` | directory | 19 | 218699 | `71ed000fed6dc6d7b7d6fa28a88b7e72e1327020082e04950dfa11c7c6f2a564` | `71ed000fed6dc6d7b7d6fa28a88b7e72e1327020082e04950dfa11c7c6f2a564` | 一致 |
| `missions` | directory | 58 | 27528 | `31794dc1ddb4d6f0bb6ebf8ba4dbdd880d8e79cd50f946436f35446d0adf8956` | `31794dc1ddb4d6f0bb6ebf8ba4dbdd880d8e79cd50f946436f35446d0adf8956` | 一致 |
| `migration-backups-prior` | directory | 100 | 372695 | `229f944995a369715bb37dc0298d951aac3f6f5faee9efafefd6d93bc1990fc2` | `229f944995a369715bb37dc0298d951aac3f6f5faee9efafefd6d93bc1990fc2` | 一致 |
| `ssh-state` | directory | 9 | 16776 | `e3ebc200c36520eda2d2223b0618921fdb59964c2e954157a9365e3610373977` | `e3ebc200c36520eda2d2223b0618921fdb59964c2e954157a9365e3610373977` | 一致 |
| `fixture` | file | 1 | 7525 | `a6b8b6f77f4ce8e6cbd0ab159478dfdeb717711d06b1f1c6c85c74439f84918f` | `a6b8b6f77f4ce8e6cbd0ab159478dfdeb717711d06b1f1c6c85c74439f84918f` | 一致 |
| `disable-project-subagent-confirmation.ts` | file | 1 | 755 | `cbbb60c783d30f713ee367d15d66efad1b9957a181729c784763bbac029960de` | `cbbb60c783d30f713ee367d15d66efad1b9957a181729c784763bbac029960de` | 一致 |
| `pi-openai-toolkit-backup` | file | 1 | 852 | `8d7386b9d7e7700f875091ac209ab1e80dae8c63a5c5e3dd323285d8e19912a6` | `8d7386b9d7e7700f875091ac209ab1e80dae8c63a5c5e3dd323285d8e19912a6` | 一致 |
| `pi-subagents.json` | file | 1 | 157 | `b8fd871ce04deae84daf34932a56712d0f9331be9ca5c44b8bd07406341f9d0f` | `b8fd871ce04deae84daf34932a56712d0f9331be9ca5c44b8bd07406341f9d0f` | 一致 |
| `old-parke-subagent` | directory | 45 | 528960 | `c53c5166ddc86a46da750cb7252d374eb762170419ae1f70ed50c145223f079a` | `c53c5166ddc86a46da750cb7252d374eb762170419ae1f70ed50c145223f079a` | 一致 |

## Fixture 验证

- 目标 fixture 存在：true。
- 包含 ssh3 用户路径 `C:/Users/10497`：true。
- 包含本机用户路径 `C:/Users/Administrator`：false。
- Fixture 的执行前/执行后 SHA-256 相同，未被 staging 或 merge 触碰。

## CLI 与 package source 验收

- `node --version`：`v24.10.0`，exit 0。
- `npm --version`：`11.6.1`，exit 0。
- `git --version`：`git version 2.53.0.windows.1`，exit 0。
- `pi --version`：`0.85.1`，exit 0。
- `pi --help`：exit 0，196 行输出。
- `pi list`：exit 0；当前列出 16 条 package entries（15 个普通 source + 1 个带 `extensions` 过滤项的 git package 配置）。
- 同步前 package entries 中仅将 `npm:@parke.dev/pi-subagent` 替换为 `npm:@cr1ms0n/pi-subagent@0.8.1`；其他 15 条 entry 保持，最终配置集合匹配：true。
- 新 source 活动：true；旧 source 不再活动：true；旧安装目录仍保留：true。

## 清理与未完成项

- 两个远程临时目录均已删除：true。
- 进程终止次数：0；模型请求次数：0；Pi Web 调用次数：0。
- ssh3 本轮无未完成项。
- ssh4 未执行任何同步写入或 package 安装；后续仅完成 host-key 确认、登录与只读盘点，仍是待授权的独立同步目标。
- 未执行 `git commit`。

## 可复用 skill 交付（2026-09-08）

在保留上述 ssh3 已同步事实的前提下，新增 project-local 共享 skill。ssh4 的早期阻断状态已被后续 host-key 确认与只读盘点取代，但 ssh4 仍未同步：

```text
.agents/skills/pi-environment-sync/
├── SKILL.md
└── references/
    ├── migration-workflow.md
    ├── command-templates.md
    └── report-template.md
```

### 覆盖范围

- `SKILL.md`：定义 Pi 本机 → Windows SSH 目标同步的触发条件、必填参数、只读/写入分段授权、默认 allowlist、永不默认同步项、逐目标执行、硬停止条件和完成标准。
- `migration-workflow.md`：覆盖本机与各目标只读盘点、host-key/SSH 预检、目标独立状态机、显式 allowlist staging、唯一时间戳 + 随机后缀备份、隔离传输、package-first apply、验收、失败、回滚和清理。
- `command-templates.md`：提供参数化 PowerShell/SSH/zip/manifest/scp/remote runner/native process/rollback 模板，使用 `Split-Path -Parent -Path`，按 native exit code 判断 package 安装，不把普通 stderr 自动视为失败。
- `report-template.md`：提供逐目标 preflight、inventory、backup、package、allowlist、protected-state、fixture、非模型验收、回滚和清理报告格式。

### 安全契约

- 默认可同步：`keybindings.json`、逐文件审核通过的非模型 extension、`settings.json` 的确认非模型字段、prompt 文档的确认非模型 section，以及经逐包审核的非模型 package source。
- `settings.json` 禁止整文件覆盖，`packages` / `extensions` 列表不进入字段补丁；含模型区块的 prompt 文档禁止整文件覆盖。
- 禁止整目录复制 `.pi\\agent`、Pi CLI 安装目录、全局 package 安装目录或 `node_modules`；目标缺少对应 source 文件时也不做 mirror delete。
- `auth.json`、真实 `models.json` / `models-store.json`、`trust.json`、sessions、cache、既有 backups、run history、runtime state、remote memory 和 SSH 状态保持 target-owned。
- `models.json` / `models-store.json` 默认只做存在性、类型、字节数、时间戳和可选 SHA-256 核验；不读取内容，不复制、修改、删除、移动或重命名。
- package source 冲突时先安装并验证 canonical package，再最后写 `settings.json`；目标旧 package 安装目录不删除。
- 机器绝对路径 fixture 默认排除并保留目标版本，不做用户名盲替换。
- TCP 可达但 SSH 在 banner/KEX 前关闭时标记 blocked；不使用 `StrictHostKeyChecking=no`、不自动修改 `known_hosts`、不继续同步。
- 验收只允许版本命令、`pi --help`、`pi list`、manifest/hash/metadata 检查；模型请求、登录、Pi Web 和进程终止次数必须为 0。

### 参数化与隐私检查

skill 只使用以下逻辑参数：

- `SOURCE_PI_ROOT`
- `SSH_ALIASES`
- `TARGET_USER[alias]`
- `TARGET_PI_ROOT[alias]`
- `REVIEWED_NONMODEL_PACKAGE_SOURCES`
- `REVIEWED_NONMODEL_SETTINGS_FIELDS`
- `APPROVED_EXTENSIONS`
- `MODEL_PROFILE_BLOCK_MARKERS`

共享 skill 未保存本次机器的实际用户名、SSH aliases、host、port、私有绝对路径、host-key fingerprint 或凭据，也没有写入真实 key/token 示例。

### 验证结果

仅执行本地仓库检查，没有运行任何 `ssh`、`scp`、`sftp`、远程 PowerShell 或远程 Pi 命令：

- skill frontmatter、4 个必需 Markdown 文件和 4 个 references 链接：通过；
- Markdown code fence 配对：通过；
- 必需契约关键词覆盖：通过；
- 本次机器私有实例值扫描：通过，0 个匹配；
- credential literal 形状扫描：通过，0 个匹配；
- `python ./.trellis/scripts/task.py validate 09-08-sync-pi-extensions-config-ssh3-ssh4`：通过，`implement.jsonl` / `check.jsonl` 各 5 条有效 context；
- 新增 skill 不在 `.trellis/.template-hashes.json` 中，符合 project-local ownership；未修改 bundled skills 或 template hashes。

本 skill 交付阶段未连接 ssh3/ssh4；之后的 ssh4 检查仍未修改远程环境，未执行 `git commit`。

### 独立质量检查与修正（2026-09-08）

后续独立只读检查确认 `SKILL.md` 的 frontmatter、触发描述、references 路由和 project-local ownership 正确；共享 skill 不在 `.trellis/.template-hashes.json` 中，也未发现本次主机、用户、端口、fingerprint、私有绝对路径或 credential。

检查同时发现并修正了命令参考中的可执行安全问题：

- Windows PowerShell 5.1 在 `$ErrorActionPreference = 'Stop'` 下可能把 native stderr warning/notice 误判为失败；版本、SSH、package 和验收模板统一改为分离 stdout/stderr、只按 exit code 判断。
- 移除 PowerShell 7 才提供的 `ProcessStartInfo.ArgumentList`，改为 PowerShell 5.1 可用的 stdin helper，并并发读取 stdout/stderr，避免管道写满死锁。
- 远程 runner 参数改为经 PowerShell literal escaping 后通过 stdin 发送，不把私有 Windows 路径拼进 SSH command line。
- archive 校验补齐 POSIX separator、空 segment、尾随斜杠、drive/ADS、NUL、symlink、重复/大小写碰撞和 manifest 精确集合检查。
- protected directories 必须使用 file count、bytes 和 aggregate SHA-256 验证；不能只比较目录 mtime。`migration-backups` 比较排除当前 run id。
- 回滚删除本次新建文件前必须确认其仍等于 applied hash；递归清理前必须确认路径正好位于批准 temp base 下的当前 run id，防止并发覆盖或错误变量导致越界删除。
- 审核后的 canonical package sources 现在明确写入 `packages.txt`，并由 `source-manifest.json` 的 count/hash 绑定；archive 只包含 manifest、packages.txt 和允许 bucket 的显式文件，runner 单独传输。

修正后仅执行本地验证：frontmatter/link/ownership/privacy/危险命令扫描通过，PowerShell 5.1 parser 通过，Python 模板 compile 和 archive good/bad cases 通过，PowerShell native stderr/directory hash/cleanup guard helper smoke 通过，`task.py validate` 通过。检查期间仍未连接 ssh3/ssh4、未执行任何远程命令、未修改远程环境、未执行 `git commit`。

### ssh4 连通性复查（2026-09-08）

- 使用 `StrictHostKeyChecking=yes`、`BatchMode=yes` 和连接超时参数进行只读预检。
- 已收到 SSH banner：`OpenSSH_for_Windows_9.5`，并完成 KEX 响应；此前的“握手前关闭”不再复现。
- 实际 ED25519 host key fingerprint 与此前只读候选一致：`SHA256:7CFHwEftyW5yBXwY1gVykiM5YxEuXk42dOa74sGo77k`。
- 因该 key 尚未写入本机 `known_hosts`，连接在 host-key 验证阶段停止；未进入 ssh4 用户认证，未执行 Pi 目录盘点、package 安装、文件传输或同步。
- 未使用 `StrictHostKeyChecking=no`，未修改 `known_hosts` 或任何 SSH 状态。
## model-preserve 默认化（2026-09-08 用户补充边界）

用户明确：不要把本机的密钥或任何模型相关配置同步到目标，尤其适用于尚未同步的 ssh4。本轮只修改本地 project-local skill 与当前 task 记录；未连接 ssh3/ssh4，未执行任何远程命令，未执行 `git commit`。上文 ssh3 同步事实与 ssh4 只读对比报告保持原样，不改写、不删除。

### 策略变更要点

- model-preserve 成为 skill 的默认且不可降级策略，写入 `SKILL.md` 与三个 references。
- 永不复制/修改：`auth.json`、真实 `models.json` / `models-store.json`、Pi Web 凭据文件、provider credential fields、API/OAuth/token/authorization、private key。
- 不同步模型选择/路由/压缩配置：`settings.json` 的 `defaultModel` / `defaultProvider` / `defaultThinkingLevel` / `compactionModel` 等等价字段；`pi-openai-toolkit/config.json`；`model-prompt-router.json`；model-prompt-router 扩展；subagent model policy 配置文件；模型 profile 文档；以及任何无法安全拆分的 model/provider 配置。
- 合并方式改为四类：whole-file / field-merge / section-merge / install-only；未分类项不得进入 staging。
- `settings.json` 只能字段级合并非模型字段；目标模型字段、目标 package source、目标模型相关设置保留；无法可靠分类时整文件跳过（记为 `skipped`，不算目标失败）。
- package：只有经逐包审核的非模型 source 才能安装；涉及 model policy/router/toolkit 的冲突默认保留目标，不自动替换、不自动卸载；目标旧 package 不删除；package 未安装时其 config 也不同步。
- 含模型区块的 prompt 文档不得整文件覆盖；不能安全按 section 合并时保留目标版本（`preserved-target`）。
- 普通非模型 extension、`keybindings.json` 仍可按逐文件 allowlist 同步；机器路径 fixture、项目/运行时/target-owned 排除规则保留。
- 报告强制记录 model-preserve 策略、未复制的模型相关内容、`settings.json` 的 skipped/field-merged 结果，且不记录任何敏感内容或模型字段值。
- skill 仍保持参数化：只使用 `SOURCE_PI_ROOT`、`SSH_ALIASES`、`TARGET_USER[alias]`、`TARGET_PI_ROOT[alias]`、`REVIEWED_NONMODEL_PACKAGE_SOURCES`、`REVIEWED_NONMODEL_SETTINGS_FIELDS`、`APPROVED_EXTENSIONS`、`MODEL_PROFILE_BLOCK_MARKERS` 逻辑参数；未写入本机 host/user/路径/fingerprint/key/token，也未把真实模型/provider 标识当作待同步内容。

### ssh4 事实更正与当前状态

- 上文“ssh4 连通性复查”中「host key 尚未写入 `known_hosts`、连接在 host-key 校验阶段停止」已被后续只读盘点取代：用户已通过可信渠道确认该 host key，本机 `known_hosts` 已含该条目，只读 SSH 连接可用（详见 `ssh4-comparison.md`）。该段原文按时间顺序保留，不改写。
- ssh4 当前状态：host key 已确认、连接可用、只读对比盘点已完成、**尚未同步**，未写入任何文件、未安装任何 package。
- Pi CLI 版本差（ssh4 `0.84.3` vs 本机 `0.85.1`）仍属独立升级任务，不在本 skill 默认范围；因此 ssh4 的 `settings.json` 中与其 CLI 版本相关的字段（如 `lastChangelogVersion`）在字段合并时也默认保留目标值。

### ssh4 后续执行的 model-preserve allowlist（待写入授权）

可同步：

- `keybindings.json`（ssh4 原本不存在，属非模型 UI 配置，whole-file）。
- 逐文件审核、确认非模型/非凭据/无本机绝对路径的 extension 源码（whole-file）。候选需重新审核后才成立；上一版盘点里的 `model-prompt-router/` 已因 model-preserve 移除，不再属于候选。
- 经逐包审核且确认非模型的 package source（install-only）。ssh4 阶段当前无已确认项。

只能字段/区块级处理：

- `settings.json`：只写确认非模型的字段；ssh4 的模型字段、package 条目（含其 `pi-openai-toolkit@<pin>` 与 `@gotgenes/pi-subagents` 等活动引用）、`lastChangelogVersion` 及目标独有字段全部保留；分类不可靠即整文件跳过。
- `AGENTS.md` / `APPEND_SYSTEM.md`：本机 `AGENTS.md` 含模型选择 section，因此禁止整文件覆盖；需先完成 ssh4 `agent/prompts/` 布局决策，且只能合并确认非模型的 section，否则 `preserved-target`。

默认不同步（model-preserve，保留 ssh4 现状）：

- `auth.json`、`pi-web-credentials.json`、`models.json`、`models-store.json`（含 ssh4 当前空对象状态）。
- `pi-openai-toolkit/config.json`、`model-prompt-router.json`、model-prompt-router 扩展、模型 profile 文档、subagent model policy 配置文件。

明确排除（target-owned / 运行时 / 项目）：

- `trust.json`、sessions、`fff/`、`intercom/`、`powerline-footer/inbox.jsonl`、`ssh-remote-memories/`、`bin/`、cache、backups、run history。
- ssh4 独有 package：`pi-intercom`、`@juicesharp/rpiv-todo`、`pi-ssh-remote`、`pi-codex-goal`、`@gotgenes/pi-subagents`。
- ssh4 用户目录结构与本机不同，禁止把本机绝对路径写入目标；含机器路径的 fixture 保留目标版本。
- 全局 npm 包集合、系统级工具与 Pi CLI 版本。

### ssh4 未解决的布局/package 冲突（需用户决策）

1. **prompt 文档布局**：本机在 Pi 用户目录根，ssh4 在 `agent/prompts/` 子目录。model-preserve 下不在另一位置新建副本；需用户选择「统一到根布局」或「保留 ssh4 `prompts/` 布局」。两种选择都不允许整文件覆盖含模型区块的文档。
2. **subagent lineage 三方分裂**：本机 / ssh3 / ssh4 使用三个不同的 subagent 包。该包携带 model policy（子代理模型选择与回退）配置，属 model-preserve 范围 → ssh4 默认保留目标包，不安装本机 fork；若用户要求统一 lineage，需单独授权并说明其 model policy 文件如何处理。
3. **`pi-openai-toolkit` 版本 pin 与其 config**：ssh4 有显式 pin，本机无 pin。该包提供 provider/模型相关能力（compaction、web-search model、auto-mode reviewer model），默认保留目标 pin 与目标 config，不安装本机版本、不覆盖配置。
4. **ssh4 `models-store.json` 为空对象**：属目标模型状态，model-preserve 下不填充、不复制、不读取内容；若 ssh4 因缺模型配置无法使用，应由用户在目标机本地配置，不由同步解决。
5. **Pi CLI `0.84.3`**：是否升级为独立任务，需用户决定；不阻塞 model-preserve 范围内的非模型同步，但影响 `settings.json` 可写字段范围。

### ssh3 已完成事实与残留风险

ssh3 同步结果作为已完成事实保留。需明确的是：ssh3 同步发生在 model-preserve 明确之前，以下 4 项当时按整文件 allowlist 进入 staging，在新的默认策略下属于不同步项：

- `settings.json`（整文件写入，内容变化）→ 包含模型选择/压缩字段；目标原值已被本机值替换。
- `AGENTS.md`（整文件写入，内容变化）→ 本机版本含模型选择 section。
- `extensions/pi-openai-toolkit/config.json`（整文件写入，内容变化）→ 含 compaction / web-search model / auto-mode reviewer model 配置。
- `extensions/model-prompt-router/index.ts`（进入 staging，两机内容一致，未产生实际变化）→ 模型路由扩展实现。

ssh3 的 `auth.json`、`models.json`、`models-store.json`、`trust.json`、sessions、cache、backups、run history、remote memory、SSH 状态等 19 个保护项在同步前后哈希一致，未被修改；旧 package 与目标独有文件均保留。

可选恢复路径：ssh3 本次迁移备份 `migration-backups/20260908-194453213` 内含写入前的目标原文件，可对其做**选择性**恢复（只恢复上述模型相关项，不触碰其他 allowlist 文件）。这需要用户单独授权，且必须遵循「只从该目标备份恢复、先重做 protected-state baseline、不写回本机整文件」的边界。本轮未执行任何恢复。

### 本轮本地验证

只检查仓库内交付物，未运行任何 `ssh`、`scp`、`sftp`、远程 PowerShell 或远程 Pi 命令：

- 隐私扫描：`ssh[1-9]` alias、远端 host/port、远端主机名、两台目标用户名、本机用户名与工作区路径、本机用户标识、host-key fingerprint 形状、provider/模型标识、subagent package lineage、`C:/Users` 形态路径、IdentityFile 名称 → 0 个真实命中；唯一 2 处命中是 `pi-subagents-state` 目录名与包名同形，属预期保护项名称，不含机器私有值。
- 危险命令扫描：`StrictHostKeyChecking=no`、`npm ci`、`Copy-Item ... -Recurse`、`Remove-Item -Recurse -Force`、`Stop-Process`/`taskkill`/`pkill`、`git commit`、`git push --force`、`git reset --hard`、`rm -rf /`、`format`、`reg delete`、`chmod 777`、`sudo` → 全部命中均为禁止语句或已在 guard 内（回滚/递归清理必须校验路径正好等于批准 temp base 下的当前 run id，且只删本次新建且仍等于 applied hash 的文件）。
- Markdown fence 配对：`SKILL.md` 0（无代码块）、`migration-workflow.md` 20、`command-templates.md` 50、`report-template.md` 2，全部成对。
- references 相对链接：4 条全部存在，无断链。
- PowerShell 5.1 parser、Python 伪代码 compile、`task.py validate`：结果见下节末尾追加记录。
- 本轮未连接 ssh3/ssh4，未修改远程环境，未执行 `git commit`。

### ASCII Base64 stdin transport 修正（2026-09-08）

独立复核发现，Windows PowerShell 5.1 对 `powershell.exe -Command -` 的原始 stdin 采用目标代码页解码；若本地直接写 UTF-8 字节，中文注释、中文路径或非 ASCII 用户名可能出现静默乱码。该问题可能在 exit code 为 0 时漏检，因此不能只依赖解析或进程成功。

已将 `references/command-templates.md` 的 `Invoke-SshPowerShellStdin` 改为：

1. 本地将脚本编码为 UTF-8 无 BOM，再转成只含 ASCII 的 Base64，并通过 `StandardInput.BaseStream.Write` 发送；
2. SSH 命令行只携带固定 bootstrap 的 UTF-16LE Base64 `-EncodedCommand`，不携带脚本内容、目标路径或 secret；
3. 远端 bootstrap 从 stdin 读 ASCII Base64，解码为 UTF-8 后通过 `ScriptBlock::Create()` 执行，并仅通过 exit code 报告成功/失败。

保留的防护包括 alias 白名单、`StrictHostKeyChecking=yes`、`BatchMode=yes`、连接/整体超时、stdout/stderr 并行读取，以及不把普通 native stderr 当作失败。SKILL.md、迁移工作流和报告模板均已注明 ASCII Base64 transport 与非 ASCII round-trip 验收要求。

本地验证（不连接任何目标机）：

- transport smoke：14/14 assertions 通过，覆盖 bootstrap ASCII/`-EncodedCommand` round-trip、ASCII payload、含中文注释/路径/用户名的脚本 UTF-8 字节 round-trip、`exit 7` 透传、`throw` → exit 1 + `remote-bootstrap:`；
- PowerShell 5.1 fenced-block parser：23/23；Python fenced-block compile：1/1；
- Markdown fence/reference/privacy/dangerous-pattern scan：通过；
- `python ./.trellis/scripts/task.py validate 09-08-sync-pi-extensions-config-ssh3-ssh4`：通过，`implement.jsonl` / `check.jsonl` 各 5 条有效 context；
- 本次修正未连接 ssh3/ssh4，未执行远程命令，未修改远程环境，未执行 `git commit`。

### 最终复验与 preflight 一致性修正（2026-09-08）

质量检查进一步发现，命令模板第 3 节仍容易被理解为允许 inline SSH PowerShell preflight。已将其改为明确复用第 4 节的 `Invoke-SshPowerShellStdin`；首次远程身份预检与后续所有远程 PowerShell 现在统一走固定 ASCII bootstrap + ASCII Base64 stdin transport，不保留例外路径。

从当前 `command-templates.md` 直接提取 transport block，并在本地以 `powershell.exe` 替代 SSH 进程后完成最终复验：

- transport smoke：15/15 assertions 通过；
- PowerShell 5.1 fenced-block parser：23/23；Python fenced-block compile：1/1；
- frontmatter、references links、Markdown fences、privacy scan、task-local 临时 helper 清理：通过；
- `python ./.trellis/scripts/task.py validate 09-08-sync-pi-extensions-config-ssh3-ssh4`：通过，`implement.jsonl` / `check.jsonl` 各 5 条有效 context；
- 本次最终复验未连接 ssh3/ssh4，未执行远程命令、package 安装或 git 操作，未修改远程环境或 `known_hosts`。


## ssh4 model-preserve 同步报告（2026-09-09）

### 结论

- ssh4 同步已完成，目标为 `77565@KNINED`，Pi 根目录为 `~/.pi/agent`。
- 最终成功 run：`20260909-144113-ssh4-final-8836`。
- 远程备份保留在：`~/.pi/agent/migration-backups/20260909-144113-ssh4-final-8836`。
- Pi 版本保持 `0.84.3`，未执行版本升级、模型请求、Pi Web 调用或进程终止。

### 实际写入范围

- 5 个 whole-file allowlist 文件，均通过写后 SHA-256 验证并与本机一致：
  - `keybindings.json`
  - `extensions/pi-rtk-optimizer/config.json`
  - `extensions/pi-tool-display/config.json`
  - `extensions/powerline-footer/theme.json`
  - `extensions/rtk.ts`
- `settings.json` 只做字段级合并：`theme`、`tuiMode`；没有整文件覆盖，`packages`、`extensions`、模型字段和其他目标字段保留。
- 非模型 package source 最终确认存在：`npm:pi-tool-display`、`git:github.com/awoaCrim/preserveScrollbackPatch`。最终 run 因两者已存在而跳过重复安装。

### 明确保留/未同步

- `auth.json`、`pi-web-credentials.json`、`models.json`、`models-store.json` 未读取内容、未复制、未修改。
- `defaultModel`、`defaultProvider`、`defaultThinkingLevel`、`compactionModel` 的目标字段指纹未变化。
- 未同步 `pi-openai-toolkit` 配置、model-prompt-router、模型 profile、subagent model policy、`anon-notify`、`cache-probe`、`pi-dynamic-workflows` 等模型/凭据相关内容。
- ssh4 原有 package sources（包括 `@gotgenes/pi-subagents`、`pi-openai-toolkit@0.4.1`、`pi-ssh-remote`）保留；目标独有 `prompts/` 文档和 `subagent-guidance` 保留。
- `sessions`、`fff`、`intercom`、`powerline-footer/inbox.jsonl`、`ssh-remote-memories`、cache/backups/run history 等 target-owned/runtime 状态未进入写入 allowlist；`sessions` 作为易变目录只做存在性保留，不作为严格静态计数断言。

### 验收与清理

- 独立 postflight 通过：模型字段指纹、模型文件/凭据、prompt 文档和最终 run baseline 的稳定保护项均未变化；5 个同步文件哈希全部匹配；package source 数量为 18，原有 16 条全部保留。
- `theme=dark`、`tuiMode=regular` 与本机一致；目标原有 prompt 文档仍位于 `prompts/AGENTS.md`、`prompts/APPEND_SYSTEM.md`。
- 最终远程临时目录已清理；最终备份以及早期失败 run 的备份目录均保留，便于回滚审计。
- 本地临时 staging、runner、preflight 和验收 helper 已在最终验收后清理；未执行 `git commit`。
