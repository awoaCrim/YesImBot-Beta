import type { Bot, Element } from "koishi";
import type { ChannelContext } from "koishi-plugin-yesimbot";
import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { BotStickerSender, createStickerImageElement } from "../src/sender.js";

const scope: ChannelContext = { type: "guild", platform: "onebot", channelId: "room", guildId: "room" };
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageFrom(sendMessage: ReturnType<typeof vi.fn>): Element {
  const elements = sendMessage.mock.calls[0]?.[1] as Element[] | undefined;
  const image = elements?.[0];
  if (!image) throw new Error("missing sent image");
  return image;
}

describe("BotStickerSender", () => {
  it("keeps GIF metadata required by OneBot/NapCat for animated stickers", async () => {
    const sendMessage = vi.fn(async () => ["message-1"]);
    const sender = new BotStickerSender({ sendMessage } as unknown as Bot, scope);

    await sender.send({ bytes: GIF_BYTES, mediaType: "image/gif" });

    const image = imageFrom(sendMessage);
    expect(image.type).toBe("img");
    expect(image.attrs).toMatchObject({
      src: `data:image/gif;base64,${Buffer.from(GIF_BYTES).toString("base64")}`,
      name: "sticker.gif",
      summary: "[动画表情]",
      sub_type: 1,
    });
  });

  it("does not mark ordinary images as animated", () => {
    const image = createStickerImageElement(PNG_BYTES, "image/png");

    expect(image.attrs).toEqual({ src: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}` });
  });
});
