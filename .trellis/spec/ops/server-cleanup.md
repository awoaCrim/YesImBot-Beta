# 服务器文件清理合同

## 1. Scope / Trigger

适用于通过已确认的 SSH alias 对 Linux 主机进行缓存、应用构建产物、用户工具目录或旧文件清理的任务，尤其是用户提出“除了某目录其它都可以删”的宽泛授权时。

该授权只能作为候选评估范围，不能替代逐路径删除批准。系统核心目录、凭据、服务依赖、Docker bind mount 和用途不明内容始终优先保留。

## 2. Signatures

### 远程只读盘点

```text
ssh <confirmed-alias> <read-only-inventory-command>
```

必须输出但不得输出凭据内容：

- 主机身份、OS、用户和磁盘占用
- active/enabled systemd service、timer、socket、path
- root 和相关用户的 cron/user unit 文件名
- 运行进程引用、关键监听端口
- Docker 容器 ID/名称/镜像/状态和 bind mount source/destination
- 候选路径的真实路径、大小、mount 状态和敏感文件名

### 精确删除

```text
ssh <confirmed-alias> <fixed-path-delete-script>
```

删除脚本只接受执行前登记的固定路径数组，不接受根目录、父目录或 wildcard 输入。

## 3. Contracts

### 请求/授权边界

- 用户必须明确授权远程写入和删除。
- `/var/lib/docker` 若被列为保留路径，禁止执行 Docker prune、卷/镜像清理、容器日志截断和任何直接删除。
- 候选路径必须是精确 realpath，且不属于系统核心目录、凭据目录、服务路径或 Docker bind mount。

### 保留合同

默认保留：

- `/etc`、`/usr`、`/bin`、`/sbin`、`/lib*`、`/boot`、`/dev`、`/proc`、`/sys`、`/run`
- 未明确登记的 `/var`、`/var/lib`、`/var/spool`、`/var/mail`、`/srv`、`/usr/local`
- SSH、证书和凭据：所有用户 `~/.ssh`、`/etc/ssh`、`/etc/ssl`、`/etc/letsencrypt`、应用 `.env`/密钥/证书/凭据文件
- 任何 active **或 enabled** unit、timer、socket、path 使用的目录
- 所有运行中 Docker 容器的 bind mount source 及其祖先/子路径

### 成功结果

删除后必须满足：

- 新建 SSH 连接成功
- 清理前后 active/enabled unit 集合无非预期变化
- failed unit 集合没有新增项目
- 关键监听端口没有非预期变化
- Docker 容器 ID、名称、镜像和状态保持一致
- 保留路径存在，目标路径已删除或明确跳过

## 4. Validation & Error Matrix

| 条件                                                                    | 处理                                     |
| ----------------------------------------------------------------------- | ---------------------------------------- |
| SSH alias、主机名或用户不匹配                                           | 立即停止，不写入远端                     |
| 候选路径无法 `readlink -f`                                              | 跳过候选，不删除                         |
| `findmnt --target` 或 `findmnt -R` 发现候选/子路径是 mount              | 跳过候选，不删除                         |
| 候选覆盖 Docker bind mount source，或位于其下                           | 跳过候选，不删除                         |
| active/enabled service、timer、socket、path、cron 或 user unit 引用候选 | 保留候选并报告                           |
| 进程 cwd/root/exe/open file 引用候选                                    | 保留候选并报告                           |
| 候选包含 `.env*`、密钥、证书、凭据、数据库、上传、备份或用途不明配置    | 不整体删除，拆分到精确安全子路径或跳过   |
| 检查命令权限不足、输出不完整或结果无法解释                              | 视为失败，停止删除阶段                   |
| 删除后 SSH、服务、端口或容器验证失败                                    | 停止后续动作，报告不可逆风险，不盲目重建 |

## 5. Good / Base / Bad Cases

- **Good**：`/home/user/.npm/_cacache` 无 mount、无进程引用，仅清理其内容并保留父目录。
- **Good**：应用目录含 `.env`、数据库和 uploads 时，只删除已确认的 `.git` 或 `node_modules` 精确子目录。
- **Base**：应用目录没有 active unit，但有 enabled unit；按服务依赖保留，不能只看当前是否 active。
- **Base**：systemd journal 只按明确保留期限 vacuum；普通应用日志逐个登记，不能广泛按年龄删除。
- **Bad**：执行 `rm -rf /opt/*`、`rm -rf /root/*` 或 `find / -delete`。
- **Bad**：看到 Docker 数据占用大就运行 `docker system prune`，即使用户说 Docker 目录不要动。
- **Bad**：只检查 active services，不检查 enabled services、timer、cron、user units 和 Docker bind mounts。

## 6. Tests Required

运维任务没有传统单元测试时，必须执行以下可重复验证并记录结果：

1. 清理前后磁盘和候选路径大小对照。
2. 清理前后 active/enabled unit、timer/socket/path 集合对照。
3. 清理前后 failed unit 集合对照，断言无新增。
4. 清理前后关键监听端口对照。
5. 清理前后 Docker 容器 ID、名称、镜像、状态和 bind mount 对照。
6. 新建 SSH 连接验证，而不是只复用删除操作的原连接。
7. 断言 `/var/lib/docker`、凭据目录、活跃/启用服务路径仍存在，精确目标已删除或跳过。

## 7. Wrong vs Correct

### Wrong

```bash
# 用户说“除了 Docker 都可以删”，于是按目录名整体删除
rm -rf /opt/* /root/* /home/*
docker system prune -af --volumes
```

问题：会删除系统服务依赖、凭据、Docker bind mount 和用户数据，且无法证明服务仍可恢复。

### Correct

```bash
# 先固定候选，逐个检查 realpath、mount、service/cron、进程和敏感文件
candidates=(/home/user/.npm/_cacache /opt/app/node_modules)
# 通过所有检查后，仅对 candidates 中登记的精确路径执行删除；保留 Docker、系统和服务路径
```

关键差异：用户授权定义评估范围，检查结果决定单个路径是否可删除；任何不确定项都跳过。
