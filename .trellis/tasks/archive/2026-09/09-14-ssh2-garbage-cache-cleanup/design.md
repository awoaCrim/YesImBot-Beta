# 技术设计：ssh2 垃圾和缓存清理

## 1. 变更边界

本任务不是仓库代码变更，而是一次受控的 `ssh2` root 级运维操作。目标行为是：删除已经盘点并符合规则的 NewAPI 请求快照、旧备份 bundle、旧的未被任何容器引用的 Docker 镜像，以及 BuildKit/APT 缓存；除此之外不改变服务配置和运行状态。

明确不做：

- 不修改仓库源码、Docker Compose、NewAPI/Koishi 配置或数据库记录。
- 不停止或重启服务来完成清理。
- 不使用 `docker system prune`、`docker image prune -a`、`docker volume prune` 或全量 `/tmp`/日志清理。
- 不读取任何快照、数据库、备份内容或凭据；所有审计都是 metadata-only。

## 2. 保护边界与输入契约

### 2.1 路径白名单

允许执行删除的宿主机路径只有：

- `/opt/newapi/data/request_snapshots`：只允许删除该目录当前树，不能触碰其兄弟数据库文件。
- 以下 backup 根的、审计后明确识别的旧版本化直接子目录：
  - `/opt/9router/backups`
  - `/opt/9router-data/db/backups`
  - `/opt/caimogu-bot.deployments/<现有 deployment>/backup`
  - `/opt/cliproxyapi-compose/backups`
  - `/opt/cmdcode2api/backups`
  - `/opt/gemini-web2api/backups`
  - `/opt/newapi/backups`
  - `/opt/resin/backups`
  - `/opt/yesimbot/backups`

`<现有 deployment>` 只能来自清理前对白名单父目录的直接目录枚举，不允许通过通配符直接执行删除。白名单之外即使名称包含 `backup` 或 `cache` 也跳过。

Docker 镜像删除不使用路径白名单，而使用清理前通过 Docker metadata 解析出的精确 image ID 清单；清单之外的 image ID 不得传给删除命令。

### 2.2 保护对象

清理前建立以下保护集合：

- 全部容器的 ID、名称、状态、健康状态、restart count 和 image ID；运行中和停止容器均纳入。
- 目标 NewAPI 容器 `newapi` 的挂载关系，必须确认 `/opt/newapi/data` 映射到容器 `/data`。
- `/opt/newapi/data/one-api.db`、`one-api.db-wal`、`one-api.db-shm` 的存在性、类型、大小和时间元数据。
- 每个 backup 根的候选目录和最新保留项。
- Docker volumes 清单和容器到 image ID 的引用关系。

如果容器集合、关键挂载、目标目录类型或保护对象在变更前发生漂移，则中止所有尚未开始的破坏性阶段。

## 3. 审计与记录模型

所有远程受控脚本必须启用 `set -euo pipefail`，对 Docker inspect 的可选字段使用 `index` 形式（例如 `index .State "Health"`），不能因缺失可选字段继续执行破坏性操作。使用一个 root-only、短生命周期的审计状态（优先放在 `/run`，不写入业务目录），只保存：

- `df`/目标目录的字节数、文件数量和时间范围。
- 容器 ID、名称、状态、健康状态、restart count、image ID；不保存环境变量、命令行中的 secret 或容器日志。
- image ID、repository/tag、Docker `Created` 的 ISO 时间、转换后的 Unix epoch、大小，以及是否被任意容器引用。
- backup 根、候选直接子目录名称、目录 mtime、总大小和保留/删除判定。
- BuildKit/APT 清理前后统计。

不读取文件正文、不解密 `.snap`、不执行数据库查询、不计算或输出凭据文件内容的 hash。清理完成后删除临时审计状态；若异常留下，只能包含上述非敏感元数据。

## 4. NewAPI 请求快照清理

### 4.1 原子替换

1. 确认 `/opt/newapi/data/request_snapshots` 是真实目录而非符号链接，目录内部不包含跨文件系统挂载；确认 `newapi` 仍处于清理前状态，且没有进程打开该目录。
2. 记录原目录 owner、group、mode、ACL（若存在）和目录树的数量/字节数。
3. 在同一父目录下生成不可预测但可验证的 retired 名称，将原目录用同文件系统 `rename` 改名为该 retired 目录。退休路径必须由脚本变量持有，禁止对 `*` 或用户输入展开删除。
4. 按原 owner/group/mode 创建新的空 `request_snapshots` 目录，并复核路径、权限和挂载关系；应用继续使用原路径时，新写入只会进入新目录。
5. 只删除刚刚重命名得到的 retired 目录。删除前再次确认其绝对路径的父目录为 `/opt/newapi/data`，basename 匹配本次唯一 marker，且不是当前 `request_snapshots`。
6. 删除完成后确认当前目录存在、为空或只含清理期间新生成的 `.snap` 文件；确认数据库兄弟文件未被删除。

这不会关闭快照功能，也不需要重启 NewAPI。若原子改名或新目录创建失败，保持原目录不动并中止后续清理。若 retired 目录删除中途失败，保留该路径并报告，不用 `rm -rf` 其他路径代偿。

### 4.2 快照回滚边界

