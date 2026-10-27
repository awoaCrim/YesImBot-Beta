import { join } from "node:path";

import { Adapter, Bot, h, Schema, Universal } from "@satorijs/core";
import type { Context as KoishiContext } from "koishi";

import { Account } from "./account.js";
import { connectXiaoheihe } from "./client.js";
import { identifier } from "./protocol.js";
import { AccountStore } from "./store.js";
import { createAccountPlugin } from "./tools.js";
import type { Config as AdapterConfig } from "./types.js";

export const name = "adapter-xiaoheihe";

export const inject = ["yesimbot", "satori"];

export const Config: Schema<Config> = Schema.object({
  selfId: Schema.string().required().description("绑定的小黑盒账号 userid；登录账号不匹配时拒绝活动"),
  mcp: Schema.intersect([
    Schema.object({ type: Schema.union(["stdio", "http", "sse"]).default("stdio") }),
    Schema.union([
      Schema.object({
        type: Schema.const("stdio").required(),
        command: Schema.string().required(),
        args: Schema.array(Schema.string()).default([]),
        env: Schema.union([Schema.dict(Schema.string()), Schema.string()])
          .role("secret")
          .default({}),
      }),
      Schema.object({ type: Schema.const("http").required(), url: Schema.string().required(), bearerTokenFile: Schema.string() }),
      Schema.object({ type: Schema.const("sse").required(), url: Schema.string().required(), bearerTokenFile: Schema.string() }),
    ]),
  ]).description("独立的小黑盒 MCP 连接；不会开放该服务的登录、删除或评测写入工具"),
  dailyPostLimit: Schema.number().min(0).max(1000).step(1).default(1).description("每日发帖上限，0 禁止发帖；Asia/Shanghai 自然日重置"),
  dailyInteractionLimit: Schema.number().min(0).max(1000).step(1).default(10).description("每日评论和回复合计上限，0 禁止互动；结果不确定的尝试也占额度"),
  pollIntervalMinutes: Schema.number().min(15).max(1440).step(1).default(30).description("浏览和跟进间隔（分钟）；不补跑停机期间的任务"),
  feedLimit: Schema.number().min(1).max(20).step(1).default(10).description("每轮首页或社区 feed 合计条数、搜索条数和进入帖子会话的数量上限"),
  maxWatchedPosts: Schema.number().min(1).max(100).step(1).default(50).description("最多跟进的帖子数，超出后替换最久未访问的帖子"),
  communities: Schema.array(Schema.string()).default([]).description("发帖社区；空数组使用上游的小黑盒动态区默认值"),
  browseCommunities: Schema.array(Schema.string().min(1).max(100))
    .default([])
    .description("只读浏览的精确社区名称；逐社区取热帖并公平合并去重，空数组浏览原首页；需要 get_community_content MCP 工具"),
  browseTopics: Schema.array(Schema.string().min(1).max(200)).default([]).description("浏览兴趣与搜索候选话题，不会逐项自动搜索；不影响发帖社区"),
});

export type Config = AdapterConfig;

type AdapterContext = Bot["ctx"];

export class XiaoheiheBot extends Bot<AdapterContext, Config> {
  account?: Account;
  disposeTools?: () => void;
  constructor(ctx: AdapterContext, config: Config) {
    identifier(config.selfId);
    super(ctx, config, "xiaoheihe");
    this.selfId = config.selfId;
    this.user = { id: this.selfId };
    ctx.plugin(XiaoheiheAdapter, this);
  }
  async sendMessage(channelId: string, content: h.Fragment): Promise<string[]> {
    if (!this.account) throw new Error("xiaoheihe_not_connected");
    const publication = publicationText(content);
    return this.account.send(channelId, publication.text, publication.quoteId);
  }
  async createMessage(channelId: string, content: h.Fragment) {
    const ids = await this.sendMessage(channelId, content);
    return ids.map((id) => ({ id, content: h.normalize(content).join(""), channel: { id: channelId, type: Universal.Channel.Type.TEXT } }));
  }
  async sendPrivateMessage(): Promise<string[]> {
    throw new Error("xiaoheihe_private_messages_unsupported");
  }
}

