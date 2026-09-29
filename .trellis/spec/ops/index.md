# 运维规范

本层记录跨主机、跨服务的可执行运维合同。涉及 3x-ui/Xray 客户端策略、Caddy 静态订阅发布和 systemd 到期调度时，先阅读对应规范。

## 规范

- [服务器文件清理合同](./server-cleanup.md)：SSH 远程清理的精确路径、系统/凭据/服务/Docker 边界和前后验证要求。
- [订阅到期与配额合同](./subscription-expiry-quota.md)：受限/永久订阅隔离、3x-ui 字段、YAML 发布和精确失效调度。
