# yesimbot-message-polisher

可选的 `send_message` 发送前表达插件，需与 `koishi-plugin-yesimbot` 一同加载。复用当前完整 `PERSONA.md` 和 Roleplay 角色卡，不需要第二套人设。自定义 Persona 优先；只有角色卡时不混入默认 Athena。

## 两种模式

- **`rewrite`（默认，兼容已有配置）**：主 Agent 提供 `facts + messages` 草稿，独立模型改写表达。保持条数、顺序及每条数字、@、资源 URI、元素标签；模型失败或校验不通过时沿原发送路径发送一次原稿。
- **`compose`**：主 Agent 只做逻辑判断、事实核对和工具执行，提交拟对外表达的 `facts`、交流动作 `intent`，以及可选的逐字内容 `verbatim`；**不提交 messages 草稿**。表达模型携带完整人设自主组织自然回复和分条，可返回 1–12 条非空消息，总 JSON 正文不超过 32 KiB。失败时不发送 facts/intent，不自动回退主模型写台词。

```yaml
model: "providerId:modelId" # 独立的表达聊天模型
mode: compose # 默认 rewrite
temperature: 0.5
timeoutMs: 8000
```

`temperature` 范围 0–2，`timeoutMs` 范围 1000–60000 毫秒。`model` 留空不注册能力；插件不会使用或回退到 Core 的 `auxiliaryModel` 或主聊天模型。注册状态决定主 Agent 的委派模式，模型暂不可用不会把人设重新交回主 Agent。注册/卸载会使旧 runtime 失效，下次获取时重建；卸载恢复普通主 Agent。

## 边界

两个模式都不向主 Agent 注入 Persona/角色卡。表达请求只额外携带 **当前回合** 的有界只读参考：用户文本、媒体占位符和经过过滤的非发送工具结果。不提供内部思考、assistant 工具参数、发送结果、图片输出或完整历史。

Core 保留频道、`raw/element`、`continue`、资源解析、节奏和部分发送的所有权。Compose 验证 facts/verbatim 中数字、@、URI、标签的原文及出现次数（允许重排），并要求 verbatim 整块逐字保留；不要求复制参考上下文中的无关数字。facts 应只包含本次拟对外表达的信息，verbatim 不能用来夹带风格草稿。

润色后的 receipt 记录真正完整送达的正文，历史不再从草稿重建。一个项目中途失败或缺少有效平台 ID，不会把该项目整段正文标成已送达；已完成前缀保留，不重新生成或整批重发。取消、超时、卸载或 profile 注册变化会丢弃过期 compose 结果。

## 可选历史客观化

这与本插件独立。在 Core 中开启 `session.compact.assistantAsFacts: true` 并配置 `auxiliaryModel`，所有保留的历史自身回复（包括近期窗口）都会通过辅助模型提取为客观记录并缓存；压缩及显式历史展开也使用同一策略。失败仅显示不可用元信息，不回退原话；原始 JSONL 不改写，当前用户与本轮工具续接不受影响。默认关闭，既有摘要不会自动重新生成。

两项功能会增加延迟和模型成本。类型、JSON、token 和 mock 回归只能验证机制，不能证明自然语言语义无损或真实模型的角色表现；上线效果需要另行授权验证。
