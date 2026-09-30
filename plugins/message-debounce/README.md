# yesimbot-message-debounce

为每个 YesImBot conversation 提供 trailing-edge 输入防抖，默认安静窗口为 15 秒。

- 普通 Message 保持原有行为：每次输入刷新计时器，超时后按原顺序 flush 一个不可变快照。
- 当 Core 同时提供 batch-input extension、所选 Will 实现 `decideBatch()` 时，controller 还可接收 `notice.poke` Event。
- poke 只有在 `actorId` 为非空字符串且 `targetId === selfId` 时进入并刷新当前批次；actor 来自平台 Translator 的类型化元数据，不解析 rendered text。
- 非 poke、缺少 actor、目标不是当前 Bot 的 poke、其他内部 Event 和可信 `messenger.post()` 不进入本 controller。
- Message → poke → Message 共享一个 timer、一个有序 snapshot 和一次 batch Will 判定。
- 插件或 Runtime stop 会取消 timer 并丢弃尚未 flush 的引用；旧的只提供 Message callback 的 Core/插件组合仍可继续使用。

```yaml
yesimbot-message-debounce:
  quietSeconds: 15
```
