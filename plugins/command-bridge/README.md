# koishi-plugin-yesimbot-command-bridge

让 YesImBot 主 LLM 通过工具调用 Koishi 生态中的命令，并完全接管命令的输入输出。

## 设计

- `koishi_execute` 静默执行 Koishi 命令。
- `koishi_execute_list` 列出当前策略下可用的 Koishi 命令。
- `koishi_execute_help` 查看命令的详细帮助信息（参数、选项、示例）。
- 命令内部通过 `session.send` / `session.sendQueued` 产生的输出会被捕获，不会自动发送到群里。
- 通过 `session.bot.sendMessage()` 产生的输出也会被捕获。
- `session.prompt` 在 `interactive: "ask"` 时返回 `awaiting_prompt`，主模型调用 `koishi_prompt_answer` 继续命令。
- 是否把命令结果转述到群里由主 LLM 决定。

## 配置

```yaml
allowedScopes:
  # Authorize this user in any channel whose platform/channel rule matches.
  - platform: onebot
    channelId: "*"
    userId: "10001"
    selfId: "*"
  # Authorize one exact channel, regardless of chat type.
  - platform: onebot
    channelId: "123456789"
    selfId: "3535802886"

trustMode: locked
allowCommands:
  - weather
  - search
hardDeny:
  - yesimbot
  - koishi_execute
  - koishi_execute_abort
  - koishi_prompt_answer
agentAuthority: 0
agentPermissions: []
userActor: disabled
crossChannel: false
timeoutMs: 30000
maxTranscriptChars: 20000
```

`trustMode: "full"` 会收集 Koishi 当前全部权限并给 agent 使用，同时 `agentAuthority` 为 0 时默认使用 4。

`userActor: "any"` 允许模型传入 `actor: { kind: "user", userId }` 代执行，插件看到的 `session.userId` 就是目标用户。

## 安全

- `hardDeny` 始终生效，默认禁止 yesimbot 自身命令和桥接工具，防止递归调用。
- `locked` 模式只允许 `allowCommands`。
- `userActor` 默认关闭，开启后仍建议限制命令范围。
- `crossChannel` 默认关闭。
- `allowedScopes` 是唯一的工具暴露白名单：规则按 OR 合并、字段按 AND 匹配，不额外区分私聊和群聊。群聊中的 `userId` 按当前消息发送者匹配；一个用户规则配合 `channelId: "*"` 可让该用户在任意群使用工具，多条当前消息则要求所有发送者都获授权。没有发送者身份时，只有不带 `userId` 的频道规则能授权。设置为空数组即可拒绝全部工具。可用 `userId` 限定用户身份、用精确 `channelId` 限定频道，`selfId` 可选用于限定机器人账号。默认授权 OneBot 用户 QQ `1049700117`。
