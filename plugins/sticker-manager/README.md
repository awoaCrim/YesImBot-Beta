# YesImBot 表情包管理

这个插件帮机器人收藏、分类和使用表情包。

- 群里有人发了好图，机器人可以收藏下来，之后聊天时主动使用。
- 管理员可以批量导入、重命名分类、删除和清理表情包。
- 默认所有频道共用同一个表情包库，也可以改成每个频道独立。

## 怎么启用

### 用 dev 仓库体验

如果你在用 dev 仓库的 `setup-koishi` 脚本，脚本会自动发现这个插件，不需要手动装依赖。

```bash
node scripts/setup-koishi.mjs --create-app ../my-koishi --start
```

启动后打开 Koishi 控制台，找到并启用 `yesimbot-sticker-manager`。

### 用已发布版本

在 Koishi 插件市场搜索 `yesimbot-sticker-manager`，安装并启用即可。

## 日常使用

机器人自己会用这些能力：

- 实际看过聊天图片后，可用 `sticker_steal` 收藏，并由主模型提交具体分类（可用 `enableSteal` 关闭）。只有资源链接或元数据不算看过；历史阅读结果无法验证时要重新读图。
- 聊天需要已有表情包时，使用当前可见库的完整精确 ID 发送。`sticker_preview` 可选，用于查看实际画面，不限制发送目标。
- 表情包可以单独回应，也可以放在文字前后或两段文字之间；不要求每轮都发，同一轮最多发一张。
- 找不到分类时会告诉你，或问管理员先导入。

表情包库概览不会自动附加到每轮模型请求。模型需要挑选时，可用 `sticker_categories` 或 `sticker_search` 查询当前库，再自主决定是否使用；不要求群友先提出，也没有固定发送频率。

群友不需要记任何命令。

与支持统一回复编排的 Core 配套时，主 Agent 通过一次 `send_message` 的有序 `parts` 交付完整的文字与表情顺序，不再使用独立的 `sticker_send`。搜索、预览、收藏和管理员命令保留；旧版/独立接入仍可使用精确 ID 的单独发送工具。

查看图片使用 YesImBot Core 的图片能力：主模型和传输支持图片工具结果时直接看图，否则使用 Core 配置的 `visionModel`。两条路径都不可用或查看失败时，仍能发送库中已有的精确 ID，但不能收藏未实际看过的聊天图片。视觉描述会产生额外调用费用；收藏不再额外调用辅助分类模型，`classificationModel` 保留用于管理员重分类。GIF 预览会采样多帧，发送时保留原始动画。

`enableManage` 默认关闭。管理员显式开启后，模型可以用 `sticker_manage` 移动单张分类、分类改名/合并，以及删除精确单张（包括管理员导入）。不提供整类或批量删除，也不能用模型的确认代替管理员确认。全局库的管理会影响共用频道；删除只移除当前可见范围的记录，其他范围仍引用的文件不会被清理。文件清理失败会返回记录已删除及警告，不会假称没有副作用。

## 管理员常用命令

所有命令都以 `yesimbot.sticker.` 开头。

```text
yesimbot.sticker.list
```

查看当前有哪些分类。

```text
yesimbot.sticker.get 猫猫
```

从“猫猫”分类随机发一张。

```text
yesimbot.sticker.get 猫猫 3
```

发“猫猫”分类里的第 3 张。

```text
yesimbot.sticker.add 猫猫 D:\图片\cat.png
```

手动添加一张图片。

```text
yesimbot.sticker.import D:\表情包文件夹
```

批量导入：这个文件夹里的每个子文件夹会被当成一个分类。

其他管理命令：

```text
yesimbot.sticker.rename 旧分类 新分类
yesimbot.sticker.merge 分类A 分类B
yesimbot.sticker.move 表情包ID 新分类
yesimbot.sticker.delete 分类
yesimbot.sticker.cleanup
```

## 常用设置

