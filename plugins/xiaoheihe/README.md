# koishi-plugin-yesimbot-xiaoheihe

小黑盒平台适配器，注册独立的 `xiaoheihe` Bot，底层复用 `xiaoheihe-cli` MCP。依赖 YesImBot Core 和角色插件，不另起一个绕过 Core 的写作模型。

## 行为

- 定时浏览配置的社区热帖 feed；逐社区读取，轮流合并并按帖子 ID 去重，总条数不超过 `feedLimit`。`browseCommunities` 为空时仍读取原首页，绝不用普通关键词搜索冒充社区 feed。
- `browseTopics` 仅提供兴趣提示和搜索候选，不会自动连续搜索全部话题。Agent 可继续搜索、读帖、选择进入帖子会话，或保持沉默。
- 两项发布额度均为 `0` 时进入只读模式：发帖、评论和回复全部关闭，`send_message` 在工具入口被阻断，直接发送接口也拒绝发布；浏览、搜索、读帖及只读帖子会话继续运行。
- 账号会话 `account:<selfId>` 用于浏览和创建新帖；帖子会话 `post:<selfId>:<postId>` 用于评论及回复。会话标识包含账号，和 QQ 历史隔离。
- 浏览事件、帖子事件都通过 `Messenger.post()` 进入正常 `ChannelRuntime`，保留独立会话历史。每次模型请求（包括工具续轮）都会经过 Core 原有的完整六步角色决策流程；该流程不写入历史、不对外发送。
- 非只读模式下，Agent 只能通过 `send_message` 发布：一个完整文字单元。新帖首行为标题，剩余文字为正文；评论可使用前置 `<quote id="真实评论ID"/>` 回复指定评论。
- 不公开原始 MCP 写工具，不开放登录、删改内容、游戏评测、私信、图片或视频发布；不开放 QQ、浏览器、工作区等其他平台工具。全局脑和跨频道聊天风格学习不会向小黑盒注入私聊摘要、聊天示例或立即广播。
- 跟进自己的近期帖子以及主动访问、评论过的帖子。首次发现的历史评论仅建立基线，不批量补回；之后的新评论由模型判断是否回应。

## 配置

前置条件：来宾中的 `xiaoheihe-cli` 必须安装其 `mcp` extra（包含 `mcp>=1.20,<2`）；只有 CLI 或能显示 `mcp --help` 不代表 MCP 服务可运行。缺少该依赖时连接会失败，不会降级为浏览器点击发布。部署时应只补齐缺失依赖，保留现有 CLI 版本、已安装依赖和会话文件，不复制或输出 Cookie。

```yaml
yesimbot-xiaoheihe:
  selfId: "填写现有小黑盒账号的 userid"
  dailyPostLimit: 0
  dailyInteractionLimit: 0
  pollIntervalMinutes: 30
  feedLimit: 10
  maxWatchedPosts: 50
  communities: []
  browseCommunities: [AI, 盒友杂谈]
  browseTopics: [deepseek大肥鱼, deepseek, ai人工智能, 千早爱音, "mygo!!!", chatgpt]
  mcp:
    type: stdio
    command: /usr/bin/ssh
    args:
      - "-T"
      - "-o"
      - BatchMode=yes
      - "-o"
      - StrictHostKeyChecking=yes
      - "-o"
      - UserKnownHostsFile=/run/yesimbot/anon-vm/anon_known_hosts
      - "-o"
      - ConnectTimeout=10
      - "-i"
      - /run/yesimbot/anon-vm/anon_ed25519
      - "-p"
      - "10022"
      - anon@172.20.0.1
      - /path/to/existing-cli-venv/bin/python
      - /home/anon/.local/share/yesimbot/community-mcp.py
      - "--transport"
      - stdio
```

这个示例对应 ssh1 上 Koishi 到 Anon 来宾的现有 SSH 通道。将构建产物 `dist/community-mcp.py` 部署到来宾示例路径，并将 `/path/to/existing-cli-venv/bin/python` 替换为原有 CLI 安装环境中的 Python，沿用原用户、HOME 与 `XHH_OPERATOR_HOME`（若已设置）；不要升级或重装 CLI，也不要迁移、覆盖登录态。只复用已经挂载的密钥和 known_hosts；不要复制私钥、Cookie 或会话文件进仓库，不要关闭主机身份校验。

包装复用已安装的 `xhh_operator.mcp_server.create_server()`，只新增只读工具 `get_community_content({community, limit})`，自身仅接受 stdio，不支持 HTTP/SSE 或监听端口。它用 `SessionStore` 读取原登录态，`resolve_selections` 按精确社区名唯一解析 topic ID，再通过 `HeyboxAPI` GET `/bbs/app/topic/feeds`，参数为 `topic_id`、`offset=0`、`limit`、`lastval`、`dw=720`；仅保留所属社区包含目标 ID 的帖子。输出经过原有 `safe_result` 过滤，失败只返回固定错误码，不输出凭据或原始异常；不允许失败后降级成首页或关键词搜索。

仅 `browseCommunities` 非空时要求 MCP 提供新工具；空数组可以继续用原 CLI `xiaoheihe mcp --transport stdio`。适配器原有 `http`/`sse` 连接配置不变，但不能用于该 stdio 包装，不得将无认证的 MCP 端口开放到公网。

首次启用前将两项发布额度设为 `0`，核对账号、精确社区名和新只读工具后，才解除原有暂停状态以开始只读浏览；若暂停原因是 `uncertain_delivery`，仍需先人工核验，不能直接恢复。未暂停的插件启用并成功连接后即开始自主活动；只读不等于暂停，安装代码本身也不表示已经部署。不要同时运行旧巡帖脚本，或把同一个小黑盒 MCP 的原始写工具另外开放给 Agent，以免绕过只读保护、统一计数和去重。

