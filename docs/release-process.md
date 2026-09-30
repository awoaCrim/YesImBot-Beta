# Beta 发布与部署

## 一期流程

```text
推送 Beta/dev → CI 检查、测试、构建一次 → 手动 Release → 本机一条命令部署
```

GitHub 只负责构建与发布，不持有生产 SSH 私钥，不自动部署生产。部署不在服务器构建或安装依赖；下载、校验、差异接收和备份均在停服前完成。相同文件时 no-op，不重启。CI 首次下载、排队仍可能较慢；后续依赖与 Turbo cache 复用，不承诺固定秒数。

## 首次同步与之后的开发

首次同步使用隔离 clone：从目标仓库公开 `v4` 建 `dev`，复制经过审计的完整公开源码快照，正常提交并推送。保留 `v4`、原本地工作树和 upstream `origin`，不 force push，不将带私有运维记录的本地历史直接推到公开仓库。

同步后从 `awoaCrim/YesImBot-Beta` 的 `dev` 建立干净开发 checkout，之后正常 commit/push。公开 tree 应包含源码、测试、构建配置、`.yarn/releases/yarn-4.12.0.cjs` 和 `yarn.lock`；不含 `.trellis`、本机 agent 目录、`.tmp`、凭据、数据、备份和部署 profile。`.gitignore` 无法从历史移除已经跟踪的私有文件，不能代替首次快照审计。

CI 使用 Node `24.14.0`、仓库内 Yarn `4.12.0`，直接调用 pinned CLI，不依赖 Corepack：

```bash
node .yarn/releases/yarn-4.12.0.cjs install --immutable
node .yarn/releases/yarn-4.12.0.cjs lint
node .yarn/releases/yarn-4.12.0.cjs fmt:check
node .yarn/releases/yarn-4.12.0.cjs check-types
node .yarn/releases/yarn-4.12.0.cjs build
node .yarn/releases/yarn-4.12.0.cjs test
python -m unittest discover -s scripts/tests -v
```

格式检查在 build 前执行，避免将生成的 `lib` 当成源码。Turbo 会按依赖顺序构建 workspace，不要在干净 checkout 跳过依赖构建直接逐包 typecheck。正常 warnings 以项目现有退出码判定，不为发布做无关业务重构。

## 日常 Release

1. 向 Beta/dev 推送提交，等待 **CI 全部成功**。
2. GitHub Actions → **Release Beta** → **Run workflow**，选择 `dev`，填写成功 CI 的数字 run ID。
3. Release job 验证同仓库、`ci.yml`、push-to-dev、成功状态、source SHA 和 artifact provenance；PR 的产物不能发布。
4. 生成 prerelease `beta-YYYYMMDD-<sha12>`。日期来自该 CI run，资产沿用原 CI 输出，不重复构建、不覆盖已有版本。

发布失败可能保留 draft 供检查；不要对同一版本盲目重复发布或覆盖资产。排查完 draft 后由维护者明确处理，再发布新的提交。

Release 恰好包含三项资产：

- `payload.tar.gz`：所有已注册 workspace 的 `dist/lib` 普通文件，包含 Console/Usage backend `lib` 和 frontend `dist`。
- `manifest.json`：source/run、构建/runtime 兼容性、完整路径及 size/SHA-256、payload 与 runner 的 size/SHA。
- `runner.py`：同一版本的 remote receiver，独立 control sidecar，不写入应用输出目录。

manifest 不放在 payload 内，避免自引用 payload hash。库与 Koishi plugin 分别验证，支持 CJS named library exports、直接导出的 class、`default` 或 `apply`。

## 本机配置

要求 Python >= 3.11、Git，以及可以非交互连接且已信任 host key 的 SSH alias。远端为 Linux + Python >= 3.11，已有 Docker/Node 应用环境。工具不会关闭 host-key 验证，也不会安装缺失依赖。

复制 `scripts/release-profile.example.json` 到 ignored `.release-local/ssh1.json`，填实际 hostname、宿主/容器 sourceRoot、dataRoot、configPath、stateRoot、Koishi/NapCat 容器名和 localhost 健康地址。stateRoot 必须与源码/业务数据完全分离；远端 state/runs/run 为 root-owned `0700`。真实 profile、私钥和 token 不提交。