一般只需要关心这几项：

- `enableSteal`
  - `true`：默认值。机器人完成同一图片的原生 `read` 或成功非空 `read` / `describe_image` 视觉描述后，可以调用 `sticker_steal`，同时提交必填具体分类（不可为空或“未分类”）。
  - `false`：关闭自动收藏。机器人仍可查询、搜索、发送已导入的表情包，管理员手动 `add` / `import` 等命令不受影响。
- `enableManage`
  - `false`：默认值。不暴露模型管理工具，不影响收藏、查询、发送或管理员命令。
  - `true`：允许模型整理分类、删除精确单张；整类/批量删除仍由管理员确认。
- `scope`
  - `global`：所有频道共用一套表情包，默认值。
  - `channel`：每个频道各有一套表情包。
- `classificationModel`
  - 管理员重新分类使用的模型，与 Agent 收藏的必填分类和实际读图验证独立。
  - 留空时使用机器人的默认聊天模型。
  - 如果默认模型不能看图，可以在这里指定一个支持图片的模型。
  - GIF 表情包分类时只会把第一帧转成 PNG 送给模型，原始 GIF 仍会完整保存和发送。

其他设置保持默认即可。

### 实验性 tag 模式（默认关闭）

`tagMode` 默认关闭，属于实验性功能。开启后：

- `sticker_steal` 收藏时允许主模型提供最多 5 个可选 tags，并包含分类标签（`enableSteal` 关闭时该工具不提供）。重复收藏返回真实已有分类/标签，不会暗中重分类；旧“未分类”记录需要显式管理或管理员分类。
- 新增 `sticker_tags` 工具，用于查询当前标签和数量。
- `sticker_preview` 可传多个 `tags`，从匹配最多标签的表情包中挑选候选供查看；发送时统一回复中的 sticker 单元使用当前可见库的精确 ID（旧版/独立接入使用 `sticker_send`），无需先预览。
- `sticker_search` 支持按 `tags` 过滤。

开启方式：

```yaml
yesimbot-sticker-manager:
  tagMode: true
```

tag 模式只新增 `tags` 字段，不改动现有 `category` 字段；关闭后原有分类功能不受影响。

## 从旧版迁移

如果你之前用过 v3 的 `sticker-manager`，旧数据不会自动导入，需要手动迁移一次。

1. 先保留旧插件、旧数据库和旧表情包文件，不要急着删。
2. 启用新插件。
3. 在机器人频道里执行：

```text
yesimbot.sticker.migrate-v3
```

迁移完成后检查一下分类和数量。

旧版命令名已经改了，例如：

```text
旧: sticker.get 猫猫
新: yesimbot.sticker.get 猫猫
```

迁移不会删除旧数据。

注意：v3 的旧插件包名是 `yesimbot-extension-sticker-manager`，新插件包名是 `yesimbot-sticker-manager`。迁移完成后请从 `koishi.yml` 或 Koishi 控制台停用、移除旧插件条目，否则控制台仍会尝试加载旧插件配置并提示 `config failed to load`。

## 常见问题

### 切换了 `scope` 后表情包不见了

这是正常现象。`global` 和 `channel` 是两套可见范围，切换后旧数据会被隐藏，但不会删除。

需要恢复时执行：

```text
yesimbot.sticker.migrate
```

这条命令可以把隐藏范围的数据复制到当前范围。

### 表情包文件存在哪里

默认在 YesImBot 的：

```text
data/yesimbot/sticker-manager/files
```

不要手动改这个目录里的文件，统一用命令管理。

### 机器人在群里为什么不主动发表情包

先确认库里已有表情包、模型能使用工具，且平台支持发送图片。发送已有表情包不要求 Core 的图片读取能力；预览和聊天图片收藏才需要实际读图能力。机器人会根据语境决定是否使用，不保证固定频率。你可以手动执行 `yesimbot.sticker.get 分类` 测试平台能否发送。