在 retired 目录删除完成前，如果新目录没有新文件，可以删除空新目录并将 retired 目录改回原名；一旦新目录已有新写入或 retired 目录已删除，不自动回滚，以免覆盖新快照。快照本身不是数据库状态，回滚仅代表恢复历史审计文件，不影响 NewAPI 继续运行。

## 5. 备份保留策略

### 5.1 候选识别

对每个白名单 backup 根只枚举直接子项：

- 只把真实目录、名称带明确版本/时间语义、且目录 mtime 可确定的项视为 backup bundle 候选。
- 根目录下的直接文件、符号链接、未知命名目录、嵌套目录以及无法判断用途的项全部保留。
- 每个根最多删除“最新候选之外”的旧候选；若只有零或一个候选，不删除。
- 以目录时间元数据为主、名称中的时间戳为交叉校验；时间冲突或候选无法排序时跳过该根。

每个显式根是一个独立回滚单位。`/opt/caimogu-bot.deployments/*/backup` 按实际 deployment 路径分别处理；`/opt/9router/backups` 和 `/opt/9router-data/db/backups` 也分别保留一个，避免把应用归档和数据库迁移归档混为一个候选集。

### 5.2 删除方式

先生成保留/删除清单并复核保护条件，再按清单逐个删除旧目录。删除动作只能接收清单中的绝对路径；路径必须仍是预期根的直接子目录，且目录 mtime/类型与清单一致。任何漂移都使该项跳过，不删除同根的其他项。

最新备份必须先验证仍存在后，才能删除同根旧项。若某个旧 bundle 删除失败，不扩大范围；记录失败项并继续或中止后续阶段取决于服务状态和脚本守卫，但不得重试未知路径。

## 6. Docker 未使用镜像收缩

### 6.1 引用解析

通过 `docker inspect`/Docker metadata 得到所有容器实际 image ID，使用 image ID 而非 repository/tag 作为保护键。任何容器（包括已停止的 `caimogu-bot-before-*`）引用的 image ID 都保护。

对剩余镜像：

1. 忽略 `<none>`、无 repository 归属、无法从 metadata 归入项目的镜像。
2. 按 repository/project 名称分组，聚合同一 image ID 的多个 tag。
3. 使用 Docker `Created` 的 ISO 时间转换为 Unix epoch 后进行数值排序（不能直接按带时区的展示字符串或名称排序），每组保留最新的未引用 image ID。
4. 只有当同组存在更旧未引用 image ID 时，才将其加入精确删除清单；同一 image ID 若在任何分组中是保留项，则整体保留。

### 6.2 删除与保护

删除时逐个传入已复核的 image ID，并使用不主动清理 parent image 的选项；不执行 image prune。Docker 若报告该 ID 已被容器、tag 或 layer 依赖引用，则跳过并报告。删除后复查：所有容器 image ID 未变化，停止容器仍存在，受保护镜像仍存在，Docker volumes 清单未变化。

## 7. BuildKit 与 APT 缓存

在确认没有正在运行的 apt/dpkg 事务后：

- 仅清理 Docker BuildKit build cache，并记录清理前后的 BuildKit 可回收量。
- 仅清理 APT archive cache；不删除 APT lists，不改软件源，不升级软件包。

这两个阶段不要求服务停止。若锁被占用或命令返回异常，跳过对应缓存并在报告中说明，不用删除锁文件或干预 apt/dpkg。

## 8. 阶段顺序与失败策略

顺序固定为：

1. 只读预检和保护快照。
2. 检查最新备份存在、检查快照路径和容器状态守卫。
3. 原子替换并删除旧请求快照。
4. 删除每个 backup 根的旧版本化 bundle。
5. 删除精确镜像清单中的旧未引用镜像。
6. 清理 BuildKit/APT cache。
7. 重新审计并做服务/数据完整性验证。

任一前置守卫失败时，不进入后续破坏性阶段。阶段已经产生的删除不自动伪造回滚；保留现场、记录精确失败阶段和剩余项。若服务状态、容器集合、关键挂载或关键数据库文件出现非预期变化，立即停止后续阶段并优先做验证，不主动重启服务。

## 9. 兼容性与回滚

- NewAPI 只看到同一路径下的新快照目录，数据库和应用配置不变；可能在清理后重新产生少量 `.snap` 文件。
- YesImBot、NapCat、代理、数据库和其他容器不需要感知本次变化。
- 旧备份 bundle、旧未引用镜像和已删除请求快照在本机上不可保证恢复；恢复它们需要外部备份、重新拉取镜像或重新构建。
- BuildKit/APT cache 只影响未来构建/安装的下载速度和磁盘占用。
- 保留每个 backup 根的最新 bundle、所有容器引用镜像和停止容器，是本次操作提供的本地回滚基础。

## 10. 验证契约

清理后必须同时满足：

- 根分区和目标空间统计可比较，报告实际释放量。
- `newapi` 及所有清理前容器仍存在；每个容器的运行/停止状态和健康状态与预检一致，restart count 没有因本次操作增加。
- `request_snapshots` 当前路径存在、权限与原目录一致；旧树不再挂在原路径；`one-api.db`、WAL/SHM 仍存在。
- 每个 backup 根的最新候选存在；跳过项和未处理根有清单。
- 被停止容器引用的两个 caimogu 镜像仍存在；容器 image ID、Docker volumes 和运行中服务未被清理动作改变。
- BuildKit/APT 统计反映已清理或明确跳过。