export class XiaoheiheAdapter extends Adapter<AdapterContext, XiaoheiheBot> {
  constructor(ctx: AdapterContext, bot: XiaoheiheBot) {
    super(ctx);
    this.fork(ctx, bot);
  }
  async connect(bot: XiaoheiheBot): Promise<void> {
    const app = this.ctx as unknown as KoishiContext;
    let store: AccountStore | undefined;
    let api: Awaited<ReturnType<typeof connectXiaoheihe>> | undefined;
    try {
      store = await AccountStore.open(join(app.baseDir, "data", "yesimbot", "xiaoheihe", bot.selfId), bot.selfId);
      api = await connectXiaoheihe(app, bot.config.mcp, bot.config.browseCommunities);
      const account = new Account(bot.config, api, store, (event) =>
        app.yesimbot.messenger.post(event, { trigger: true, ifBusy: "defer", delivery: "channel", historyMode: "conversation" }),
      );
      bot.account = account;
      await account.checkIdentity();
      bot.disposeTools = app.yesimbot.agent.use({
        setup: (scope, currentBot) =>
          currentBot.platform === "xiaoheihe" && currentBot.selfId === bot.selfId ? createAccountPlugin(account, { ...scope, selfId: bot.selfId }) : null,
      });
      await account.recordActivity({ kind: "connect", outcome: "ok" });
      bot.online();
      app.logger("xiaoheihe").info("xiaoheihe.connected paused=%s", account.store.snapshot().paused !== null);
      account.start();
    } catch {
      await store?.recordActivity({ kind: "connect", outcome: "failed", errorCode: "connection_failed" }).catch(() => {});
      bot.disposeTools?.();
      bot.disposeTools = undefined;
      if (bot.account) await bot.account.stop();
      else {
        await api?.close();
        await store?.close();
      }
      bot.account = undefined;
      bot.offline();
      throw new Error("xiaoheihe_connection_failed");
    }
  }
  async disconnect(bot: XiaoheiheBot): Promise<void> {
    bot.disposeTools?.();
    bot.disposeTools = undefined;
    await bot.account?.stop();
    bot.account = undefined;
    bot.offline();
  }
}

export function publicationText(content: h.Fragment): { text: string; quoteId?: string } {
  const elements = h.normalize(content);
  let text = "";
  let quoteId: string | undefined;
  for (const element of elements) {
    if (element.type === "text") text += element.attrs.content;
    else if (element.type === "quote" && quoteId === undefined && !text.trim()) quoteId = identifier(element.attrs.id);
    else throw new Error("xiaoheihe_text_only");
  }
  if (!text.trim()) throw new Error("empty_publication");
  return { text, ...(quoteId ? { quoteId } : {}) };
}

export function apply(ctx: AdapterContext, config: Config): XiaoheiheBot {
  const app = ctx as unknown as KoishiContext;
  const bot = new XiaoheiheBot(ctx, config);
  const root = `yesimbot.xiaoheihe.${bot.selfId}`;
  const run = async (operation: (account: Account) => Promise<string> | string) => {
    if (!bot.account) return "小黑盒账号未连接";
    try {
      return await operation(bot.account);
    } catch {
      return "操作失败；请检查账号状态，勿重复发布";
    }
  };
  app.command(`${root}.status`, "查看小黑盒状态与最近活动", { authority: 4 }).action(() => run((account) => JSON.stringify(account.status(), null, 2)));
  app.command(`${root}.pause`, "暂停小黑盒自主活动", { authority: 4 }).action(() =>
    run(async (account) => {
      await account.pause();
      return "已暂停小黑盒活动";
    }),
  );
  app
    .command(`${root}.resume`, "恢复小黑盒自主活动", { authority: 4 })
    .option("ackUncertain", "--ack-uncertain 已人工检查结果不确定的发布")
    .action(({ options }) =>
      run(async (account) => {
        await account.resume(options?.ackUncertain === true);
        return "已恢复；将在下一次轮询继续，原有发布记录与额度不会清除";
      }),
    );
  return bot;
}
