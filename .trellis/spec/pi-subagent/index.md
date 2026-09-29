# Pi subagent 本地扩展规范

适用本机 @parke.dev/pi-subagent 本地补丁，不代表 npm 上游行为。

## Pre-Development Checklist

- 阅读 [模型策略与显示契约](./model-policy.md)。
- 查看实际安装版本、LOCAL-PATCH 与备份，不能升级覆盖本地修改。
- 阅读当前安装 Pi 的 extensions.md/tui.md 和相关示例；不要以迁移目录中的旧类型替代运行版本。
- 读取 `.trellis/spec/guides/` 的 cross-layer 与 code-reuse 指南。

## Quality Check

- 严格类型检查必须对应实际运行版本，缺类型环境应与源码错误分开记录。
- fake runner 覆盖校验、retry、resume、内部 synthesis 和 TUI 渲染；未经授权不做付费 provider 测试。
- 修改后同步可重放文件与散列，但保留原 baseline 不变。
- 配置中不存凭据；不要为验证读取 credential 或真实 session 正文。
