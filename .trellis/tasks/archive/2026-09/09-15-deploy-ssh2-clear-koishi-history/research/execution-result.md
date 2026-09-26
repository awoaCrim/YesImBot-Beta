
## Post-deployment remediation and natural-flow observation

独立复核发现两项需要立即修正的运维问题，均在不发送消息、不读取正文的情况下处理：

1. 初版 `rollback.sh` 传入参数顺序与 runner CLI 不匹配。已修正为直接调用 `rollback`/`rollback-check` phase，并执行：

   ```text
   /opt/yesimbot/backups/deploy-ssh2-clear-20260915T163054Z-12868/rollback.sh --check
   ```

   结果为 `status=ready`、9 个 candidate 文件、9 个 dist backup、2 个 history backup，live candidate hashes 和 backup hashes 均为 `ok`，`serviceTouched=false`。

2. Windows 本地 mode `438`（八进制 `0666`）被初版 manifest 带入 Linux dist。内容 hash 没有变化，但生产文件 mode 初始为 `0666`。已对 9 个固定候选路径逐一先校验内容 hash，再 hash-guarded `chmod 0644`；修正后 mode 集合为 `[0644]`，代码内容未改变。后续独立复核确认 9 个候选文件 hash 和 mode 均正确。

在清理完成并服务恢复后，远端出现了 1 个不属于执行前 manifest 的新 session 文件，当前约 `5,498` bytes。任务没有发送平台消息，也没有读取该文件；根据保护合同未删除该新文件。另有一个 guild `willingness.json` 在服务恢复后发生 metadata/hash 变化（`1,117` → `1,118` bytes），而 baseline 到 after-stop 期间保持不变。该运行时变化未被任务写入、覆盖或回滚，当前状态原样保留。

因此最终语义为：执行前发现的 2 个 session、`1,192,865` bytes 已完成清理；清理后自然运行产生的新 session 不属于本次删除清单，保留并报告。最终 package、HTTP、容器和 startup checks 仍通过，且 pre-existing session remaining 为 `0`。

## 最终独立复核摘要

- backup 目录仍存在且 mode `700`；临时 staging 已不存在。
- `yesimbot-koishi` 与 `yesimbot-napcat` 均 running、exit 0、OOM false；NapCat ID/StartedAt/restart count 未变。
- Koishi HTTP 为 `200`；Core/Agent runtime candidate hashes 与 mode `0644` 均通过；两个 package 均可解析并加载。
- startup fatal/uncaught/module-resolution/startup-failure signals 均为 `0`。
- 受保护文件和目录在部署停机窗口内无变化；启动后的 willingness 变化未被本任务恢复或删除。
- 关键监听端口（SSH `22`、Koishi `15140`、其它已登记端口）保持；全量 `ss` hash 的瞬时差异只涉及 Docker/transient listener 状态，不作为任务写入证据。

## 后续部署位置更新（2026-09-27）

- 后续已将 Koishi（连同 NapCat）从 SSH2 无损迁移至 SSH1；SSH1 当前运行新的 `yesimbot-koishi` 与 `yesimbot-napcat`。
- SSH2 上原有 Koishi/NapCat 容器、旧 images、旧 volumes 及 `/opt/yesimbot` 已清理；SSH2 Caddy、反向 tunnel 与 forwarder 保留，用于继续承载公网入口。
- 当前公网验证：Koishi 返回 `200`，NapCat WebUI 返回 `301`；旧 SSH2 服务不再作为运行位置。
