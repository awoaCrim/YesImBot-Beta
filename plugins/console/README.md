# koishi-plugin-yesimbot-console

YesImBot 自定义 Koishi 控制台首页。插件通过 `ctx.console.addEntry()` 注册客户端入口，并用服务端 `yesimbotPanel` DataService 提供健康、模型、配置、能力和插件状态。

## 小黑盒活动

管理员可访问 `/yesimbot/xiaoheihe`（小黑盒活动）。`yesimbotXiaoheihe` DataService、现有会话索引和 `yesimbot/conversation` 详情 RPC 均要求 `authority: 4`；会话页客户端入口也标记同等权限。权限校验沿用 Koishi Console 的认证机制。

- 页面只读展示连接、暂停/只读模式、当日 quota、最后浏览时间、真实配置的社区及候选话题，无发布、评论、恢复、重试或清空操作。只读模式取配置的 `readOnly`，或两项发布上限同时为 `0`；未知配置不推测为只读。
- 配置只投影 `selfId`、启用状态、`readOnly`、`dailyPostLimit`、`dailyInteractionLimit`、`communities`、`browseCommunities`、`candidateTopics`。在线 Bot 的配置优先，未运行的账号从 loader 的嵌套插件组读取。适配器尚未提供的字段明确显示“配置未提供”，不会把 AI、盒友杂谈或候选话题的建议值冒充实际配置。`communities` 为发帖社区，`browseCommunities` 为浏览社区。
- 状态从 `<baseDir>/data/yesimbot/xiaoheihe/<accountId>/state.json` 直接读取，不依赖小黑盒插件包，不打开 `AccountStore`、不创建目录、不获取或移除账号锁。账号 ID 必须匹配 `/^[A-Za-z0-9_-]{1,80}$/`；拒绝状态路径中的符号链接，校验文件身份，且最多读取 2 MiB。
- 状态只解析白名单字段；连接异常不回传原文，暂停原因和活动错误码只输出已知安全码，其他值显示 `unknown_error`。账号状态缺失、损坏、过大、不安全或不可读分别显示，部分账号失败不遮蔽其他账号。Console 断连、服务无数据和快照过期也单独提示，不显示为正常的零记录。
- `activities` 缺失按旧状态兼容为空并提示“旧版状态未记录活动流水”；无效活动只显示可读部分并警告。所有账号合计最多返回最近 300 条活动，可按账号、类型、结果和文本本地筛选。活动 `ok` 不是平台送达凭证。
- quota 按 `Asia/Shanghai` 自然日、从发布账本 `actions` 计算；`pending`、`sent`、`uncertain` 都占用当日额度，发布账本不转换成浏览记录。页面不消费或修改额度。
- 下方会话复用原有索引和详情路由。服务端在扫描会话时只保留 `manifest.platform === 'xiaoheihe'`、`selfId` 匹配已发现账号，且 `channelId` 为 `account:<accountId>` 或 `post:<accountId>:<合法 postId>` 的记录，不向本页发送 QQ 等平台的会话。平台标题和来源仅用 Vue 文本插值；帖子链接仅生成固定 HTTPS 小黑盒地址并编码合法 ID。

## 社区插件识别

面板不再依赖插件是否位于当前 monorepo。任何独立仓库的 Koishi 插件只要在 `package.json` 的 `koishi.yesimbot` 中声明，就会被面板识别：

```json
{ "name": "koishi-plugin-my-yesimbot-tool", "koishi": { "yesimbot": { "kind": "agent", "label": "我的工具", "configKey": "my-yesimbot-tool" } } }
```

字段说明：

- `kind`: `agent`、`provider`、`will`、`resource` 或 `console`。
- `label`: 面板显示名，不配置时回退到 `$label` 或包名。
- `configKey`: 可选；包名不符合 `koishi-plugin-*` 约定时用于匹配 Koishi 配置键。
- `providerId`: provider 插件可选；未设置实例 `id` 时用于判断注册状态。可多开的 `yesimbot-model-provider` 使用各实例的 `id`，未显式设置时沿用所选 `type` 的默认 ID，不使用固定的包级 ID。

模型接入卡片分别展示每个克隆实例的注册状态，配置链接指向对应实例。会话浏览只说明 Core 的默认触发规则，不再扫描已移除的 `will-policy` 配置；第三方 Will 插件及历史决策日志仍可使用。

当前仓库插件仍保留 `yesimbot-*` / `@yesimbot/*` 前缀兜底，社区插件建议显式声明。
