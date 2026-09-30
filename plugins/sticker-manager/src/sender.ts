import { h, type Bot, type Element } from "koishi";
import type { ChannelContext } from "koishi-plugin-yesimbot";

const ANIMATED_STICKER_FILENAME = "sticker.gif";
const ANIMATED_STICKER_SUMMARY = "[动画表情]";

export interface StickerSendInput {
  bytes: Uint8Array;
  mediaType: string;
}

export interface StickerSender {
  send(input: StickerSendInput): Promise<void>;
}

export class BotStickerSender implements StickerSender {
  public constructor(
    private readonly bot: Bot,
    private readonly scope: ChannelContext,
  ) {}

  public async send(input: StickerSendInput): Promise<void> {
    await this.bot.sendMessage(this.scope.channelId, [createStickerImageElement(input.bytes, input.mediaType)]);
  }
}

export function createStickerImageElement(bytes: Uint8Array, mediaType: string): Element {
  const dataUrl = `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
  if (mediaType.toLowerCase().split(";", 1)[0] !== "image/gif") return h.image(dataUrl);

  const element = h.image(dataUrl, {
    name: ANIMATED_STICKER_FILENAME,
    summary: ANIMATED_STICKER_SUMMARY,
  });
  // Satori camelizes attrs, but OneBot/NapCat reads the standard snake_case field.
  element.attrs.sub_type = 1;
  return element;
}
