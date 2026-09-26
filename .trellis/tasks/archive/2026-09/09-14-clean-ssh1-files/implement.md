# 执行计划：ssh1 文件清理

## 执行前

1. 用户批准本计划后运行 `task.py start`，再进入执行阶段。
2. 通过 `ssh1` 重新执行只读 preflight，确认主机仍为 Debian 13、用户仍为 `root`，并记录新的磁盘和服务基线。
3. 重新收集 active/enabled systemd unit、timer、socket、path、root 和相关用户的 cron/user unit、运行进程引用、关键监听端口和 Docker bind mount；任何与先前盘点不一致时停止并更新计划。
4. 保存清理前基线：active/enabled unit 集合、failed unit 集合、关键监听端口、候选相关进程的 cwd/root/executable/open files、Docker 容器 ID/名称/镜像/状态和 mount 清单。
5. 生成本地精确候选清单，至少包含：真实路径、文件/目录类型、字节数、最后修改日期、分类、删除原因、依赖检查结果、是否包含敏感/配置/数据库/上传/备份内容。
6. 对每个候选执行 `findmnt --target <path>` 和 `findmnt -R <path>`；候选及全部子路径不能是 mount point，也不能覆盖任何 Docker bind mount source 的祖先或子路径。
7. 清单必须明确排除 `/var/lib/docker`、Docker bind mount、SSH/凭据目录、系统目录和 active 服务路径。

## 候选分类

- **低影响、可选清理**：`apt-get clean`、明确的 npm/Python/Claude/用户 cache 子目录。当前磁盘仅使用约 9%，这些操作不是强制项，且会牺牲离线恢复缓存。
- **日志处理**：普通应用日志默认跳过；如执行 journal vacuum，至少保留最近 30 天并保留当前 boot 日志，不使用广泛 `find` 删除 `/var/log`。
- **需要依赖和内容复核后清理**：`/opt/mooc`、`/root/ds2api`、`/root/.vscode-server` 等非 active 应用/工具目录。发现 `.env*`、证书/密钥、凭据、配置、数据库、上传、备份或用途不明内容时，不整体删除；`/opt/terraria` 因 enabled 的 `terraria-tmodloader.service` 保留。
- **明确保留**：`/var/lib/docker`、`/opt/atrbot`、`/opt/mcp-servers`、`/root/sillytavern-docker`、`/etc/natfrp`、SSH/证书/凭据目录和系统核心目录。

## 执行顺序

1. 保存只读基线到任务 research 记录，不记录密码、token、UUID、私钥或配置内容。
2. 扫描候选目录中的 `.env*`、`*.pem`、`*.key`、`*.crt`、`*.p12`、`*.pfx`、`authorized_keys`、`known_hosts`、`id_*`、`credentials*`、`token*`、`secret*`、数据库、上传、备份和配置文件；命中后拆分到精确安全子路径或跳过。
3. 立即重复检查候选 mount 和 Docker bind mount 关系；任意 mount、嵌套 mount、Docker source 祖先/子路径或检查不完整时跳过。
4. 执行低影响 cache/log 清理；不卸载系统包，不运行 `apt autoremove`。journal 只按已批准的 30 天保留策略 vacuum。
5. 对每个应用/工具目录逐项再次检查 active/enabled unit、timer/socket/path、cron/user unit、进程 cwd/root/executable/open files、Nginx/脚本引用、Docker mount 和符号链接；通过后才删除精确路径。
6. 每个删除阶段都记录命令结果和释放空间；遇到权限、路径解析、内容分类或依赖异常立即停止。
7. 删除完成后断开并重新建立 SSH 连接。

## 验证

- `df -hT`：确认空间变化合理。
- `systemctl is-active` 和 active/enabled unit 集合比较：检查 SSH、Nginx、Ollama、AstrBot、MCP、Docker、containerd 等已知服务以及 timer/socket/path。
- `systemctl --failed --no-legend --no-pager`：比较清理前后的 failed unit 集合，确认没有新增失败单元。
- 比较清理前后关键监听端口和候选路径相关进程的 cwd/root/executable/open files。
- `docker ps --no-trunc`：比较容器 ID、名称、镜像和状态；重新确认 Docker mount 清单未被本任务命令改变，且不读取或修改 `/var/lib/docker` 内容。
- 重新检查保留路径存在性、候选路径的 mount 状态，以及候选路径确已删除或被明确跳过。
- 断开后新建 SSH 连接完成上述验证，不能只在原连接中继续执行。
- 记录清理前后占用、实际释放空间、删除清单、跳过清单和未处理风险。

## 回滚点

- preflight 或精确清单发现路径冲突：不做任何删除，回到规划阶段。
- 低风险清理后服务异常：停止应用目录清理，先恢复服务并报告。
- 应用目录删除后验证异常：不继续其它删除；仅执行有明确来源的恢复动作，不用猜测内容重建数据。

## 完成条件

只有在 SSH、已知 systemd 服务、Docker 容器和 failed units 验证通过，并且结果记录完成后，才可报告任务完成。不要提交仓库代码变更。
