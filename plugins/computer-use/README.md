# koishi-plugin-yesimbot-computer-use

通过 OpenAI Responses API 的原生 `computer` tool，把完整的可见桌面任务委托到隔离的 Anon LXQt VM。

## 为什么是一个委托工具

主 Agent 只看到一个 `computer_use` 工具；插件内部的短生命周期子循环才会看到 OpenAI 的结构化 computer call 和来宾截图。来宾执行器通过固定的 MCP SSE 地址连接常驻的 Anon X11/LXQt 桌面，截图和动作都留在来宾边界内。RDP 只用于人工查看，不是 Anon 使用桌面的前提。

- 该插件自身只向主 Agent 暴露一个 `computer_use` 委托工具，不注册 `desktop_*` 原始动作工具；其它 MCP 插件是否提供独立工具由各自配置决定。
- 不使用宿主 `DISPLAY`；优先连接来宾常驻的 `DISPLAY=:99`，必要时才使用当前 Anon XRDP 会话。
- 不回退到 headless Chromium、宿主 shell 或其它用户的桌面。
- 截图只通过 `EphemeralImageProjectionStore` 投影给当前请求，不写入会话历史。
- OpenAI 返回 `pending_safety_checks` 时不执行该批动作，也不自动确认。

## 配置

```yaml
plugins:
  yesimbot-computer-use:
    enabled: true
    apiKey: ${OPENAI_API_KEY}
    model: gpt-5.4
    toolType: computer
    mcpEndpoint: http://172.20.0.1:18200/sse
    maxSteps: 20
    timeout: 180
```

旧的 preview 模型可以设置 `toolType: computer_use_preview`，并按实际桌面设置 `displayWidth`、`displayHeight` 和 `environment`。API key 只进入请求 header，不会写入工具结果或日志。

`allowedScopes` 是原生桌面工具的唯一暴露白名单：规则按 OR 合并、字段按 AND 匹配，不额外区分私聊和群聊。群聊中的 `userId` 按当前消息发送者匹配；一个用户规则配合 `channelId: "*"` 可让该用户在任意群使用工具，多条当前消息则要求所有发送者都获授权。没有发送者身份时，只有不带 `userId` 的频道规则能授权。没有任何可能匹配的规则时不会注册 `computer_use` 工具；默认授权 OneBot 用户 QQ `1049700117`。

## 来宾契约

MCP 服务端需要提供：

- `desktop_get_screenshot`
- `desktop_move`
- `desktop_click`
- `desktop_drag`
- `desktop_type`
- `desktop_key`
- `desktop_scroll`

这些工具只接受固定的本地桌面动作；目标显示由来宾 helper 自己发现并校验，不由模型选择。来宾 `anon-desktop.service` 开机常驻 `1280x800` 的虚拟 X11/LXQt 桌面，因此没有 RDP 登录时也能截图和操作。
