# ssh2 清理执行结果

执行日期：2026-09-14。以下只记录非敏感 metadata，不包含请求正文、数据库内容、备份内容、凭据或 token。

## 已完成

- NewAPI 实际容器 `newapi` 的 `/opt/newapi/data/request_snapshots` 已通过同文件系统原子替换清理：旧树 13,014 个文件、10,738,334,960 bytes；新目录存在、权限 `700`、owner/group `0/0`、当前 0 个文件；退休目录已删除。
- `/opt/newapi/data/one-api.db`、`one-api.db-wal`、`one-api.db-shm` 均仍为 regular file；NewAPI 仍为 `running`，restart count 为 `0`，挂载仍为 `/opt/newapi/data -> /data`。
- 白名单 backup 根共删除 42 个旧版本化直接子目录，合计 453,411,017 bytes；每个有多个可排序候选的根保留最新项。两个 `caimogu-bot.deployments/*/backup` 根没有可识别的版本化直接 bundle，直接文件和未知目录均保留。
- Docker 删除 1 个明确未被任何容器引用的镜像：`golang:1.26.1-alpine`，镜像大小 241,128,318 bytes；`golang:1.25-alpine` 作为该 repository 的最新未引用镜像保留。
- Docker BuildKit cache 已清理到 0；APT archive cache 从 177,233,624 bytes 降到 24,576 bytes。
- Docker 从 27 个镜像变为 26 个；容器仍为 21 个（19 running、2 exited），volume 仍为 12 个；停止的 `caimogu-bot-before-*` 容器及其镜像仍存在。
- 根分区 used 从 42,652,472 KiB 降到 31,066,004 KiB，按 `df` 统计减少 11,586,468 KiB（约 11.865 GB / 11.050 GiB）。

## 后置验证

- 使用修正后的 Docker Go template（通过 `index .State "Health"` 处理无 Health 字段容器）逐一检查 21 个容器：容器 ID、名称、运行/停止状态、健康状态、restart count 和 image ID 均符合清理前盘点；restart count 均为 0。
- `yesimbot-koishi`、`yesimbot-napcat`、`newapi` 均保持运行，未执行重启；`caimogu-bot`、`resin`、`grok2api` 健康状态仍为 healthy。
- 快照新目录无符号链接、无 retired 目录；数据库三个文件仍存在；backup 根的最新候选和应保留的未知项仍存在。

## 过程质量记录

第一次备份阶段脚本在容器状态采集时直接访问可选的 `.State.Health` 字段，产生 3 条 Docker template parsing error；同时该次脚本漏写 `set -e`，使失败断言没有立即中止。删除路径本身仍受白名单根、直接子目录、目录类型、mtime 和设备号守卫约束，后续已使用 `set -euo pipefail` 和 `index .State "Health"` 的修正模板完成完整 21 容器后置核对，未发现服务、容器、镜像引用或 volume 发生非预期变化。

后续同类脚本必须：

1. 固定使用 `set -euo pipefail`。
2. 对 Docker inspect 的可选字段使用 `index`，不能假设 `.State.Health` 一定存在。
3. 对时间排序先将 Docker `Created` ISO 时间转换为 Unix epoch，再做数值排序；不能直接按带时区展示字符串排序。该问题已在实际镜像删除前的 dry-run 中发现并修正，最终只删除了较旧的 `golang:1.26.1-alpine`。
