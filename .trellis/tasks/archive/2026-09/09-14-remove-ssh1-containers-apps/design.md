# 技术设计：删除 ssh1 容器及应用数据

## 1. 删除与保留边界

### 删除

- Docker 容器：`napcat`、`sillytavern`、`mihomo`、`metacubexd`。
- 以上 4 个容器对应的镜像，不删除 Natfrp 镜像。
- NapCat 的两个 named volumes：`3329d80d19919fea5f925f06b248dabc1542550728233c41208e8836fc2f8920`、`fb7438f5007b4c96fd30eb826d6d86ea87095953c8d917f37ca7fc258dc402a9`。
- 两个当前未被容器链接的 volumes：`c21f6494811e298c37280a2e6b33cd6fa575ecfa8b51879a213b69956e665a70`、`1c06b90226ee62ea0693bba98dae07ef59ca2185357f19947fe9fc9b130c76bd`。
- 宿主机应用目录：`/opt/atrbot`、`/opt/terraria`、`/opt/mcp-servers`、`/root/sillytavern-docker`、`/opt/mihomo`。
- 关联服务 unit：`astrbot.service`、`mcp-fetch.service`、`mcp-sequential-thinking.service`、`terraria-tmodloader.service`，包括其启用链接。
- MCP Nginx site 配置；`xxkcrimson.cn` 中仅删除 `st.xxkcrimson.cn` 指向 SillyTavern 的 server block。

### 保留

- Natfrp 容器 `natfrp-service`、Natfrp 镜像和 `/etc/natfrp`。
- SSH、Nginx、Ollama、Docker、containerd 及其系统配置。
- SSH/证书/凭据目录、Nginx SSL 证书和 `xxkcrimson.cn` 中 `bs`/`api` server blocks。
- `/var/lib/docker` 目录本身不做全盘清空；Docker 资源只通过精确命令处理。

## 2. 执行流程

1. **只读基线**：重新确认容器 ID/镜像/状态、volume links、bind mount、systemd unit、Nginx 引用、磁盘、端口和 failed units。
2. **停止依赖**：停止并禁用 AstrBot、MCP、Terraria 关联 unit；确认 Natfrp、SSH、Docker、Nginx、Ollama 不受影响。
3. **删除 Docker 目标**：按当前 ID/名称删除 4 个非 Natfrp 容器，按当前镜像 ID 删除 4 个目标镜像，再按精确 volume 名称删除 4 个目标 volumes。
4. **删除宿主机目录**：只删除批准的 5 个精确目录；先确认不存在 mount、进程引用或 Natfrp bind mount。
5. **删除关联配置**：移除关联 systemd unit 文件和启用链接；删除 MCP Nginx 配置；从 `xxkcrimson.cn` 精确移除 `st.xxkcrimson.cn` block；执行 `systemctl daemon-reload` 和 `nginx -t`。
6. **新连接验证**：断开当前 SSH 后重新连接，检查 Natfrp、SSH、Nginx、Ollama、Docker/containerd、端口和 failed units。

## 3. 安全约束

- 每个 Docker 操作使用当前盘点得到的精确名称/ID；删除前确认 Natfrp 容器和镜像不在目标集合。
- 禁止 `docker system prune -af --volumes`、`rm -rf /var/lib/docker`、`docker volume prune` 和根目录 wildcard。
- `/etc/natfrp`、Nginx SSL 证书、SSH/凭据路径进入硬性排除表；候选目录不能是 mount point，也不能覆盖保留路径。
- 删除 systemd unit 前先停止/禁用并记录 FragmentPath；删除后 `daemon-reload`，不能留下 enabled 的失效 unit。
- 修改 Nginx 前验证目标文件和 `st.xxkcrimson.cn` block 的唯一性；保留同文件中的 `bs`/`api` blocks；修改后必须 `nginx -t` 成功才能 reload。
- 所有远程脚本使用固定数组和 `set -euo pipefail`，异常时停止后续删除。

## 4. 结果与回滚

本次删除应用数据、容器、镜像和 volumes 是不可逆的，用户已明确授权。Nginx 配置修改应先做临时副本并在测试失败时恢复；systemd unit 删除前记录路径。若 Natfrp、SSH、Nginx 或保留服务验证失败，停止后续动作并报告，不进行猜测性重建。
