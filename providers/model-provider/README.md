# koishi-plugin-yesimbot-model-provider

统一模型接入插件。每个 Koishi 克隆实例对应一个独立连接，通过 `type` 选择 OpenAI、Anthropic、Google 或 DeepSeek；内部保留各自原生 SDK、思考选项和媒体传输，不会把所有协议转成 OpenAI 请求。

## 通用配置

| 字段         | 含义                                                              |
| ------------ | ----------------------------------------------------------------- |
| `type`       | 协议：`openai`（默认）、`anthropic`、`google`、`deepseek`         |
| `id`         | 连接唯一标识，未设置时默认为所选协议名；模型引用使用 `id:modelId` |
| `apiKey`     | 必填密钥，在配置界面中隐藏                                        |
| `baseURL`    | 可选的 API 地址；不填写时沿用对应 SDK 默认地址                    |
| `chatModels` | 当前连接的模型列表，默认值随所选协议而定；可显式设置空列表        |

配置字段保持平铺，不需要 `connection`、`options` 或 `providers` 包装对象。多个同类型连接必须使用不同 `id`；Core 会拒绝重复注册。切换 `type` 不会自动覆盖已显式填写的 ID、模型列表或其它选项，切换后请检查这些值是否适用于新协议。

每个模型行支持 `id`、`toolCall`、`reasoning`、可选的 `thinkingLevel` 和 `thinkingLevelMap`。思考等级沿用 Core 的统一映射规则；未声明图片/视频输入模态时不会因协议名称而自动启用。`models.json` 的覆盖、别名与默认模型规则不变。

## 原生协议配置

| 协议      | 特有配置与保留行为                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI    | `format: chat`（默认）或 `responses`；`imageToolResultSupport` 可覆盖图片工具结果能力；`imageToolResultPlacement` 默认 `tool-output`，可选 `user-message`；支持 `embeddingModels`；仅 Responses 可通过 `webSearch: true` 启用原生搜索 |
| Anthropic | `webSearch` 默认关闭；原生图片工具结果与 `effort` 思考选项，`off` 禁用思考；不支持嵌入                                                                                                                                                |
| Google    | `embeddingModels` 默认为空；图片工具结果 MIME 默认只允许 PNG/JPEG，可配置 `imageToolResultMediaTypes`；自动将视频投影到当前用户输入顶层，不嵌入工具返回；视频功能仅由 Core `videoInput` 开关控制；保留 Gemini 原生历史投影            |
| DeepSeek  | `thinking` 默认 `high`，支持原有 `auto`、`none` 与强度选项；优先级为模型 ID 的 `:level` 后缀、模型行 `thinkingLevel`、连接级默认值；不支持嵌入                                                                                        |

OpenAI 的 Chat 格式默认不支持原生图片工具结果，Responses 默认支持；可使用原有覆盖字段适配经过验证的兼容网关。OpenAI、Anthropic、Google 未设置模型行思考等级时不额外发送思考参数，DeepSeek 继续使用它的连接级默认值。

默认聊天模型：

- OpenAI：`gpt-4o`、`gpt-5.4`、`gpt-5.5`、`gpt-5.6-luna`。
- Anthropic：`claude-opus-4-6`、`claude-sonnet-4-6`、`claude-haiku-4-5-20251001`。
- Google：`gemini-2.5-flash`、`gemini-2.5-pro`、`gemini-3.1-pro-preview`、`gemini-3.5-flash`。
- DeepSeek：`deepseek-v4-flash`、`deepseek-v4-pro`。

这些列表是原插件的配置默认值，不是对任意上游线路可用性的保证。OpenAI 的默认嵌入模型仍为 `text-embedding-3-small` 和 `text-embedding-3-large`。

## 多连接示例

```yaml
plugins:
  group:models:
    yesimbot-model-provider:openai-line:
      type: openai
      id: openai-line
      apiKey: YOUR_OPENAI_API_KEY
      format: responses
      chatModels:
        - id: gpt-4o
          toolCall: true
    yesimbot-model-provider:google-line:
      type: google
      id: google-line
      apiKey: YOUR_GOOGLE_API_KEY
      chatModels:
        - id: gemini-2.5-flash
          toolCall: true
          reasoning: true
```

这两个连接的模型引用分别为 `openai-line:gpt-4o` 和 `google-line:gemini-2.5-flash`。Koishi 克隆后缀只是实例配置入口，不替代连接 `id`。

## 从旧插件迁移

四个旧 Provider 包已由本插件替代，不提供旧包别名或兼容外壳。逐个复制连接配置，增加 `type` 并保留原来的有效 `id`；不要改现有模型引用。启用新实例前移除或禁用会占用同一 ID 的旧实例，并显式更新应用依赖。

完整的禁用项、克隆、操作员字段和 `will-policy` 迁移示例见 [接入文档](../../docs/setup-koishi.md#模型接入与-will-policy-迁移)。此源码改动不会自动迁移或部署运行中的应用。