| 配置                    | 默认值 | 含义                                                             |
| ----------------------- | ------ | ---------------------------------------------------------------- |
| `dailyPostLimit`        | `1`    | 每日最多创建的新帖；`0` 禁止发帖                                 |
| `dailyInteractionLimit` | `10`   | 每日评论和回复的合计上限；`0` 禁止互动                           |
| `pollIntervalMinutes`   | `30`   | 每轮活动间隔，最小 15 分钟；不追赶停机期间的轮次                 |
| `feedLimit`             | `10`   | 首页或合并社区 feed 的总条数、搜索条数，以及每轮帖子会话触发上限 |
| `maxWatchedPosts`       | `50`   | 持续跟进的帖子数量上限；替换最久未访问者                         |
| `communities`           | `[]`   | 仅指定新帖所属社区，不影响浏览；空数组沿用上游动态区默认值       |
| `browseCommunities`     | `[]`   | 只读浏览的精确社区名称；空数组仍读首页；推荐 `AI`、`盒友杂谈`    |
| `browseTopics`          | `[]`   | 兴趣提示和搜索候选；不自动逐项搜索，不影响新帖社区               |

限额是上限，不是每日必须完成的指标。按 `Asia/Shanghai` 自然日计算，两项独立；修改配置使用 Koishi 的正常插件重载，不清空当日计数。两项均为 `0` 时 `readOnly=true`，所有发布被阻断，但仍可浏览。上表示原有配置默认值；本节部署示例显式使用两项 `0` 的只读配置。

## 暂停、恢复和记录

管理员权限要求为 `authority: 4`；将命令中的 `<selfId>` 替换为配置的账号 ID：

```text
yesimbot.xiaoheihe.<selfId>.status
yesimbot.xiaoheihe.<selfId>.pause
yesimbot.xiaoheihe.<selfId>.resume
```

状态保留原有账号、暂停原因、剩余额度、跟进数量与最近 20 次发布尝试的时间、目标、状态和真实平台 ID，另提供 `readOnly`、`lastBrowseAt` 和 `activities`，供统一活动记录页读取同一状态。普通上游错误、登录失效或账号不匹配会暂停自动活动；人工排查后才恢复，不自动登录或切换账号。

`state.json.activities` 保留最近 300 条连接、暂停/恢复、浏览完成（真实来源及返回数）、搜索、读帖、访问、发送结果/失败及只读阻断记录；旧状态缺少该字段时按 `[]` 读取。每条仅允许 `id`、`at`、`kind`、`outcome`（`ok`/`failed`/`blocked`），以及可选的 `postId`、`title`、`source`、`count`、`errorCode`；字符串分别有界（ID/帖子 ID/错误码 80、kind 48、标题/来源 200 字符）。不保存正文、Cookie、MCP 原始参数、凭据或原始异常，搜索只记录来源类型和结果数，不记录原始关键词。记录复用 store 的串行原子写入并跨重启保留。`actions` 仍是发布和计费的唯一账本，活动记录不占额度、不退额度、不改变去重或不确定发送保护。

发布前先持久化占用额度，账号内串行提交；必须同时取得 `accepted=true`、`verified=true` 和合法平台 ID 才返回成功。超时、缺少 ID、未完成读回验证都视为结果不确定，保留已占用的额度并停止活动，绝不自动重发。人工在平台检查后可显式执行：

```text
yesimbot.xiaoheihe.<selfId>.resume --ack-uncertain
```

恢复不删除原记录、不退额度、不重放原操作。重复正文或相同评论目标会被去重。去重保留当天操作及最近 2000 条历史操作，不是无限期的全账号历史索引。

状态保存在 `<baseDir>/data/yesimbot/xiaoheihe/<selfId>/state.json`，目录/文件使用 owner-only 权限；普通重启后保留限额、跟进进度、暂停状态和发布记录。独占 `owner.lock` 防止同一数据目录被两个实例并发使用；异常进程退出留下锁时，必须先确认原实例已停止，再人工移开陈旧锁，不能自动删除未知锁持有者。恢复时发现未完成的发布预约会暂停等待核验。不要让多个 Koishi 实例从不同数据目录运营同一账号。

## 当前 MCP 限制

已核对的服务版本是 `xiaoheihe-cli 0.1.0`：

- `get_post_detail` 只暴露一页可见评论，没有通知流或完整分页参数。因此只能跟进 MCP 返回的评论，不能保证发现平台上的每一条新回复；模型收到 `commentsComplete` 覆盖标记，不应声称已读完整讨论。
- `reply_comment` 按原文而非 ID 定位目标。适配器先检查已经读过的评论 ID、作者及原文，再重新读帖复核；上游还会拒绝正文重复的歧义目标。不能定位时不猜、不发。
- 真实发帖、评论会影响公开账号；只读部署必须保持两项发布额度为 `0`，不在公开平台发测试帖。真实送达只能以平台内容及读回结果为准。
- 社区 feed 包装需在原 CLI 环境核对精确社区解析、endpoint 参数、返回格式及账号状态；失败保持暂停，不自动换首页或搜索来源。

构建命令为 `yarn workspace koishi-plugin-yesimbot-xiaoheihe build`；构建在 `pkgroll` 后用 Node `copyFileSync` 将静态 `src/community-mcp.py` 复制为 `dist/community-mcp.py`，随插件的 `dist` 一起进入 Release payload。部署方需将该文件放到运行原 CLI 的主机，不能直接在缺少 CLI 的 Koishi 主机解释执行。
