# 订阅到期与配额运维合同

## 1. Scope / Trigger

- Trigger：在已确认的 3x-ui/Xray VLESS inbound 与 Caddy 静态订阅入口上增加客户端配额、绝对到期时间或独立永久订阅。
- Scope：只修改登记的 3x-ui client、登记的 YAML 发布文件、精确的 Caddy 路由和任务专用失效 timer。
- Boundary：公开下载层只负责隐藏/拒绝 YAML；已下载 YAML 的实际失效必须由 3x-ui/Xray client 状态执行。
- Secrets：默认情况下，完整 URL、path token、UUID、Reality 私钥、面板凭据和 API token 只能留在远程 root-only 状态文件，不进入命令参数、普通日志、任务文档或聊天。
- Explicit UI exception：只有在用户明确要求从管理面板获取链接时，才允许把指定 URL 写入对应 3x-ui client 的 `comment` 字段。该字段视为凭据，必须先备份 client、只通过受保护的 API 更新，并在报告和聊天中继续隐藏完整值。

## 2. Signatures

### 3x-ui API

```text
GET  /panel/api/inbounds/get/{inbound_id}
GET  /panel/api/clients/get/{email}
POST /panel/api/clients/update/{email}    # top-level model.Client payload
POST /panel/api/clients/add               # {client: model.Client, inboundIds: number[]}
POST /panel/api/clients/del/{email}?keepTraffic=1
```

更新 payload 必须显式构造。`clients/get` 的返回对象可能同时暴露数值数据库 `id` 和字符串 `uuid`，`allowedIPs` 也可能被序列化为字符串；不能未经归一化直接回写整个 GET 响应。

### 受限 client 字段

```text
inboundIds       = [target_inbound_id]
totalGB          = 500 * 1024^3 = 536870912000   # API/DB bytes
expiryTime       = epoch milliseconds
trafficReset     = never
reset            = 0
enable           = true until 3x-ui disables it
```

### 永久 client 字段

```text
inboundIds       = [target_inbound_id]
totalGB          = 0
expiryTime       = 0
trafficReset     = never
reset            = 0
enable           = true
```

### 失效命令和调度

```text
subscription-expiry-quota-disable --self-test
subscription-expiry-quota-disable --dry-run --now <epoch_seconds>
subscription-expiry-quota-disable --state <root-only-state-file>
```

systemd timer 使用带 UTC 的绝对时间、`Persistent=true` 和精确到秒的 `AccuracySec`；service 只调用 root-only 失效脚本。

## 3. Contracts

### Request and storage contract

- 先验证 inbound ID、端口、协议和 client 到 inbound 的绑定，再执行任何 API mutation。
- 受限 client 保留既有 UUID 和 `subId`。永久 client 使用新 email/label、新 UUID、新公开 path 和独立 YAML。
- `totalGB` 在该 3x-ui 版本的 API/数据库层按字节保存；500 GB 的任务值为 `536870912000`。
- `expiryTime` 使用 epoch 毫秒，时间换算必须同时记录业务时区和 UTC，不依赖 VPS 默认时区。
- `totalGB=0` 和 `expiryTime=0` 只对永久 client 使用，并在 API 返回中复核为不限流量、永不过期语义。

### Publication contract

- YAML 只包含用户侧连接字段：地址、端口、VLESS、flow、SNI、Reality 公钥、short ID 和对应 UUID。
- 受限和永久 YAML 使用不同文件名、不同 UUID、不同公开 path；永久文件不得落入受限失效脚本的目标集合。
- 生产发布文件必须是 `root:root`、模式 `0600`，使用 staging 文件和原子 rename/replace。
- Caddy 修改后先在实际容器中执行 `caddy validate`，成功后才 reload；下载响应应设置 YAML Content-Type、正确文件名和 `Cache-Control: no-store`。

### WebUI comment display contract

- 管理面板标注只适用于用户明确指定的 client。使用 `comment = "永久订阅链接：" + public_url`，不要修改 UUID、`subId`、配额、到期或启用字段。
- 更新前把完整 client API 快照保存到远程 root-only、模式 `0600` 的备份文件；API payload 必须显式归一化，不得原样回写 GET 响应。
- 更新后重新 GET 目标 client，断言 `comment` 完整保存，并断言 email、UUID、`subId`、配额、到期、reset 和 enable 字段保持不变。
- 不要把该 URL 填入会参与订阅合并的 external subscription 字段，除非需求明确要改变原生订阅内容；仅展示链接时优先使用 comment。

### Expiry state contract

任务状态文件至少声明受限文件、过期 marker、受限文件期望 hash、过期 epoch、root-only backup 目录和永久文件路径。脚本每次执行必须校验：

