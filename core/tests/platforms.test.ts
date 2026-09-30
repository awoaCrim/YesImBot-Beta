import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { h, type Session } from "koishi";

import { createMessage, formatInput, isMessageRecord } from "../src/messages/index.js";
import { OneBotTranslator } from "../src/platforms/onebot.js";

function createSession(overrides: Record<string, unknown> = {}): Session {
  return {
    type: "message-created",
    platform: "onebot",
    selfId: "10000",
    channelId: "20000",
    userId: "30000",
    timestamp: 1,
    messageId: "40000",
    isDirect: false,
    event: { type: "message", channel: { type: 0, name: "Room" }, user: { id: "30000", name: "Alice" } },
    elements: [h.text("hello")],
    ...overrides,
  } as Session;
}

describe("OneBotTranslator", () => {
  it("persists live-session images through ChannelResources", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const resources = {
      persistElements: vi.fn(async (_ctx: unknown, elements: readonly { type: string; attrs: Record<string, unknown> }[]) =>
        elements.map((el) => (el.type === "img" ? h("img", { ...el.attrs, id }) : el)),
      ),
    };

    const record = await new OneBotTranslator({ http: vi.fn() } as never).translate(
      createSession({ elements: [h("img", { src: "https://onebot.example/image" })] }),
      resources as never,
    );

    expect(resources.persistElements).toHaveBeenCalledOnce();
    expect(record).toMatchObject({ platform: "onebot", selfId: "10000", messageId: "40000", elements: [h("img", { id })] });
  });

  it("resolves a private OneBot file identifier before resource persistence", async () => {
    const fileUrl = "https://onebot.example/files/script.py";
    const getPrivateFileUrl = vi.fn(async () => fileUrl);
    const resources = {
      persistElements: vi.fn(async (_ctx: unknown, elements: readonly { type: string; attrs: Record<string, unknown> }[]) => elements),
    };

    const record = await new OneBotTranslator({ http: vi.fn() } as never).translate(
      createSession({
        isDirect: true,
        channelId: "private:30000",
        elements: [h("file", { src: "qq-file-id", file: "qq-file-id", name: "script.py" })],
        bot: { internal: { getPrivateFileUrl } },
      }),
      resources as never,
    );

    expect(getPrivateFileUrl).toHaveBeenCalledWith("30000", "qq-file-id", undefined);
    const prepared = resources.persistElements.mock.calls[0]?.[1]?.[0];
    expect(prepared).toMatchObject({ type: "file", attrs: { src: fileUrl, file: "qq-file-id", name: "script.py" } });
    expect(record).toMatchObject({ elements: [{ type: "file", attrs: { src: fileUrl } }] });
  });

  it("resolves a group OneBot file identifier with its busid", async () => {
    const fileUrl = "https://onebot.example/files/script.sh";
    const getGroupFileUrl = vi.fn(async () => fileUrl);
    const resources = {
      persistElements: vi.fn(async (_ctx: unknown, elements: readonly { type: string; attrs: Record<string, unknown> }[]) => elements),
    };

    const record = await new OneBotTranslator({ http: vi.fn() } as never).translate(
      createSession({
        guildId: "90000",
        channelId: "90000",
        elements: [h("file", { src: "qq-group-file-id", file: "qq-group-file-id", name: "script.sh", busid: "7" })],
        bot: { internal: { getGroupFileUrl } },
      }),
      resources as never,
    );

    expect(getGroupFileUrl).toHaveBeenCalledWith("90000", "qq-group-file-id", 7);
    expect(record).toMatchObject({ elements: [{ type: "file", attrs: { src: fileUrl } }] });
  });

  it("normalizes and persists a quoted image from Session.quote", async () => {
    const mainAsset = "11111111111111111111111111111111";
    const quotedAsset = "22222222222222222222222222222222";
    let persistCall = 0;
    const resources = {
      persistElements: vi.fn(async (_ctx: unknown, elements: readonly { type: string; attrs: Record<string, unknown> }[]) => {
        const id = persistCall++ === 0 ? mainAsset : quotedAsset;
        return elements.map((el) => (el.type === "img" ? h("img", { ...el.attrs, id }) : el));
      }),
    };

    const record = await new OneBotTranslator({ http: vi.fn() } as never).translate(
      createSession({
        elements: [h("reply", { id: "quoted-1" }), h.text("如何评价")],
        quote: { id: "quoted-1", user: { id: "10000", isBot: true }, elements: [h("img", { src: "https://onebot.example/quoted-image" })] },
      }),
      resources as never,
    );

    expect(resources.persistElements).toHaveBeenCalledTimes(2);
    expect(record).toMatchObject({
      messageId: "40000",
      quote: { messageId: "quoted-1", elements: [h("img", { id: quotedAsset })], author: { id: "10000", isBot: true } },
    });
    if (!record || !isMessageRecord(record)) throw new Error("Expected a message record");
    const content = String(formatInput(createMessage(record)).content);
    expect(content).toContain('sender="Alice (30000)"');
    expect(content).toContain('[QUOTED_MESSAGE id="quoted-1" sender="10000"]');
    expect(content).toContain(`[图片：asset://${quotedAsset}]`);
    expect(content).not.toContain("<reply");
    expect(content).toContain("[/QUOTED_MESSAGE]\n如何评价");
  });

  it("uses quoted content when Session.quote has no elements", async () => {
    const resources = {
      persistElements: vi.fn(async (_ctx: unknown, elements: readonly { type: string; attrs: Record<string, unknown> }[]) => elements),
    };

    const record = await new OneBotTranslator({ http: vi.fn() } as never).translate(
      createSession({ quote: { messageId: "quoted-2", content: "quoted text" } }),
      resources as never,
    );

    expect(record).toMatchObject({ quote: { messageId: "quoted-2", elements: [h.text("quoted text")] } });
    expect(resources.persistElements).toHaveBeenCalledTimes(2);
  });

  it("omits incomplete quote metadata without affecting ordinary message persistence", async () => {
    const resources = {
      persistElements: vi.fn(async (_ctx: unknown, elements: readonly { type: string; attrs: Record<string, unknown> }[]) => elements),
    };

    const record = await new OneBotTranslator({ http: vi.fn() } as never).translate(createSession({ quote: { id: "quoted-incomplete" } }), resources as never);

    expect(record).toMatchObject({ messageId: "40000", elements: [h.text("hello")] });
    expect(record).not.toHaveProperty("quote");
    expect(resources.persistElements).toHaveBeenCalledOnce();
  });

  it("maps a poke notice to its frozen event record", async () => {
    const record = await new OneBotTranslator({ http: vi.fn() } as never).translate(
      createSession({
        type: "notice",
        messageId: undefined,
        elements: undefined,
        event: { type: "notice", subtype: "poke", channel: { type: 0 }, _data: { user_id: 30000, target_id: 10000 } },
      }),
      { assets: { put: vi.fn() } } as never,
    );

    expect(record).toMatchObject({ eventType: "notice.poke", actorId: "30000", targetId: "10000", action: "拍了拍" });
    expect(record).not.toHaveProperty("_data");
  });

  it("rejects poke notices without a typed target identity", async () => {
    const record = await new OneBotTranslator({ http: vi.fn() } as never).translate(
      createSession({
        type: "notice",
        messageId: undefined,
        elements: undefined,
        event: { type: "notice", subtype: "poke", channel: { type: 0 }, _data: { user_id: 30000 } },
      }),
      { assets: { put: vi.fn() } } as never,
    );

    expect(record).toBeNull();
  });
});
