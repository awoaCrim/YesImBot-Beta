# 执行计划：删除 ssh1 容器及应用数据

## 执行前

1. 用户已确认范围后运行 `task.py start`，再进入执行阶段。
2. 重新连接 `ssh1`，保存当前容器、镜像、volume、bind mount、systemd、Nginx、端口、磁盘和 failed unit 基线。
3. 断言目标集合为 `napcat`、`sillytavern`、`mihomo`、`metacubexd`；`natfrp-service` 必须是保留集合。
4. 断言删除 volume 名称为两个 NapCat volume 加两个当前 links=0 的 volume；如果 links 或归属发生变化，停止并更新清单。
5. 检查五个宿主机目录的 mount/process 引用，确认 `/etc/natfrp` 不在删除集合。
6. 检查 systemd unit FragmentPath 和 Nginx 配置引用；确认 `xxkcrimson.cn` 的 `st` block 可被唯一定位，`bs`/`api` block 不动。

## 执行顺序

1. 停止并禁用 `astrbot.service`、`mcp-fetch.service`、`mcp-sequential-thinking.service`、`terraria-tmodloader.service`；记录并移除关联 unit 文件和启用链接。
2. 停止并删除四个目标容器；验证 Natfrp 容器仍存在且运行中。
3. 删除四个目标镜像；验证 Natfrp 镜像仍存在。
4. 删除四个精确 Docker volumes；不执行任何全局 prune。
5. 删除 `/opt/atrbot`、`/opt/terraria`、`/opt/mcp-servers`、`/root/sillytavern-docker`、`/opt/mihomo` 五个精确目录。
6. 删除 MCP Nginx 配置文件/启用链接；从 `xxkcrimson.cn` 删除唯一的 `st.xxkcrimson.cn` server block，保留 `bs`/`api`；执行 `nginx -t` 后 reload。
7. 执行 `systemctl daemon-reload`，重新建立 SSH 连接。

## 验证

- `docker ps -a`：目标 4 个容器不存在，`natfrp-service` 仍 Up。
- `docker image ls`：目标 4 个镜像不存在，Natfrp 镜像保留。
- `docker volume ls`：4 个目标 volumes 不存在，未批准 volume 不变。
- `test -e`：五个删除目录不存在，`/etc/natfrp` 存在。
- `systemctl is-enabled/is-active`：关联 unit 不再 enabled/active；SSH、Nginx、Ollama、Docker、containerd 和 Natfrp 相关状态符合预期。
- `systemctl --failed`：没有非预期 failed unit。
- `nginx -t` 成功；Nginx 80/443 仍监听，MCP 9200 和删除目标容器端口停止，Natfrp 7102 仍监听。
- 新 SSH 连接成功，磁盘占用和清理量记录到 research。

## 回滚点

- 任一 preflight 集合不匹配：不执行删除。
- Docker 删除后 Natfrp、SSH 或 Docker daemon 异常：停止后续步骤并报告。
- Nginx 配置测试失败：使用本次临时副本恢复配置，重新 `nginx -t`；不删除证书。
- 删除应用目录后服务异常：不盲目重建；记录不可逆影响和可恢复来源。

## 完成条件

只有在 Natfrp、SSH、Nginx、Ollama、Docker/containerd 验证通过，目标资源和路径确认不存在，且结果记录完成后才可报告完成。不要提交 Git commit。
