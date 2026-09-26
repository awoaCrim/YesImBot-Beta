# Mogick 多账号余额、Resin 代理池与管理 WebUI

## Goal

把当前单账号 Mogick Proxy 扩展为可通过 HTTPS WebUI 管理的多账号代理：支持真实余额查询、严格账号轮询、基于 Resin 的账号粘性代理池，以及不保存请求内容的 Token/缓存率统计，同时保持 NewAPI 现有内部调用方式不变。

## Background and Confirmed Facts

- 线上服务位于 `ssh2:/opt/mogick-proxy`，通过 Docker Compose 运行。
- NewAPI 通过 `shared-app-network` 使用内部地址 `http://mogick-proxy:20431`，渠道 ID 为 59。规划期间用户通过 NewAPI 管理界面把渠道调整为 3 个选定模型和 1 条映射；Mogick `/v1/models` 仍返回 5 个上游模型。本任务保留该用户配置，不覆盖模型集合。
- 当前实现只有一个进程级 Token、一个刷新状态、一个设备码流程和一个 `/data/token.json`，只能支持一个账号。
- access token 有效期约 2 小时；服务每 80 分钟主动刷新，refresh token 每次刷新后轮换并持久化。
- 当前 `/status` 没有余额、账号池、代理池或使用量统计。
- 当前上游连接为单个直连 HTTP/2 会话；流式响应直接透传，非流式响应由 SSE 聚合器收集最终 usage。
- 已验证真实余额接口为 `GET https://api.tongyuan.cc/subscription/api/v1/user/balance`，响应包含可用、免费、套餐、总额、冻结/活动占用等十进制字符串字段。
- 已验证 `total_balance = free_balance + plan_balance`，`available_amount = total_balance - active_hold_amount`。
- NewAPI 能记录渠道级 Token 与缓存字段，但只能看到一个 Mogick 渠道，无法区分实际使用的 Mogick 账号和 Resin 粘性出口。
- Resin 提供订阅导入、节点健康检查、熔断、持久化粘性绑定、管理 API 和 HTTP/SOCKS5/反向代理入口，适合作为独立代理控制面。
- 当前 Mogick 没有公网 Caddy 路由；本任务将只公开管理界面，不公开推理接口。

## Requirements

### Account Management

- 支持持久化多个同元 OAuth 账号，账号凭证、刷新状态、健康状态和余额快照彼此隔离。
- 新账号只通过 WebUI 发起 OAuth 设备码登录，不提供手工 Token JSON 导入界面。
- 现有 `/data/token.json` 在首次升级时自动迁移为一个启用账号，迁移可重复执行且保留回滚备份。
- WebUI 显示账号标签、启用状态、登录/健康状态、Token 到期时间、最近刷新时间、余额更新时间和 Resin 绑定信息。
- 支持添加、启用、禁用、刷新 Token、刷新余额和删除账号。
- 单个账号刷新失败不得损坏其他账号；一次性 refresh token 必须按账号串行刷新并原子落盘。
- WebUI、管理 API、日志和统计库均不得返回或记录 access token、refresh token。

### Balance and Eligibility

- 按账号调用已验证的同元订阅接口，使用 `available_amount` 作为主要可用额度，并展示 `free_balance`、`plan_balance`、`total_balance`、`active_hold_amount`、`frozen`、`credit_limit`、更新时间和错误。
- 余额值保持十进制字符串精度。接口没有单位字段，UI 统一标为“额度/Credits”，不得宣称为人民币或其他货币。
- 登录成功后立即查询；启用账号默认每 5 分钟刷新；支持 WebUI 手动刷新并限速。
- 新鲜余额快照明确为零或负数时账号不参与轮询；余额查询失败只标记为未知，不单独导致账号禁用。
- 上游明确返回余额不足时立即刷新余额并将该账号排除到状态恢复。

### Strict Round-robin Scheduling

- 默认采用严格轮询：每个新请求从下一个可用账号开始，在可用账号间尽量均匀分配。
- 禁用、未登录、无法刷新、余额不足、无可用 Resin 节点或处于冷却期的账号必须跳过。
- 同一账号发生 401 时，只在其 Token 成功刷新后重试一次。
- 在尚未向客户端发送响应头或响应体时，可对账号级鉴权、额度、限流或连接错误切换下一个账号；总尝试数不得超过本次请求开始时的可用账号数。
- 流式响应一旦开始向客户端输出，不得切换账号或重放请求；错误只终止当前响应并记账。

### Resin Proxy Pool

- 部署独立 Resin 容器并接入 `shared-app-network`；持久化缓存、状态和日志。
- 使用账号粘性绑定：Mogick 账号 ID 作为 Resin Account，同一账号的 OAuth、Token 刷新、余额、模型和推理请求使用同一稳定标识。
- Mogick 负责选择业务账号；Resin 负责该账号的代理节点选择、健康检查、熔断和节点故障切换。
- 优先使用 Resin HTTP 正向代理，通过 `Platform.Account:RESIN_PROXY_TOKEN` 认证并保留到上游的端到端 TLS/HTTP2 行为。
- Resin 不可用或无健康节点时明确失败，不得悄悄直连上游。
- 在 Mogick WebUI 中整合 Resin 订阅、节点、平台、粘性租约、健康状态和必要统计；浏览器只调用 Mogick 管理 API，不直接持有 Resin 管理 Token。
- Resin 原生 WebUI 不作为日常管理入口，可保留为仅内网故障排查能力。
- Resin 管理 Token、代理 Token、订阅地址和节点认证信息不得出现在普通日志或前端持久存储中。