兼容性 fingerprint 会把宿主 `sourceRoot` 以新的只读路径挂入目标镜像，避免嵌套 Koishi boilerplate 的 ancestor `node_modules` 污染 YesImBot workspace graph；这不是绕过实际运行检查。停服前后仍会用目标容器的真实 mount 执行 import probe，并继续执行容器 identity、HTTP、启动和数据 guards。

公开资产下载不需要 token；手动本地 publish 可从 `GH_TOKEN`/`GITHUB_TOKEN` 或 Git Credential Manager 获取凭据。不要把 token 粘贴在命令参数、日志或文档中。GitHub Release workflow 使用权限限定的临时 `GITHUB_TOKEN`，不是本机 PAT。

## 一条命令部署

下列命令中的 tag 替换为实际发布版本：

```bash
# 预检：校验 Release、实际依赖/ABI、目录所有权、差异和 guards，不停服务
python scripts/release.py deploy beta-YYYYMMDD-<sha12> --target ssh1 --dry-run

# 应用差异部署；相同内容自动 no-op
python scripts/release.py deploy beta-YYYYMMDD-<sha12> --target ssh1

# 独立检查当前文件、加载能力和 HTTP 健康
python scripts/release.py verify-target beta-YYYYMMDD-<sha12> --target ssh1

# 查询状态、恢复未完成事务、回滚最近一次实际激活
python scripts/release.py status beta-YYYYMMDD-<sha12> --target ssh1
python scripts/release.py recover beta-YYYYMMDD-<sha12> --target ssh1
python scripts/release.py rollback beta-YYYYMMDD-<sha12> --target ssh1
```

也可用 `node .yarn/releases/yarn-4.12.0.cjs release:deploy <tag>`。非默认 profile 用 `--profile <local-json>`。工具 JSON 输出不含配置/聊天/原始日志内容；`status` 只返回发布元数据与容器状态。

## 安全与异常处理

- receiver 在一个持续 SSH 进程中持有 kernel flock，覆盖 inventory、接收、stage、备份、激活与验证。锁按 canonical sourceRoot 在宿主 `/run/lock` 中统一命名，换 stateRoot 也不能绕过互斥。每个 target 使用固定 profile；preview 与锁内 inventory 不同会拒绝，重新 dry-run。
- 停服只发生在完整校验/备份后。配置、源码工作树、NapCat 均有 guards；停服后记录原有会话字节，停止期间要求完全一致，启动后允许正常 append。
- 回滚只写本次管理的应用文件，不回写配置、源码、聊天或 Sticker 数据。发现 foreign output changes 时拒绝覆盖并保留 pending ledger。
- 断链/TERM/INT 尽力恢复；SIGKILL/掉电等不能捕获的中断保留持久台账，下次先 `status/recover`。已有校验过的本机 bundle cache 时，status/recover/rollback 不依赖 GitHub 在线。不要在不明状态下直接重复 deploy；不要删除 pending/backup 文件来强行解锁。
- no-op 不停服务，不替换 last-activated rollback pointer。健康部署的 stage cleanup 失败仅警告，不反向回滚。
- 备份保留在 stateRoot/runs 下，默认不自动删除。维护者确认不再需要恢复后再做受控清理；不能删除当前 pending 或最近激活备份。

## 快速替换的兼容边界

检查的是实际 Node major/ABI、workspace main/type/exports、runtime/peer declarations 和实际解析的依赖图，不仅是 package.json 或 node_modules 存在。纯构建依赖不要求线上升级。runtime 不兼容、workspace 新增/删除、陌生输出所有权或需要数据库迁移时，在停服前拒绝。

这些版本要走单独批准的依赖/源码升级流程，不能用此工具静默执行 install、修改线上源码或者覆盖业务数据。首次接管只接受已明确声明且兼容的 outputs，不擅自删除陌生文件。

## Auth / 网络排错

- Git push 认证由现有 Git Credential Manager 处理；确认有目标仓库 push 权限及 workflows 写权限，不公开 credential helper 输出。
- 本机使用代理时，由环境或当前命令显式设置；不要把本机代理地址硬编码到公开 workflows/脚本。Git 不一定使用系统 HTTP 代理，可仅对当前命令用 `git -c http.proxy=<local-proxy> ...`。
- Actions 手动入口须在默认分支，首次同步需要将 default 改成 dev。CI 无生产凭据；Release job 仅有 `contents:write` / `actions:read`。
- 网络/权限/兼容检查失败不代表已部署。以实际成功 CI、Release 资产校验和独立 target verification 为验收证据。
