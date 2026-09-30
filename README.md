# YesImBot-Beta

YesImBot-Beta 是基于 Koishi 的群聊 AI Agent 框架，支持多模型接入、上下文管理、群聊参与决策、多模态资源处理和插件扩展。

[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
![Language](https://img.shields.io/badge/language-TypeScript-brightgreen?style=flat-square)
![Status](https://img.shields.io/badge/status-beta-yellow.svg?style=flat-square)

## 简介

项目由以下部分组成：

- `core/`：Koishi 插件和运行时编排，负责消息接入、频道、会话、资源、模型和 Agent。
- `packages/agent-runtime/`：通用 Agent Runtime，负责回合、状态、存储、工具和插件生命周期。
- `plugins/`：搜索、记忆、工作区、MCP、贴纸、角色等可选功能。
- `providers/`：OpenAI、Anthropic、DeepSeek、Google 等模型接入。

当前 Core 内置 OneBot Translator。其它平台可以通过 Translator 插件接入。

## 亮点能力

### 群聊交互决策

每条消息先经过频道规则和参与策略，再交给 Agent 处理。Agent 可以根据频道、私聊、引用、事件和当前上下文选择等待、加入对话或结束当前回合。

- 支持消息防抖，连续消息可以合并后再判断。
- `allowedChannels` 默认拒绝外部频道，可按平台、频道和私聊/群聊类型配置。
- 模型的普通文本是内部生成内容，不会直接发送到平台；`send_message` 负责发送，`finish` 负责静默结束。
- 每个频道和私聊独立保存上下文，不会把不同会话的消息混在一起。

### 上下文与会话管理

- 会话以 JSONL 文件持久化，重启后可以继续使用已有上下文。
- 长会话支持摘要和归档，原始记录仍然保留。
- Core 提供会话读取接口；`memorizer`、`global-brain` 等插件可以进一步提供长期记忆和跨频道知识。
- 图片、文件、引用和平台事件会经过统一记录，再交给模型或插件使用。

### 工具与多模态支持

- 支持图片和文件读取、引用消息、图片生成与编辑。
- `koishi-plugin-yesimbot-sticker-manager` 用于检索和发送表情、贴纸。
- `koishi-plugin-yesimbot-workspace` 提供频道隔离的沙箱工作区，以及 `bash`、`readFile`、`writeFile` 工具。
- `koishi-plugin-yesimbot-mcp-client` 可以连接 MCP Server；创建、删除、支付等有副作用的操作需要确认。
- 搜索、OneBot 工具和其它插件可以把外部服务接入 Agent。

### 模型接入与思考等级

当前仓库提供以下 Provider：

| 模型生态 | Provider 包 |
| --- | --- |
| OpenAI | `@yesimbot/koishi-plugin-provider-openai` |
| Claude / Anthropic | `@yesimbot/koishi-plugin-provider-anthropic` |
| DeepSeek | `@yesimbot/koishi-plugin-provider-deepseek` |
| Gemini / Google | `@yesimbot/koishi-plugin-provider-google` |

模型使用 `provider:model` 标识。Provider 可以注册聊天模型、embedding 模型、工具和模型能力。主聊天、辅助任务和识图可以使用不同模型。

支持的思考等级为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。可以在 `models.json` 中覆盖具体模型的设置：

```json
{
  "chat": {
    "openai:your-model-id": {
      "thinkingLevel": "high"
    }
  }
}
```

图片输入也按模型能力和 `imageInput` 配置控制。模型只有通过 `read` 工具读取图片时，图片才会进入当前请求。

## 插件生态

| 插件 | 包名 | 主要功能 |
| --- | --- | --- |
| Console | `koishi-plugin-yesimbot-console` | 在 Koishi 控制台查看模型、配置、健康状态和插件状态。 |
| Workspace | `koishi-plugin-yesimbot-workspace` | 提供沙箱工作区和文件、命令工具。 |
| MCP Client | `koishi-plugin-yesimbot-mcp-client` | 接入 MCP Server，并为有副作用的工具提供确认。 |
| Search | `koishi-plugin-yesimbot-search-service` | 提供网络搜索和资料检索。 |
| Image Tools | `koishi-plugin-yesimbot-image-tools` | 提供图片生成、编辑和结果处理。 |
| Sticker Manager | `koishi-plugin-yesimbot-sticker-manager` | 管理、检索和发送表情与贴纸。 |
| Global Brain | `koishi-plugin-yesimbot-global-brain` | 在不同频道之间共享知识、问题、回复和经验。 |
| Memorizer | `koishi-plugin-yesimbot-memorizer` | 提供长期记忆、检索和记忆维护。 |
| Roleplay / Will | `koishi-plugin-yesimbot-roleplay`、`koishi-plugin-yesimbot-will-policy` | 提供角色卡、表达风格和参与策略。 |
| Message Polisher | `koishi-plugin-yesimbot-message-polisher` | 在发送前使用独立模型润色消息。 |

仓库中还包含消息防抖、定时任务、配额与用量、OneBot 工具和命令桥接等插件。插件可以通过 Core 的注册接口增加 Agent、Will、Translator 或资源读取能力：

```ts
ctx.yesimbot.agent.use(channelPlugin)
ctx.yesimbot.agent.will(willPlugin)
ctx.yesimbot.messenger.use(translator)
ctx.yesimbot.resource.use(resourceReader)
```

## 快速上手

这是一个 Yarn 4 monorepo，先从源码安装并构建：

```bash
git clone https://github.com/awoaCrim/YesImBot-Beta.git
cd YesImBot-Beta
yarn install
yarn build
```

在 Koishi 应用中加载 `koishi-plugin-yesimbot`、一个模型 Provider 和需要的插件，然后配置主模型与允许响应的频道：

```yaml
yesimbot:
  chatModel: "openai:your-model-id"
  allowedChannels:
    - platform: onebot
      channelId: "your-channel-id"
```

`allowedChannels` 默认拒绝所有外部频道。平台连接由 Koishi Adapter 提供，当前 Core 内置 OneBot Translator。

常用开发检查：

```bash
yarn check-types
yarn test
yarn build
```

## 架构简述

消息处理流程如下：

```text
平台消息
   ↓
Messenger：检查频道规则，解析消息、文件和引用
   ↓
Channel Runtime：读取会话，执行参与策略和 Agent 回合
   ↓
模型与插件：调用模型、工具和外部服务
   ↓
send_message / finish：发送回复或结束回合
```

每个频道有独立的运行状态和会话文件，消息按顺序处理。插件在运行时创建时加载，注册或卸载插件后，新建的运行时使用新的插件组合。

更多 Core API 说明见 [`core/README.md`](core/README.md)。

## 项目链接

- [YesImBot-Beta 仓库](https://github.com/awoaCrim/YesImBot-Beta)
- [Issues](https://github.com/awoaCrim/YesImBot-Beta/issues)
- [License](LICENSE)
