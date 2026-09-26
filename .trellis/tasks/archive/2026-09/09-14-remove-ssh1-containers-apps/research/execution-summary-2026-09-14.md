# ssh1 容器及应用数据删除结果

执行日期：2026-09-14

## 删除完成

### Docker

删除了 4 个非 Natfrp 容器：

- `napcat`
- `sillytavern`
- `mihomo`
- `metacubexd`

删除了以上 4 个对应镜像，以及 4 个用户批准的 volumes：两个 NapCat volumes 和两个原本未被容器链接的 volumes（约 1.301GiB、873B）。

Docker 最终只剩：

- `natfrp-service`，状态 `Up`
- `ghcr.io/natfrp/launcher` 镜像
- 无 Docker named volume

未执行全局 prune，未删除或清空 `/var/lib/docker`。

### 宿主机目录和服务

删除了：

- `/opt/atrbot`
- `/opt/terraria`
- `/opt/mcp-servers`
- `/root/sillytavern-docker`
- `/opt/mihomo`

停止、禁用并移除了：

- `astrbot.service`
- `mcp-fetch.service`
- `mcp-sequential-thinking.service`
- `terraria-tmodloader.service`

删除了 MCP Nginx 配置，并从 `xxkcrimson.cn` 删除了 `st.xxkcrimson.cn` 的 SillyTavern server block；保留了 `bs`/`api` blocks 和 SSL 证书。

## 明确保留

- `natfrp-service`、Natfrp 镜像、`/etc/natfrp`
- SSH、Nginx、Ollama、Docker、containerd
- SSH/证书/凭据和系统核心目录
- `/var/lib/docker`（仅保留 Natfrp 容器所需数据）

## 验证

- 新 SSH 连接成功；主机仍为 `debian`，root 登录正常。
- 根分区从约 33G（8%）降至约 20G（5%），约释放 13G。
- Docker 只剩 Natfrp 容器和镜像；Docker named volumes 为空。
- `/etc/natfrp` 保留，Natfrp 容器仍运行，7102 端口仍监听。
- SSH 22、Nginx 80/443、Ollama 11434 仍监听。
- 删除目标容器端口 3001、6099、8000、9097、MCP 9100/9101/9200、AstrBot 6185/6197 已停止。
- `nginx -t` 成功，Nginx reload 成功。
- 删除关联 unit 后均为 `not-found/inactive`；SSH、Nginx、Ollama、Docker、containerd 仍为 enabled/active。
- `systemctl --failed` 为空。
- 目标容器、镜像、volumes、宿主机目录和 Nginx 配置均已确认不存在。

## 执行异常说明

初次删除脚本已完成所有删除、Nginx reload 和主要动作，但尾部校验段因远程 heredoc shell 解析异常返回非零；随后立即使用全新的 SSH 连接独立完成完整 postflight，全部验证通过。该解析异常没有留下目标资源或临时备份。
