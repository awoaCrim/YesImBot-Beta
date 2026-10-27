import { Adapter, Bot, Context, h, Schema, Universal } from "@satorijs/core";

import { PrivateTextClient, type ClientConfig } from "./client";
import { isText } from "./protocol";

export const name = "adapter-wechat-local";

export const inject = ["http", "satori"];

export const Config: Schema<Config> = Schema.object({
  endpoint: Schema.string().required().description("仅允许本机私聊桥的 ws://127.0.0.1 端点。"),
  token: Schema.string().role("secret").required(),
  expectedSelfId: Schema.string().required().description("已绑定的当前账号原生 wxid。"),
  peerId: Schema.string().required().description("唯一获准私聊联系人的原生 wxid。"),
  requestTimeoutMs: Schema.number().min(100).max(30000).step(1).default(5000),
});

export type Config = ClientConfig;

export class WechatLocalBot extends Bot<Context, Config> {
  client!: PrivateTextClient;

  constructor(ctx: Context, config: Config) {
    super(ctx, config, "wechat-local");
    this.selfId = config.expectedSelfId;
    this.user = { id: this.selfId };
    ctx.plugin(WechatLocalAdapter, this);
  }

  private checkTarget(target: string, guildId?: string) {
    if (target !== this.config.peerId || guildId) throw new Error("scope_denied");
  }

  async sendMessage(channelId: string, content: h.Fragment): Promise<string[]> {
    this.checkTarget(channelId);
    return this.client.sendText(plainText(content));
  }

  async createMessage(channelId: string, content: h.Fragment) {
    await this.sendMessage(channelId, content);
    return [];
  }

  async sendPrivateMessage(userId: string, content: h.Fragment, guildId?: string): Promise<string[]> {
    this.checkTarget(userId, guildId);
    return this.sendMessage(userId, content);
  }

  async createDirectChannel(userId: string, guildId?: string) {
    this.checkTarget(userId, guildId);
    return { id: userId, type: Universal.Channel.Type.DIRECT };
  }
}

export class WechatLocalAdapter extends Adapter<Context, WechatLocalBot> {
  constructor(ctx: Context, bot: WechatLocalBot) {
    super(ctx);
    this.fork(ctx, bot);
    bot.client = new PrivateTextClient(
      bot.config,
      (endpoint, token) => ctx.http.ws(endpoint, { headers: { authorization: "Bearer " + token } }),
      (message, binding) => {
        const session = bot.session({
          type: "message-created",
          timestamp: message.ts,
          user: { id: message.sender, name: binding.peerName },
          channel: { id: binding.peerId, type: Universal.Channel.Type.DIRECT },
          message: { id: message.id, elements: [h.text(message.text)] },
        });
        bot.dispatch(session);
      },
      () => bot.online(),
      () => bot.offline(),
    );
  }

  async connect(bot: WechatLocalBot) {
    await bot.client.connect();
  }
  async disconnect(bot: WechatLocalBot) {
    bot.client.disconnect();
  }
}

export function plainText(content: h.Fragment): string {
  const elements = h.normalize(content);
  if (elements.some((element) => element.type !== "text")) throw new Error("text_only");
  const text = elements.map((element) => element.attrs.content as string).join("");
  if (!isText(text)) throw new Error("invalid_text");
  return text;
}

export function apply(ctx: Context, config: Config) {
  return new WechatLocalBot(ctx, config);
}
