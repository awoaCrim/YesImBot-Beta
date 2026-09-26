# 修复 Key 用量门户缓存 Token 显示

## Goal

让 API Key 用户在 `/key-usage` 的“请求记录”列表中直接看到每次请求的缓存命中 Token 数，而不必打开详情或猜测输入 Token 中是否包含缓存命中。

## Background

- 生产日志数据库中存在缓存命中数据：当前有 `61,717` 条日志的缓存字段大于零，`cache_read_tokens` 合计为 `6,246,111,086`；当前数据未记录 cache-write Token。
- 后端 `TokenLogItem` DTO 已安全地返回 `cache_read_tokens`、`cache_write_tokens`、`cache_write_tokens_5m` 和 `cache_write_tokens_1h`，不存在后端漏查或 DTO 丢字段。
- 前端详情弹窗已显示 `Cache Read Tokens` 和 `Cache Write Tokens`。
- 当前请求记录主表只渲染 Input Tokens、Output Tokens、Cost 等列，没有渲染任何缓存 Token 列，因此用户在列表中看不到已有的缓存命中数据。

## Requirements

1. 请求记录主表新增缓存 Token 列，显示该条日志的 `cache_read_tokens`。
2. 缓存 Token 使用与输入/输出 Token 相同的整数格式；值为 `0` 时明确显示 `0`，避免误解为字段缺失。
3. 保留现有 Input Tokens 和 Output Tokens 含义，不改变后端计费、日志记录、分页、筛选或 Token 鉴权行为。
4. 保留详情弹窗中的缓存读写信息；本次只修复列表可见性，不扩大公开 DTO 或暴露新的敏感字段。
5. 更新表格空状态的 `colSpan`，确保新增列后布局正确。
6. 增加前端回归测试，证明具有非零 `cache_read_tokens` 的请求会在请求记录表格中显示该数值。

## Acceptance Criteria

- [ ] `/key-usage` 请求记录表头包含可翻译的“缓存 Token”列。
- [ ] 当日志 `cache_read_tokens = 1234` 时，列表对应行显示格式化后的 `1,234`。
- [ ] 当日志 `cache_read_tokens = 0` 时，列表对应行显示 `0`。
- [ ] Input Tokens、Output Tokens、Cost、Duration、Request ID 和详情按钮继续正常显示。
- [ ] 无记录时的空状态仍横跨完整表格。
- [ ] 前端回归测试、typecheck、受影响文件 lint 和 build check 通过。
- [ ] 变更提交并按既有 `ssh2` 精确提交部署流程发布后，生产 `/key-usage` 可访问且容器健康。

## Out of Scope

- 修改缓存 Token 的采集、计费或数据库结构。
- 将 cache-write 5m/1h 拆分字段加入主表；这些信息继续保留在详情与现有 API 中。
- 修改使用分析汇总、模型聚合或其他后台日志页面。
- 修改 API Key 的内存存储、鉴权、隐私 DTO 或查询缓存隔离机制。

## Technical Notes

- 根因位于 `web/src/features/key-usage/components/token-request-log-table.tsx`：表格表头和数据行均未包含 `cache_read_tokens`。
- 后端 `controller/log.go` 已将 `model.Log.CacheReadTokens` 映射为 `cache_read_tokens`，无需修改后端。
- 这是轻量前端展示缺陷，PRD-only 足以进入实现评审。
