# 移除 Pi Web UI 扩展

## Goal

从当前 Pi 用户环境中移除 `@kkkiio/pi-web-ui`，停止其自动启动的本地 Web UI 与 `/webui` 相关能力；保留其他已启用扩展以及独立的 `G:/Users/admin/desktop/code/pi-web` 项目不变。

## Confirmed scope

- 目标包是全局设置中的 `npm:@kkkiio/pi-web-ui`。
- 当前包安装目录为 `C:/Users/Administrator/.pi/agent/npm/node_modules/@kkkiio/pi-web-ui`。
- 注入的 `pi-web-ui: 127.0.0.1:3001 • 1 web client` 状态由该包的 `extensions/mirror-server.ts` 写入；不需要修改或汉化代码。
- `npm:pi-web-access` 是普通 web search/fetch 扩展，不是该 Web UI 服务，不在删除范围内。
- 不删除 `G:/Users/admin/desktop/code/pi-web` 独立仓库，也不改动其中已有用户变更。

## Requirements

1. 从 `C:/Users/Administrator/.pi/agent/settings.json` 的 `packages` 中移除 `npm:@kkkiio/pi-web-ui`。
2. 通过 Pi 支持的包移除流程清理该包的安装目录；不得直接删除其他 npm/git 包或扩展目录。
3. 不停止、重启或杀掉当前可能仍在运行的 Pi 进程。已加载到当前进程的扩展可能要等下一次 Pi 会话重启后才完全消失。
4. 保留其余 `packages`、全局自动发现扩展和项目配置原样。
5. 不创建汉化层或扩展适配层；用户已将需求从“汉化并适配”收窄为“直接删除”。

## Acceptance Criteria

- [x] 全局 `settings.json` 不再包含 `npm:@kkkiio/pi-web-ui`。
- [x] `pi list` 不再把 `@kkkiio/pi-web-ui` 列为已配置包。
- [x] 该包安装目录已清理，路径 `C:/Users/Administrator/.pi/agent/npm/node_modules/@kkkiio/pi-web-ui` 已不存在。
- [x] 其余 16 个已配置包仍保留，未停止或重启现有 Pi 进程。
- [x] 根据配置和包解析结果，后续新启动的 Pi 不再自动加载该包的 `mirror-server.ts`、注册 `/webui`，也不再产生该 `webui` 状态。

## Notes

- 删除配置会立即影响后续 Pi 启动；不会强行清理当前已加载的扩展实例。
- 如果 Windows 文件占用导致安装目录暂时无法删除，应保留配置删除结果，报告占用路径，并等待用户明确允许后再处理进程或残留文件。
