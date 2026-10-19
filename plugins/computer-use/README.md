# koishi-plugin-yesimbot-computer-use

通过 Responses function calling 驱动隔离的 Anon LXQt VM，把完整的可见桌面任务委托给一个内部子循环。

## 为什么是一个委托工具

主 Agent 只看到一个 `computer_use` 工具；插件内部的短生命周期子循环才会看到 `desktop_*` 动作工具和来宾截图。来宾执行器通过固定的 MCP SSE 地址连接常驻的 Anon X11/LXQt 桌面，截图和动作都留在来宾边界内。

- 该插件自身只向主 Agent 暴露一个 `computer_use` 委托工具，不注册 `desktop_*` 原始动作工具；其它 MCP 插件是否提供独立工具由各自配置决定。
- 不使用宿主 `DISPLAY`，来宾桌面不可用时 fail-closed。
- 不回退到 headless Chromium、宿主 shell 或其它用户的桌面。
- 截图只通过 `EphemeralImageProjectionStore` 投影给当前请求，不写入会话历史。
- 需要确认的后果性动作由子模型调用 `request_confirmation` 表达，插件不执行该批动作，也不自动确认。

## 为什么不用原生 `computer` tool

OpenAI 原生 `computer` / `computer_use_preview` tool 只有少数官方模型和端点支持。当前生产网关会直接返回 `Unsupported tool type: computer`，所以插件改用普通 function calling 实现同一套循环：

- 工具就是普通的 `function` 定义（`desktop_click`、`desktop_type` 等），任何支持图片输入 + function calling 的模型都能用。
- 每一步把最新截图作为 `input_image` 回灌，模型据此决定下一步动作。
- 请求是**无状态**的：插件自己重放有限历史，不依赖 `previous_response_id` 和 provider 端存储。

代价是 provider 侧的 `pending_safety_checks` 不再存在，改由 `request_confirmation` 工具 + 插件侧动作白名单兜底。

## 配置

```yaml
plugins:
  yesimbot-computer-use:
    enabled: true
    apiKey: ${OPENAI_API_KEY}
    model: gpt-6-luna
    mcpEndpoint: http://172.20.0.1:18200/sse
    maxSteps: 20
    timeout: 180
```

`model` 需要支持图片输入和 function calling。`displayWidth` / `displayHeight` 只用于向模型说明截图坐标范围，默认 `1280x800`。`toolType` 和 `environment` 已弃用，仅为兼容旧配置保留，不再影响请求。API key 只进入请求 header，不会写入工具结果或日志。

`allowedScopes` 是原生桌面工具的唯一暴露白名单：规则按 OR 合并、字段按 AND 匹配，不额外区分私聊和群聊。群聊中的 `userId` 按当前消息发送者匹配；一个用户规则配合 `channelId: "*"` 可让该用户在任意群使用工具，多条当前消息则要求所有发送者都获授权。没有发送者身份时，只有不带 `userId` 的频道规则能授权。没有任何可能匹配的规则时不会注册 `computer_use` 工具；默认授权 OneBot 用户 QQ `1049700117`。

## 子循环工具

| 工具                   | 作用                         |
| ---------------------- | ---------------------------- |
| `desktop_move`         | 移动鼠标                     |
| `desktop_click`        | 单击，支持左右键和修饰键     |
| `desktop_double_click` | 双击                         |
| `desktop_drag`         | 按点序列拖拽                 |
| `desktop_type`         | 向当前焦点输入文本           |
| `desktop_key`          | 按键组合，如 `["CTRL","L"]`  |
| `desktop_scroll`       | 在指定位置滚动               |
| `desktop_screenshot`   | 仅截图                       |
| `desktop_wait`         | 短暂等待桌面稳定             |
| `request_confirmation` | 请求用户确认，不执行任何动作 |

## 来宾契约

MCP 服务端需要提供：

- `desktop_get_screenshot`
- `desktop_move`
- `desktop_click`
- `desktop_drag`
- `desktop_type`
- `desktop_key`
- `desktop_scroll`

这些工具只接受固定的本地桌面动作；目标显示由来宾 helper 自己发现并校验，不由模型选择。来宾动作实现不得使用 `xdotool mousemove --sync`：指针已位于目标坐标时该标志会永久阻塞，导致点击和滚动超时。
