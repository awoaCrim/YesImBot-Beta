# YesImBot 开发与运维规范

这份文档记录仓库的实际边界、开发顺序和上线规则。它不是 API 参考，也不替代各包自己的测试。

---

### 项目结构

- [`core/`](../core/) 是 `koishi-plugin-yesimbot`，负责 Koishi 接入、模型注册、Messenger、Channel、Conversation、Agent 和 Runtime。
- [`packages/agent-runtime/`](../packages/agent-runtime/) 是通用 Agent runtime，负责 turn queue、消息存储、工具执行、插件钩子和运行时事件。
- [`plugins/`](../plugins/) 是可选 Koishi 插件。插件通过 `ctx.yesimbot.agent.use()`、`agent.will()` 或资源扩展点接入。
- [`providers/`](../providers/) 是模型 Provider。Provider 通过 AI SDK 创建模型并注册到 Core 的模型服务。
- [`openspec/`](../openspec/) 保存功能契约和变更说明。实现前先确认对应契约是否已有约束。
- [`.trellis/`](../.trellis/) 保存任务、项目规范、工作流和研究记录。

---

### Source of truth

- TypeScript 源码和测试是行为的主要来源。`dist/`、`.turbo/`、Vite 缓存和 `node_modules/` 都是生成物或依赖，不要直接修改来修复问题。
- 根目录使用 Yarn 4 和 Turborepo。使用 `yarn`，不要使用 `pnpm` 或 `npm` 改写依赖。
- 修改前先阅读根目录的 [`AGENTS.md`](../AGENTS.md)、相关包的源码、测试和 `.trellis/spec/` 指南。
- 不要把生产配置、凭据、durable JSONL、Persona/card 或平台运行数据复制进源码提交。
- 当前本地目录是迁移后的完整源码 checkout。远端运行数据与服务配置属于独立的运行时边界，不是源码的一部分。

---

### 代码边界

- `core/src/messengers/` 持有 live Koishi `Session`、入站准入和 Translator 调用。Runtime 和插件不要保存 `Session` 引用。
- `core/src/runtimes/` 持有 FIFO、Agent、历史投影、Will 和 delivery tracking。不要在这里重复实现 Messenger 或 Will 状态机。
- 对外模型输出必须通过 `send_message`。普通 assistant text、tool receipt 和 `turn.done` 都不是平台送达证据。
- `send_message` 的真实 delivery 以当前频道、非空 message ID 的 callback 为准。
- `finish` 表示本轮静默结束。中间工具执行完成后继续 loop，不能把中间工具当作 terminal。
- Provider 能力必须通过模型配置显式声明。不要仅凭 provider 名称猜测 tool calling、图片或其他能力。
- 新增公共行为时，同时补充类型、schema、Prompt、历史投影和回归测试，避免只改其中一层。

---

### 开发顺序

1. 在 [` .trellis/tasks/`](../.trellis/tasks/) 创建或继续任务，先读 `prd.md`、`design.md` 和 `implement.md`。
2. 搜索已有实现和测试，确认代码所有权，再决定修改点。不要因为目录名称相似就新建重复抽象。
3. 先写能证明旧行为失败的 focused test，再修改生产源码。
4. 实现最小改动，保留兼容路径和已有 delivery、Will、历史边界。
5. 运行受影响包的测试、类型检查、格式化、lint 和 build。
6. 对照 acceptance criteria、`.trellis/spec/` 和 [`AGENTS.md`](../AGENTS.md) 做最终检查。

常用命令：

```bash
yarn install
```

```bash
yarn check-types
```

```bash
yarn test
```

```bash
yarn build
```

包级验证应使用明确的包和测试路径，避免只依赖全仓库结果。当前项目的推荐示例见 [`AGENTS.md`](../AGENTS.md#build-and-verification)。

---

### 测试与失败分类

- 新增行为必须有回归测试。测试要分别断言 tool call、Bot 调用、真实 delivery callback 和最终事件。
- 不要把静态 SDK probe 当成真实模型能力，也不要把 tool receipt 当成 QQ 已收到消息。
- 测试失败要区分本次改动、共享工作区已有 WIP 和环境依赖问题。不要为了让全量测试变绿而修改无关契约。
- 运行时协议、历史投影、平台传输和 Will settlement 是不同边界。修复一个边界时不要顺手合并另一个状态机。

---

### 生产部署

- 默认不部署、不重启、不发送 QQ/Sandbox canary。生产激活必须得到单独确认。
- 部署前保存 owner-only 的 scoped backup 和 hash，只替换本任务拥有的构建产物。
- 只重启 `yesimbot-koishi`。不要为了 YesImBot 代码变更重启 NapCat。
- 重启后检查容器 running、exit code、OOM、restart count、启动日志、模块解析和 HTTP 健康检查。
- 发生启动错误、plain text 外发、delivery tracker 回归或 marker 泄漏时，立即使用 scoped rollback，保留运行期间产生的数据，不清理历史。
- 不用 RPC ack、tool receipt 或 `turn.done` 代替客户端实际收到消息的证据。
- 具体的协议边界见 [Agent Message Protocol and Delivery State Contract](../.trellis/spec/yesimbot/backend/agent-message-protocol-contract.md)。

---

### Trellis 使用规范

- `.trellis/workflow.md` 是工作流来源，`.trellis/config.yaml` 是项目配置来源。
- 任务目录保存 PRD、设计、执行计划、研究和验证结果。不要把大体积构建产物、依赖目录或原始聊天日志放进任务研究目录。
- `.trellis/spec/` 记录已经从源码和测试确认的可执行约束。发现新的稳定边界后更新对应 spec，不要只写在一次性对话里。
- `.trellis/.runtime/` 和 `.trellis/.template-hashes.json` 由 Trellis 管理。没有明确理由不要手改。
- 使用 `task.py validate` 检查 `implement.jsonl` 和 `check.jsonl`。任务完成前保留可复现的验证证据。
- 修改项目规范时保持与平台目录中的 Agent、skill 和 hook 一致，不要只改一处导致上下文冲突。

---

### Git 与变更纪律

- 保留其他开发者或其他任务的 dirty changes。不要使用破坏性命令覆盖它们。
- 提交信息格式为 `<type>(scope): <summary>`，summary 用中文、动词开头、长度不超过 50 字，不加句号。
- 一个提交只解决一个清晰问题。不要把部署、依赖升级、重构和功能修复混在同一提交。
- 未经明确要求不要创建、修改或删除生产数据，也不要提交凭据。

---

### 文档入口

| 文档 | 内容 |
|---|---|
| [`AGENTS.md`](../AGENTS.md) | 代码组织、架构边界和仓库级开发要求 |
| [`docs/DEVELOPMENT-GUIDELINES.md`](DEVELOPMENT-GUIDELINES.md) | 面向维护者的开发与运维规则 |
| [`docs/setup-koishi.md`](setup-koishi.md) | 接入 Koishi 的脚本和流程 |
| [`docs/MIGRATION-20260914.md`](MIGRATION-20260914.md) | 本次源码、Trellis 资产和远端清理记录 |
| [`docs/athena-v4-vision-and-evolution-notes.md`](athena-v4-vision-and-evolution-notes.md) | 产品方向和长期架构背景 |
| [`.trellis/spec/yesimbot/backend/index.md`](../.trellis/spec/yesimbot/backend/index.md) | YesImBot backend 的可执行契约索引 |
| [`.trellis/tasks/`](../.trellis/tasks/) | 任务计划、研究和验证记录 |
