# 2026-09-14 代码迁移记录

---

### 迁移结果

YesImBot 的完整源码已从远端工作区迁移到当前本地 checkout。当前本地项目根目录由用户指定为 `G:\Users\admin\Desktop\code\yesimbot`。

迁移内容包括：

- TypeScript 源码、测试、插件和 Provider。
- `package.json`、`yarn.lock`、Turborepo、TypeScript、lint 和 formatter 配置。
- Git 历史和当前 dirty changes。
- 已生成的 `core/dist` 与 `packages/agent-runtime/dist`，用于保留最近一次已验证的部署产物。
- 原工作区的 `.trellis/`、`.agents/` 和 `.pi/`，包括任务、spec、工作流、Pi 配置和项目 skill。

为了避免把运行环境误当成源码，迁移时没有复制 `node_modules/`、`.turbo/`、运行时 `data/`、历史 `.backups/` 和环境变量文件。首次在本地运行前执行 `yarn install`。

---

### 校验

- 源码和项目文件完成远端到本地的逐文件 SHA-256 校验。
- 排除依赖、缓存、运行数据和备份后，文件数量、总大小和每个文件内容均一致。
- `.trellis/`、`.agents/` 和 `.pi/` 的源文件在合并到新项目后逐文件校验，无缺失和内容变化。
- 新项目已运行 `trellis init -y --pi`，随后合并原项目的 Trellis/Pi 资产。
- 新项目的 `trellis platforms` 显示 `Pi Agent (pi)`，当前任务的 `task.py validate` 通过。

---

### 远端清理

迁移校验通过后，远端执行了以下清理：

- 停止 `yesimbot-koishi`，避免它继续依赖即将删除的源码。
- 删除远端主源码目录 `yesimbot-v4`。
- 删除旧代码副本 `yesimbot-v4-pr-test`。
- 删除共享 `node_modules` 中所有指向上述源码目录的 workspace 软链接。
- 清理本任务产生的临时远端日志和临时类型检查文件。

以下内容没有删除：

- Koishi 配置文件。
- 运行时 `data/`、durable JSONL、凭据目录和其他业务数据。
- 共享 `node_modules/`。
- 远端历史备份目录。
- `yesimbot-napcat` 容器和相关状态。
- `yesimbot-koishi` 容器定义与镜像。容器保持停止状态，不再尝试启动已删除的远端源码。

远端删除是破坏性操作。后续如需重新部署，应从本地 checkout 构建，并重新准备 Koishi 应用根目录的依赖链接和配置。

---

### 后续维护

- 开发入口是 [`AGENTS.md`](../AGENTS.md) 和 [开发与运维规范](DEVELOPMENT-GUIDELINES.md)。
- Agent 相关协议见 [Agent Message Protocol and Delivery State Contract](../.trellis/spec/yesimbot/backend/agent-message-protocol-contract.md)。
- Trellis 任务、spec 和验证证据位于 [`.trellis/`](../.trellis/)。
- 本次迁移没有创建 Git commit。迁移后的本地 checkout 保留了远端原有 dirty changes，提交或清理前必须先区分不同任务的所有权。
