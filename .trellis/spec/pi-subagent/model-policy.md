# 模型策略与显示契约

## 1. Scope / Trigger

配置 -> 派发 -> runner/retry -> snapshot -> TUI 的跨层本地补丁。任务来源：`.trellis/tasks/09-08-subagent-ui-model-selection/`。模型由用户统一配置，不由主 agent 选型。

## 2. Signatures

`src/model-policy.ts`：

- `readModelPolicyFile(file?): Promise<ModelPolicySnapshot>`
- `parseModelPolicy(raw, source?): ModelPolicySnapshot`
- `resolveModelRoute(policy, agent?): ModelRoute`
- `validateModelRequest(policy, options): ModelPolicyValidation`
- `formatModelPolicyPrompt(policy, error?): string`

## 3. Contracts

全局 `~/.pi/subagent.json` 中 `modelPolicy.default = { model, fallbackModels? }`，`modelPolicy.agents` 按角色映射到同结构路由。

- model 为明确的 provider/id；只 trim，不模糊匹配或转换大小写。
- 角色名规范化后匹配，有角色路由就整条使用，否则使用 default；默认配置必需。
- 路由未写 fallbackModels 时为空，不混用默认路由的备用列表。
- 每个外部 spawn/plan task 必须显式传 model，并与路由一致。fallback_models 省略则使用配置，显式提供则须值及顺序完全相同。
- 模型不从 agent frontmatter、旧 taskDefaults 或父模型继承；非模型字段保留原规则。
- 每次派发读取配置，run 内使用快照；变更不能影响已运行任务的 retry。
- TUI 展示实际 attempt 模型；排队只能声明计划模型，未知实际模型不能伪装为请求型号。
- 动态提示仅含模型路由与规则，不枚举凭据或 provider 敏感配置。

## 4. Validation & Error Matrix

| 输入/状态                                  | 结果                                   |
| ------------------------------------------ | -------------------------------------- |
| 缺配置、缺 default、格式错误               | 加载/派发清晰错误，不继承其他模型      |
| 缺 model 或与配置不一致                    | spawn 前拒绝，提示预期型号             |
| 备用列表添加、删减、重排                   | spawn 前拒绝                           |
| 未知策略字段、重复角色规范名、重复备用型号 | 解析拒绝，防止用户配置失误             |
| 无角色专属路由或无 agent                   | 使用用户配置的 default                 |
| status/wait/cancel 等管理动作              | 不依赖新模型配置                       |
| 配置在任务运行中变化                       | 当前任务继续原快照，下一次派发用新配置 |

## 5. Good / Base / Bad Cases

- Good：研究角色有专属模型，调用显式传该型号；原模型瞬态失败后只使用该角色配置的备用型号。
- Base：临时任务按统一默认模型校验，无备用列表则不换型号。
- Bad：调用方为了绕过成本/型号选择，传 agent.md 中旧型号或自创 fallback，必须拒绝。

## 6. Tests Required

- 解析边界、角色/default 路由、未知/重复字段、空列表覆盖语义。
- 单任务/并行全部校验、plan 无进程副作用、管理动作无配置可用。
- 真正内部 synthesis 调用链与 resume 模型覆盖，不能只测试形似这些功能的普通 TaskSpec。
- fake runner 模拟不同型号的失败和成功，断言实际 model、attemptedModels、用量累计及状态事件。
- 渲染 queued/running/retry/terminal、并行、后台、窄宽度和旧快照缺失字段。
- 提示刷新后映射可见、没有旧提示与新规则矛盾。
- 类型测试依赖实际安装 Pi，不允许仅用旧迁移备份宣称兼容。

## 7. Wrong vs Correct

Wrong：将缺 model 自动补成父会话型号，或只改 renderer 显示请求的 model。
Correct：先根据统一策略校验显式 model；由 runner/attempt 写入实际型号，再传播到状态与所有渲染入口。

Wrong：覆盖 npm 安装不留记录，或修复后忘记更新 replay 散列。
Correct：修改前备份并散列，保留基线不变，最终改动同步到可重放文件；升级后先比对基线，拒绝覆盖未知修改。

## 发布与安装边界

维护源码为 G:/Users/admin/Desktop/code/pi-subagent；已发布 fork @cr1ms0n/pi-subagent@0.8.1。原 @parke.dev 是上游来源而不是后续修改入口。打包前保留 MIT、审计无凭据/本机路径/备份；使用已有登录和 TLS 校验。只在 registry metadata/integrity 与测试 tarball 一致后替换 Pi 启用项，不同时启用新旧同名工具。旧包可留磁盘但不能留重复 packages 入口。测试 trusted SDK 层不等同 extension policy 安全保证。
