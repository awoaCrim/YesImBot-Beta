# 技术设计：ssh1 文件清理

## 1. 清理边界

本任务是一次受控的远程运维操作，不修改项目源码。

### 明确禁止修改

- `/var/lib/docker` 及其所有子路径：不删除、不 truncate、不执行任何 Docker prune。
- 操作系统核心目录：`/etc`、`/usr`、`/bin`、`/sbin`、`/lib*`、`/boot`、`/dev`、`/proc`、`/sys`、`/run`。
- 未明确登记的系统/服务状态目录：`/var/lib`、`/var/spool`、`/var/mail`、`/srv`、`/usr/local`，以及 `/var` 下除明确 cache/journal 对象外的内容；系统包本身不做卸载。
- SSH、证书、凭据和 Docker 连接配置：`/root/.ssh`、所有用户的 `~/.ssh`、`/etc/ssh`、`/etc/ssl`、`/etc/letsencrypt`、`/root/ssh-credential`、`/root/.acme.sh`、`/root/.docker`。
- 当前服务或容器使用的宿主机路径：`/opt/atrbot`、`/opt/mcp-servers`、`/root/sillytavern-docker`、`/etc/natfrp`。

### 允许处理

- 执行前确认没有服务、进程、计划任务或 Docker bind mount 依赖的应用目录：候选为 `/opt/mooc`、`/root/ds2api`、`/root/.vscode-server` 等；任何被 enabled unit（即使当前未 active）引用的目录，例如 `/opt/terraria`，必须保留。
- 明确的用户/工具缓存子目录，例如 npm、Python、Claude 和用户 cache；不把整个用户目录作为一个未分类对象删除。
- APT cache；systemd journal 仅在明确保留期限（至少 30 天，并保留当前 boot）后 vacuum；普通应用日志默认跳过，除非逐个登记。

## 2. 处理流程

1. **只读 preflight**：确认 SSH 主机身份、OS、磁盘、active systemd 服务、Docker 容器和 bind mount。
2. **生成精确清单**：逐项记录路径、类型、大小、原因和动作；解析真实路径，检查是否落入禁止前缀。
3. **依赖复核**：对每个应用目录检查所有 active/enabled systemd unit、timer、socket、path、root 和相关用户的 cron/user unit、运行进程的 cwd/root/executable/open files、Nginx/脚本引用和 Docker mount；任意检查不明确就跳过。
4. **挂载复核**：对候选路径执行 `findmnt --target <path>` 和递归 `findmnt -R <path>`；候选及全部子路径不得是 mount point，也不得覆盖任何 Docker bind mount source 的祖先或子路径。最终删除前立即重复。
5. **敏感内容复核**：递归检查 `.env*`、`*.pem`、`*.key`、`*.crt`、`*.p12`、`*.pfx`、`authorized_keys`、`known_hosts`、`id_*`、`credentials*`、`token*`、`secret*`、数据库、上传、备份和配置文件；发现敏感或用途不明内容时拆分精确子路径或跳过整体目录。
6. **低风险清理**：先执行 APT cache 和明确缓存子目录；journal 只按明确保留期限 vacuum，普通旧日志默认跳过；每步后记录释放空间。
7. **应用目录清理**：仅对已登记、未被依赖、无 mount、无敏感/用户数据风险且用户已确认安全边界覆盖的精确目录执行；不使用根目录或父目录 wildcard。
8. **远程复核**：重新连接 SSH，比较清理前后 active/enabled unit、failed unit、Docker 容器 ID/名称/镜像/状态、关键监听端口和候选路径引用。
9. **记录结果**：把实际删除、跳过、释放空间和剩余候选写入任务 research 记录。

## 3. 安全约束实现

- 所有远程脚本使用 `set -euo pipefail` 和安全的固定路径数组。
- 任何删除前检查 `readlink -f`、`findmnt --target`、递归 `findmnt -R` 和候选目录内的敏感文件；候选不能是 mount point、不能包含嵌套 mount，也不能覆盖 Docker bind mount source。
- 任何删除前保存基线：active/enabled unit、timer/socket/path、root/相关用户 cron 和 user unit、候选相关进程引用、failed unit 集合、关键监听端口、Docker 容器 ID/名称/镜像/状态及 mount 清单。
- 不使用 `find / ... -delete`、`rm -rf /opt/*`、`rm -rf /root/*` 等广泛表达式。
- Docker 相关命令只读检查容器和挂载；执行阶段完全不调用 Docker prune、容器日志截断或卷操作。
- 保留 SSH 会话到删除完成后重新建立连接，避免只依赖当前连接的假设。

## 4. 结果与回滚

本任务不创建全量远程备份；大规模应用目录删除在本质上不可逆。因此：

- 删除前必须完成最终精确清单和依赖复核；任意异常、命令输出不完整或检查无法解释时直接停止，不进入删除阶段。
- 先做低影响 cache/log 动作，再做应用目录动作；每个阶段独立记录结果。由于当前磁盘仅使用约 9%，cache/log 清理不是强制项。
- 如果验证发现服务异常，立即停止后续清理，恢复能从包管理器或应用部署来源恢复的缓存/程序；对用户数据目录不做盲目重建。
- 未进入清单、未通过依赖检查、包含敏感/配置/数据库/上传/备份内容或用途不明的路径保持不变。
