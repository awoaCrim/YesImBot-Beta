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

- **会看气氛的群聊机器人** — 不只会回复 @：能根据关键词、引用、图片和当前场景决定是加入、等待还是沉默。
- **多模型即插即用** — 接入 OpenAI、Anthropic、DeepSeek、Google 等模型，在配置里选一个聊天模型就能开始使用。
- **可选长期记忆** — 安装 MemOS 或全局脑插件后，机器人可以记住跨会话的偏好、事实和经历。
- **能做事而不只是聊天** — 通过工作区、搜索、MCP、OneBot 工具等插件，机器人可以处理文件、联网查资料、调用外部服务和群管理工具。
- **按需扩展** — 插件系统支持工具、提示词和生命周期扩展；日常使用只需要在 Koishi 控制台启用。
- **Koishi 原生集成** — 复用 Koishi 的适配器、中间件、控制台和数据库生态。

## 安装 YesImBot Launcher

当前 v4 的官方安装入口是 YesImBot Launcher。

```bash
# Linux / WSL / macOS
curl -fsSL https://raw.githubusercontent.com/YesWeAreBot/launcher/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/YesWeAreBot/launcher/main/install.ps1 | iex
```

- Linux/WSL/macOS 默认安装到 `~/.local/bin`。
- Windows 默认安装到 `%LOCALAPPDATA%\YesImBot\bin`。

安装完成后运行 `yesimbot-cli --help` 验证。Launcher 仓库：[YesWeAreBot/launcher](https://github.com/YesWeAreBot/launcher)。

每条消息先经过频道规则和参与策略，再交给 Agent 处理。Agent 可以根据频道、私聊、引用、事件和当前上下文选择等待、加入对话或结束当前回合。

> [!WARNING]
> 当前 v4 尚未发布到 npm，也没有上架 Koishi 插件市场；请使用 Launcher 接入源码。

Launcher 安装完成后，运行：

```bash
yesimbot-cli init
```

`init` 会创建 Koishi App，并从 GitHub `dev` 分支接入 YesImBot v4 源码；结束后按提示选择是否立即启动。之后在 Koishi 控制台启用 `yesimbot`、模型服务插件，并配置聊天模型与允许响应的频道。

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

活动 Runtime 会在创建时快照模型能力、`imageInput`、Will、提示词与插件。Core 不提供 `reload()`：配置、模型或插件变化会在 Runtime 因停止或 shared Bot 变更而替换后生效。

#### 模型思考等级

四个内置 Provider（Google、OpenAI、Anthropic、DeepSeek）支持在各自的 `chatModels` 模型行上配置统一的思考等级。等级固定为：

`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`

`thinkingLevel` 不填写时不新增任何 thinking 参数，继续使用 Provider 默认行为；配置跟随具体模型，因此主聊天、消息润色、记忆和其它 auxiliary 请求解析到同一模型时会使用同一设置，不需要在某个用途的调用点单独传参。

```yaml
chatModels:
  - id: gemini-3.7-flash
    toolCall: true
    reasoning: true
    thinkingLevel: high
    # 原生值由 Provider 解释；null 表示该统一等级不受此模型支持
    thinkingLevelMap:
      xhigh: high
      max: null
```

`thinkingLevelMap` 是可选的逐模型原生映射。Google 使用 `thinkingConfig.thinkingLevel`，OpenAI 使用 `reasoningEffort`，Anthropic 使用 `effort`，DeepSeek 使用 `thinking` 与 `reasoningEffort`。不同模型或 Provider 不支持某个等级时可写 `null`；显式请求不可用等级会按固定顺序优先夹到更高的可用等级，再向更低等级寻找，并记录 warning，不会发送无效原生值。`reasoning: false` 的模型只保留 `off`。

也可以在 `data/yesimbot/models.json` 的 `chat` 覆盖中调整已注册模型：

```json
{
  "chat": {
    "openai:gpt-5": {
      "thinkingLevel": "high",
      "thinkingLevelMap": { "xhigh": "xhigh", "max": null }
    }
  }
}
```

DeepSeek 原有的全局 `thinking` 默认值和模型 ID `:level` 后缀仍然有效；后缀优先级高于模型行的 `thinkingLevel`。本配置只改变模型请求设置，不会自动修改生产配置或部署。

## Plugins

YesImBot 的能力通过插件系统按需加载。

> 当前 v4 插件随 Launcher 源码接入一起提供，不在 npm 或插件市场中逐包安装。

| 插件        | 包名                                    | 能力                                |
| ----------- | --------------------------------------- | ----------------------------------- |
| 控制台      | `koishi-plugin-yesimbot-console`        | 自定义 Koishi 首页与 WebUI          |
| 工作区      | `koishi-plugin-yesimbot-workspace`      | 文件操作、命令执行与 Skill 目录访问 |
| MCP 客户端  | `koishi-plugin-yesimbot-mcp-client`     | 通过 MCP 协议接入外部工具服务       |
| 搜索        | `koishi-plugin-yesimbot-search-service` | 网络搜索与信息检索                  |
| OneBot 工具 | `koishi-plugin-yesimbot-onebot-utils`   | OneBot 平台工具集成                 |
| 贴纸        | `koishi-plugin-yesimbot-sticker`        | 表情与贴纸处理                      |

OneBot Translator 内置于 `koishi-plugin-yesimbot`，通过同一 PlatformTranslator 边界注册，不是可选的平台包。

### LLM Provider

| Provider  | 包名                                         |
| --------- | -------------------------------------------- |
| OpenAI    | `@yesimbot/koishi-plugin-provider-openai`    |
| Anthropic | `@yesimbot/koishi-plugin-provider-anthropic` |
| DeepSeek  | `@yesimbot/koishi-plugin-provider-deepseek`  |
| Google    | `@yesimbot/koishi-plugin-provider-google`    |

Provider 不绑定具体厂商：OpenAI Provider 可通过 `baseURL` 接入任意 OpenAI-compatible API；各 Provider 支持克隆多开，只需保证实例 `id` 唯一。

## Architecture

Athena 是一个 message-first Koishi agent runtime。入站路径如下：

```text
Session -> allowlist -> shared assignee admission -> AssetStore -> PlatformTranslator
        -> final Message/Event Record -> RuntimeManager -> ChannelRuntime FIFO
        -> wait | join | one output consumer -> passive Gateway delivery
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

开发、迁移和部署约束见 [docs/DEVELOPMENT-GUIDELINES.md](docs/DEVELOPMENT-GUIDELINES.md)。

## Community

更多 Core API 说明见 [`core/README.md`](core/README.md)。

## 项目链接

## Sponsors

感谢以下赞助者对 YesImBot 的支持：

- Preca（QQ 2379626851）
- [Miaow](https://github.com/MiaowFISH)（QQ 1293865264）

---

## Contributors

感谢所有为 YesImBot 付出努力的人：

[![Contributors](https://contrib.rocks/image?repo=YesWeAreBot/YesImBot)](https://github.com/YesWeAreBot/YesImBot/graphs/contributors)

## Star History

<div align="center">

<a href="https://www.star-history.com/?repos=YesWeAreBot%2FYesImBot&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=YesWeAreBot/YesImBot&type=date&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=YesWeAreBot/YesImBot&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=YesWeAreBot/YesImBot&type=date&legend=top-left" />
 </picture>
</a>

![Activity](https://repobeats.axiom.co/api/embed/6e29e048274c301e59d2c774189029f6f0085a37.svg "Repobeats analytics image")

</div>
