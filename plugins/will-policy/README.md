# yesimbot-will-policy

可选的 YesImBot `WillEngine` / routing 策略插件。插件不安装时 Core 使用原有默认策略；`engine: routing` 时不会读取或修改 willingness 状态。

## 兼容模式

现有 willingness 配置默认保持旧行为：

```yaml
engine: willingness
willingness:
  batchDecision: per-input
  decayMode: weighted
  persistState: false
```

这三个默认值分别表示逐条采样与立即扣除 `replyCost`、旧热/温窗口加权衰减、Runtime 内存状态。旧 routing、默认 Core Will、第三方只实现 `decide()` 的 Will 以及只接收 Message 的 batch 插件都继续走原路径。

## 批次意愿模式

`batchDecision: highest-candidate` 启用按 conversation、按发言人隔离的批次意愿：

1. 普通消息和已验证的定向 poke 进入同一个 trailing-edge 防抖批次。
2. 每条输入只累计到自己的作者；图片不额外加分。
3. direct、明确 @当前 Bot、`quote.author.id === selfId` 和定向 poke 只提供当前批次的临时候选增益；同时出现时取最大值，不相加。
4. 关键词使用 NFKC、忽略大小写和合并空白后的当前正文；quote/reply 子树及持久化引用正文不参与匹配。
5. 整批选择候选分最高的作者，只采样一次、最多创建一个 reservation，并从批次最后一个输入启动一个 deferred turn。
6. 已有未结 reservation 的作者仍累计基础分，但在 settlement 前不能再次成为候选。

`@all`、`@here`、图片和引用其他用户/其他 Bot 都按普通输入处理。poke 作者只读取 Translator 写入的 `actorId`，不会从 `text` 中解析。

## Reservation 与真实送达

批次命中后，`replyCost` 先以 reservation 形式写入状态，写入失败时 Core 不启动 Agent。reservation 立即降低可用分并阻止同一作者重复预留，但不会先修改 confirmed score。

- 当前 conversation 的 `send_message.onDelivered` 返回至少一个真实 message ID：确认 reservation，并扣除创建时记录的 amount；部分分段成功也算已回复。
- 完全沉默、全部发送失败、跨频道发送、空 message ID 列表、turn failed/aborted、consume/start 失败：释放 reservation，不扣分。
- 重复或迟到的 settlement 是幂等 no-op；delivery 先发生时，后续失败终态不会退款。

## 持久化与恢复

`persistState: true` 只用于 `highest-candidate` 模式。状态位于：

```text
<ChannelResources.path>/willingness.json
```

文件使用 `version: 1`，并按 `selfId` 分区。每次 mutation 串行执行，通过唯一同目录临时文件和 atomic rename 发布；rename 成功前不会替换内存快照。Runtime 重建、插件 reload 或进程重启时会按真实经过时间衰减 confirmed score，并删除所有未完成 reservation，不扣除其 amount。损坏、截断或未知版本文件会产生一次受控警告，并从空状态继续启动。

`decayMode: half-life` 使用严格指数衰减：

```text
score(t) = score(t0) × 2^(-(t - t0) / decayHalfLifeSeconds)
```

批次模式使用输入 timestamp，未来 timestamp 会夹到当前时间，乱序 timestamp 不会让衰减时间倒退。

## 经校准的生产配置模板

以下模板是已批准的参数档案，仅作为部署时显式迁移参考；源码实现不会自动修改生产 `koishi.yml`：

```yaml
engine: willingness
willingness:
  batchDecision: highest-candidate
  decayMode: half-life
  persistState: true

  maxScore: 100
  initialScore: 0
  textGain: 12
  imageGain: 0
  probabilityThreshold: 54.2
  probabilityAmplifier: 0.0355
  replyCost: 35

  directGain: 66
  mentionGain: 66
  quoteGain: 66
  pokeGain: 66

  decayHalfLifeSeconds: 600
  keywords: [MyGO, 乐队, 吉他, 练习, 演出]
  keywordMultiplier: 1.5
  defaultMultiplier: 1

  mentionForce: false
  quoteForce: false
  directForce: false
```

在无衰减、尚未确认回复的情况下：普通输入 1～5 的候选分约为 `12.00 / 23.83 / 43.36 / 62.68 / 76.78`，对应概率约为 `0% / 0% / 0% / 30.1% / 80.2%`；首次 direct、自身 mention、自身 quote 或定向 poke 的候选分约为 `77.05`，概率约为 `81.1%`。

## 配置约束

插件会拒绝非有限数值、`maxScore <= 0`、负 gain/cost/multiplier、非法半衰期、`initialScore` 或 threshold 超过 `maxScore`、热窗口大于温窗口、规范化后为空的关键词，以及以下无效组合：

- `persistState: true` 但未启用 `highest-candidate`；
- `highest-candidate` 与任一 force flag 同时启用。

切回 `engine: routing` 是回滚开关。已有 `willingness.json` 会保留但保持惰性，不参与 routing 决策。
