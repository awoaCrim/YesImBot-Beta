# 修复 WebUI 显示图片工具插件未安装

## Goal

让已经迁移到 `yesimbot-image-tools:image-tools` 的图片工具插件真正安装到运行中的 Koishi 应用，并让 WebUI 的插件配置页能够解析、显示和配置它；不改变图片 API 配置、聊天/Embedding 模型、角色卡、历史记录或 QQ 传输行为。

## Confirmed facts

- 生产配置已经包含启用的 `yesimbot-image-tools:image-tools`。
- 运行容器在启动日志中反复记录 `cannot resolve plugin "yesimbot-image-tools"`，因此当前只是配置项存在，插件实现没有被 Koishi 实际加载。
- Koishi 运行应用根目录是 `/var/lib/docker/volumes/yesimbot_koishi-app/_data`，其 `package.json` 和 `node_modules` 与源码 workspace `/var/lib/docker/volumes/yesimbot_koishi-app/_data/yesimbot-v4` 分开维护。
- 源码 workspace 已有 `node_modules/koishi-plugin-yesimbot-image-tools -> plugins/image-tools`，但运行应用根目录缺少对应依赖和 node_modules 链接；从运行根目录执行 `require.resolve("koishi-plugin-yesimbot-image-tools")` 会失败。
- 官方仓库内的 `scripts/setup-koishi.mjs --check` 能复现同一个失败：验证到新插件时报告 `cannot resolve koishi-plugin-yesimbot-image-tools; is the package built?`。
- YesImBot 自定义面板对 `yesimbot-*` 配置有 legacy fallback，所以会把配置存在误显示为“已启用”；这不能证明 Koishi runtime 或标准插件配置页已安装。真正的 `@koishijs/plugin-config` scanner 使用 Koishi app 根目录的 `node_modules`。

## Requirements

### R1 — Runtime installation

- 将 `koishi-plugin-yesimbot-image-tools` 纳入运行 Koishi app 的 workspace/依赖清单，并生成对应的 root `node_modules` 解析链接。
- 优先使用仓库现有的 `scripts/setup-koishi.mjs --no-pull` 安装/同步流程，不手工复制不受 lockfile 管理的依赖。
- `yesimbot-image-tools` 从运行根目录和 Koishi loader 中均可解析。

### R2 — WebUI visibility

- 标准 WebUI plugin/config scanner 能读取新插件的 `package.json`、schema 和 runtime exports，不再把它判定为未安装。
- YesImBot 自定义面板继续显示该配置项为已启用，并且不产生“配置存在但插件未解析”的假阳性。
- 不为了掩盖解析错误修改 WebUI 的 status fallback；先修复实际依赖安装。

### R3 — Compatibility and safety

- 保留当前 `yesimbot-image-tools:image-tools` 的 API key、baseURL、model、editModel、timeout 和 enabled 值；凭据只在服务器端比较，不能进入任务文档、命令输出或日志。
- 不修改聊天、视觉、Embedding、Persona、Will、历史、Memory、Notify、Transport、NapCat 或真实 QQ 配置。
- 只重启 `yesimbot-koishi`；保留现有会话和 Sandbox 测试证据。
- 为 root `package.json`、root `yarn.lock`、Koishi config、容器状态和 node_modules link 创建可回滚的 owner-only 备份，并在部署前设置 hash guard。

## Acceptance Criteria

- [ ] 从运行 app 根目录执行 `require.resolve("koishi-plugin-yesimbot-image-tools")` 成功，并指向 `yesimbot-v4/plugins/image-tools/dist`。
- [ ] `node scripts/setup-koishi.mjs --app /var/lib/docker/volumes/yesimbot_koishi-app/_data --no-pull --check` 成功完成，不再报告新插件无法解析。
- [ ] root `package.json`、root `yarn.lock` 和 root `node_modules` 显示新 workspace 依赖；源码 workspace lockfile 仍保持一致。
- [ ] 重启后的日志包含 `yesimbot-image-tools:image-tools` 正常加载，且不包含 `cannot resolve plugin "yesimbot-image-tools"`。
- [ ] WebUI 标准插件配置页不再显示该插件“未安装”；YesImBot 面板显示 enabled，且 plugin schema/runtime 可读。
- [ ] 生产配置的图片字段和核心/模型配置语义保持不变，不输出任何凭据。
- [ ] `yesimbot-koishi` 健康运行，console 资源返回 HTTP 200；NapCat 不重启。
- [ ] 现有图片工具 focused tests/build 或最小 runtime registration probe 通过；不发送真实 QQ 消息。

## Out of scope

- 不改变图片工具行为、API endpoint、模型、预算、artifact、投影、取消或错误分类。
- 不修改 WebUI 通用安装器、Koishi registry 或市场服务的产品逻辑，除非证据证明依赖已正确安装但 scanner 仍错误。
- 不发布 npm 包、不执行 Git commit、不清除历史或长期记忆。

## Open questions

无阻塞性的产品决策。技术实现优先采用已有 `setup-koishi.mjs` 的 manifest/install/verify 流程；若该流程因当前 dirty workspace 或权限问题不能安全执行，再回到同范围的手工 root manifest/link 方案并记录原因。
