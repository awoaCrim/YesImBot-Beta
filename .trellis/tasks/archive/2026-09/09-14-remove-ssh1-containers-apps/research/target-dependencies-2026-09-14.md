# ssh1 删除目标依赖盘点

## 用户最终范围

- 保留：`natfrp-service`、Natfrp 镜像、`/etc/natfrp`。
- 删除其它当前容器、其直接数据和用户指定的应用目录/服务。
- 删除两个未被容器链接的 Docker volumes。

## 删除目标

### Docker

- 容器：`napcat`、`sillytavern`、`mihomo`、`metacubexd`
- NapCat volumes：`3329d80d19919fea5f925f06b248dabc1542550728233c41208e8836fc2f8920`、`fb7438f5007b4c96fd30eb826d6d86ea87095953c8d917f37ca7fc258dc402a9`
- 未链接 volumes：`c21f6494811e298c37280a2e6b33cd6fa575ecfa8b51879a213b69956e665a70`、`1c06b90226ee62ea0693bba98dae07ef59ca2185357f19947fe9fc9b130c76bd`
- Natfrp 不在删除集合。

### 宿主机目录

- `/opt/atrbot`
- `/opt/terraria`
- `/opt/mcp-servers`
- `/root/sillytavern-docker`
- `/opt/mihomo`

保留 `/etc/natfrp`、SSH/证书/凭据和系统核心目录。

### 服务和 Nginx

- 需停止/禁用/移除：`astrbot.service`、`mcp-fetch.service`、`mcp-sequential-thinking.service`、`terraria-tmodloader.service`
- 删除 MCP 配置：`/etc/nginx/sites-available/mcp`、`/etc/nginx/sites-available/mcp.xxkcrimson.cn` 及其启用链接（若存在）。
- `/etc/nginx/sites-available/xxkcrimson.cn` 只删除 `st.xxkcrimson.cn` server block；保留 `bs.xxkcrimson.cn`、`api.xxkcrimson.cn` 和 SSL 证书。

## 关键风险

- 删除 `/opt/atrbot` 会同时删除 AstrBot 和 NapCat 数据，因此必须先停用 AstrBot unit。
- 删除 `/opt/terraria` 需要先禁用已 enabled 但当前 inactive 的 Terraria unit，否则会留下失效开机项。
- 删除 `/opt/mcp-servers` 需要同步移除 MCP systemd 和 Nginx 配置，否则会留下失败服务/502 路由。
- 删除 `/root/sillytavern-docker` 会永久删除容器的配置、数据、插件、扩展和备份。
- Natfrp bind mount `/etc/natfrp` 与 7102 端口必须在前后验证中保持正常。
