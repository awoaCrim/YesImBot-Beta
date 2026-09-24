# yesimbot-message-polisher

可选的 `send_message` 发送前润色插件。需与 `koishi-plugin-yesimbot` 一同加载；如同时加载 `yesimbot-roleplay`，会复用它当前加载的角色卡指令和定义。没有角色卡时只使用 Core 当前的 `PERSONA.md`（或 Core 默认 persona）。无需配置第二套角色提示。

启用后，Core 的主 Agent 改为中性事实与草稿模式：`send_message` 要求 `facts` 和 `messages`，Core persona 和角色卡指令不再交给主 Agent。插件通过 `ctx.yesimbot.polisher.use(capability)` 注册，roleplay 通过 `ctx.yesimbot.polisher.profile(provider)` 提供角色材料；两个注册都返回 disposer。注册状态决定委派模式，不取决于辅助模型是否可用；注册或卸载会让旧频道 runtime 在下一次获取时更新。

润色时使用 Core 已配置的 `utility` 辅助模型，不回退到主聊天模型。只传显式 `facts`、原始 `messages` 与当前 persona/角色卡，不传 `inner_thought` 或整段历史。模型仅返回改写文本，Core 在 **实际 `createSendMessageTool` 发送边界** 逐条验证非空、条数及数字、@ 提及、资源 URI、元素标签的原文、重复次数与出现顺序；发送频道、`mode`、`continue` 等控制字段不允许修改。缺少 utility、模型报错或输出校验失败时不重试润色，直接沿原路径发送一次原稿。卸载后恢复普通主 Agent prompt 和工具 schema。

配置：`temperature`（默认 0.5，范围 0–2）、`timeoutMs`（默认 8000 毫秒，范围 1000–60000）。润色会增加模型请求的延迟和成本。确定性校验不能证明自然语言语义等价；角色改写仍有改变语义的模型残余风险，不应将结果视为形式化保证。
