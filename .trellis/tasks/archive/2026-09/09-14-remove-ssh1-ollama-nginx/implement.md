# 执行计划：删除 ssh1 Ollama 和 Nginx

## 执行前

1. 用户批准本计划后运行 `task.py start`。
2. 通过 `ssh1` 重新保存基线：服务 enabled/active、包状态、Ollama/Nginx 路径大小、监听端口、Natfrp 容器/镜像/路径、SSH/Docker/containerd 和 failed units。
3. 运行 `apt-get -s purge nginx nginx-common`，断言计划移除的包只有 `nginx` 和 `nginx-common`；若有额外包，停止。
4. 验证所有待删路径的 realpath 是固定路径，并确认 `/etc/natfrp`、`/var/lib/docker` 不在目标集合。

## 执行顺序

1. `systemctl disable --now ollama.service nginx.service`。
2. 确认 SSH 仍保持连接，Natfrp 容器仍为 running。
3. 执行 `apt-get purge -y nginx nginx-common`，不执行 `apt autoremove`。
4. 删除 `/usr/local/bin/ollama`、`/usr/share/ollama`、`/root/.ollama`、`/etc/systemd/system/ollama.service`。
5. 删除残留 `/etc/nginx`、`/var/log/nginx`、`/var/lib/nginx`、`/usr/lib/nginx`、`/usr/sbin/nginx`（只对存在的精确路径操作）。
6. 执行 `systemctl daemon-reload`，断开并重新建立 SSH。

## 验证

- `systemctl is-enabled/is-active ollama nginx`：两者为 `not-found/inactive` 或未安装状态。
- `dpkg-query`：`nginx`、`nginx-common` 不再安装；没有非预期包被移除。
- `test -e`：所有 Ollama/Nginx 目标路径不存在；`/etc/natfrp` 和 `/var/lib/docker` 存在。
- `ss -ltnup`：11434、80、443 已停止；22、7102 保持监听。
- `docker inspect natfrp-service`：容器仍 running，镜像和 bind mount 未改变。
- `systemctl is-active ssh docker containerd`：仍为 active；`systemctl --failed` 无非预期项目。
- 新 SSH 连接成功，记录清理前后磁盘占用和释放空间。

## 回滚点

- APT simulation 不符合预期：不执行 purge。
- 停止服务后 SSH/Natfrp 异常：停止后续删除并报告。
- 删除后验证失败：不盲目重建证书或配置；包可重新安装，但证书/站点配置需要外部来源恢复。

## 完成条件

只有在新 SSH、Natfrp、SSH、Docker/containerd 和 failed units 验证通过，并且目标包、服务、文件和端口状态符合预期后才报告完成。不要提交 Git commit。