- task 标识匹配；
- 生产路径与登记路径精确匹配；
- 受限文件不是 symlink，owner/group 为 root，mode 为 0600；
- 文件 hash 与登记值一致；
- marker 不与 live file 同时存在；
- 只操作登记的受限文件，禁止 wildcard、目录级清理或按前缀猜测。

## 4. Validation & Error Matrix

| Condition                                 | Required result                            | Action                                                              |
| ----------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| inbound ID、端口或协议不匹配              | `inbound_identity_mismatch`                | Stop before mutation                                                |
| client 未绑定目标 inbound                 | `*_not_attached_to_target_inbound`         | Stop and investigate                                                |
| GET 返回 shape 无法归一化                 | explicit shape/API error                   | Do not echo response back                                           |
| 受限 UUID 或 YAML UUID 不一致             | `*_uuid_mismatch`                          | Stop; preserve current publication                                  |
| 受限 `subId` 在 update 后改变             | `limited_subid_changed`                    | Roll back client update                                             |
| Caddy validate 失败                       | non-zero validation                        | Do not reload; restore backup if already staged                     |
| timer state、path、mode 或 hash 漂移      | guard failure                              | Do not move or delete any file                                      |
| 当前时间早于 expiry epoch                 | `action=not_due`                           | No mutation                                                         |
| 当前时间达到 expiry epoch 且 fixture 通过 | `action=would_expire` in rehearsal/dry-run | Production run may atomically move restricted file                  |
| VPS `NTPSynchronized=no`                  | timing risk                                | Record caveat; do not claim exact x3 cutoff without clock assurance |

## 5. Good / Base / Bad Cases

- **Good**：在远程 root-only 目录备份 SQLite/WAL、配置和发布文件；显式构造 API payload；先验证两个 client，再生成白名单 YAML；Caddy validate 通过后 reload；timer 只引用受限路径；self-test 和 dry-run 通过。
- **Base**：保留受限公开 path，新增独立永久 path；立即复核 API 字段、运行配置、监听、HTTP 状态和文件权限；把截止后的 HTTP 与 UUID 复核列为延期验收。
- **Bad**：把 GET 返回对象原样回写；用 UUID、文件名前缀或 wildcard 清理；把 `0` 的不限语义未经实际 API 复核就当作事实；只删公开 YAML 却不设置 3x-ui expiry；在未 validate 的 Caddyfile 上 reload；打印完整 URL 或 token；未经用户明确要求就把 URL 写进 client comment；把同一 Caddy URL 填进 external subscription 造成订阅内容合并或重复。

## 6. Tests Required

- API integration：断言目标 inbound、受限 client 的 `totalGB`、`expiryTime`、`trafficReset`、`enable` 和 `subId` 保持；断言永久 client 的 `totalGB=0`、`expiryTime=0`、`enable=true`，且 UUID/label 独立。
- Xray integration：断言配置测试成功、目标端口监听、运行配置包含两个 client；不输出 UUID。
- YAML audit：断言两份 YAML 可解析、UUID 不同、只含用户侧白名单字段，不含私钥、密码、API token 或管理字段。
- Publication integration：断言 Caddy validate 成功；受限和永久入口的 HTTP 状态、大小、Content-Type、文件名响应头正确。
- WebUI display integration：断言目标 client 的 comment 含有指定标签和 URL，且 UUID、`subId`、配额、到期、reset 和 enable 字段未改变；通过客户端卡片或详情视图确认可见。
- Expiry unit：`--self-test` 断言受限 fixture 被移出而永久 fixture 保留；截止前 dry-run 为 `not_due`，截止时 dry-run 为 `would_expire`；重复执行是幂等的。
- Post-deadline acceptance：在截止后断言受限入口返回 404/410、已下载受限 UUID 最终被拒绝，永久入口仍为 200 且永久 client 未被误伤；记录 3x-ui 统计/Xray 重载延迟。

## 7. Wrong vs Correct

### Wrong

```python
# 把 GET 响应直接作为 update payload。
update_client(email, get_client(email))

# 按前缀删除所有订阅文件。
for path in subscriptions.glob("x3-vless-2260*"):
    path.unlink()
```

### Correct

```python
# 显式归一化 model.Client，并只覆盖任务字段。
payload = model_client_payload(client, preserved_uuid)
payload.update(totalGB=536870912000, expiryTime=expiry_ms,
               trafficReset="never", reset=0, enable=True)
update_client(email, payload)

# 从 root-only 状态文件取得唯一受限路径，校验 hash 后原子移动。
check_file(restricted, expected_hash)
os.replace(restricted, expired_marker)
```

### Wrong

```text
expiry = "2026-09-25 23:59:59"
# 交给 VPS 默认时区解释。
```

### Correct

```text
Shanghai: 2026-09-25T23:59:59+08:00
UTC:      2026-09-25T15:59:59Z
Timer:    OnCalendar=2026-09-25 15:59:59 UTC
```