### Usage Metrics

- Mogick 记录每次请求的数值和必要关联元数据：时间、请求 ID、账号、模型、流式标记、结果、耗时、输入 Token、输出 Token、总 Token、缓存命中 Token、缓存率及 Resin 粘性/节点标识。
- 缓存率定义为聚合后的 `cached_input_tokens / input_tokens`；输入为零或上游未返回缓存字段时显示未知，不伪造为 0%。
- 兼容 `prompt_tokens_details.cached_tokens`、`input_tokens_details.cached_tokens`、`usage.cached_tokens` 等常见字段位置。
- 流式请求在透传 SSE 时增量解析最终 usage，只保留不完整行缓冲，不为统计缓存完整响应。
- 统计库只设计数值和关联字段，不设计请求体或响应体字段；不得保存 Prompt、消息正文、回复正文、原始 SSE、工具名称/参数或任何凭证。
- 请求级数值明细保留 30 天并自动清理；每日聚合数据长期保留。
- WebUI 支持最近 24 小时、7 天、30 天和自定义范围，并可按账号、模型聚合请求数、成功率、输入/输出/总 Token、缓存 Token、缓存率和耗时。

### Management WebUI and Authentication

- 通过 Caddy 把 Mogick WebUI 和管理 API 反向代理到 HTTPS 域名；该域名只允许管理页面、静态资源和管理 API，其他路径返回 404。
- `/v1/*` 继续只通过 Docker 内网提供给 NewAPI，不经管理域名公开。
- 使用部署者配置的单一管理员密码或兼容的高熵管理 Token。密码以版本化 scrypt 哈希存放，原始 Token 模式要求至少 24 个 Unicode 字符；登录成功后签发短期 HttpOnly、Secure、SameSite=Strict Cookie。
- 管理凭据通过 Docker secret 或受保护环境配置注入；密码不保存明文，凭据不写入源码、Caddyfile、前端静态资源、URL、localStorage/sessionStorage 或日志。
- 登录失败按 IP 和全局维度限速；所有修改类管理 API 需要已认证会话和 CSRF 防护。
- WebUI 页面至少包括：总览、账号、代理订阅、代理节点/租约、用量统计和运行状态。

### Compatibility, Persistence, and Operations

- 保持 `http://mogick-proxy:20431`、现有 OpenAI 兼容 `/v1/*` 路由和 NewAPI 渠道配置不变。
- 账号凭证持久化于 `/data/accounts/`；统计使用 `/data/mogick.sqlite`；Resin 使用独立持久化目录。
- 删除 Dockerfile 对源码的 `sed` 修改，监听地址和数据目录改为显式环境配置。
- 部署前备份源码、Compose、数据目录和 Caddyfile；构建可回滚的版本化镜像。
- Resin 没有健康节点前不得切换线上推理流量；代理订阅由用户在整合 WebUI 中配置。
- 不修改 NewAPI 本身的渠道调度或前端。
- 功能只用于管理合法持有的账号和代理，不实现绕过计费、免费额度或上游限制的逻辑。

## Acceptance Criteria

- [ ] 可通过 Caddy HTTPS 域名和管理 Token 登录 WebUI；未授权管理 API 被拒绝，公网域名无法访问 `/v1/*`。
- [ ] 可通过 WebUI 添加至少两个 OAuth 账号，现有 `token.json` 自动迁移且容器重建后账号仍存在。
- [ ] 每个账号能显示登录、健康、Token 到期/刷新、真实余额和 Resin 粘性绑定状态。
- [ ] 连续请求在可用账号之间严格轮询；禁用、失效、余额不足、无代理或冷却账号被跳过。
- [ ] 安全可重试错误能在输出开始前切换账号；流式输出开始后不跨账号重放。
- [ ] 可在 Mogick WebUI 中管理 Resin 订阅并查看节点、平台、租约、健康与代理统计。
- [ ] 同一账号所有同元流量使用同一 Resin Account 标识；Resin 故障时不会未经配置直连。
- [ ] 流式和非流式请求在上游返回 usage 时均正确记账。
- [ ] WebUI 可按时间、账号和模型展示请求数、成功率、输入/输出/总 Token、缓存 Token、缓存率和耗时。
- [ ] 请求级明细 30 天后自动清理，每日聚合长期保留。
- [ ] 数据库、管理响应和日志不保存或泄露请求体、响应体、OAuth Token、管理 Token、代理 Token或订阅凭证。
- [ ] NewAPI 无需修改渠道地址或模型配置即可继续调用 Mogick。
- [ ] 有经过验证的备份、迁移和回滚路径。

## Out of Scope

- WebUI 手工导入 OAuth Token JSON。
- 修改 NewAPI 前端、计费或渠道轮询。
- 公网暴露 OpenAI 兼容推理接口或 Resin 代理入口。
- 保存或检索用户 Prompt、模型回复和工具调用内容。
- 绕过同元或代理服务的计费、风控和账号限制。

## Research References

- `research/balance-api.md`
- `research/multi-account-webui-architecture.md`
- `research/resin-integration.md`
- `research/usage-metrics.md`
