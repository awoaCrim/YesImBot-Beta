import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));
import { h } from "koishi";

import { createMessage, formatCurrentInput, formatCurrentInputWithImages, formatInput, formatInputWithImages, isMessageRecord } from "../src/messages/index.js";
import { OneBotTranslator } from "../src/platforms/onebot.js";
import { ChannelResources } from "../src/resources/index.js";
import { VIDEO_BYTES } from "./helpers/video.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("QQ native video source and formatting", () => {
  it.each([false, true])("persists group/private=%s current and quoted videos through the actual resource owner", async (isDirect) => {
    const root = await mkdtemp(join(tmpdir(), "video-input-"));
    roots.push(root);
    const resources = new ChannelResources(root, true, 1000, true);
    const http = vi.fn(async () => ({
      status: 200,
      headers: new Headers({ "content-type": "video/mp4" }),
      data: new ReadableStream({
        start(c) {
          c.enqueue(VIDEO_BYTES);
          c.close();
        },
      }),
    }));
    const ctx = { http, logger: () => ({ debug: vi.fn(), warn: vi.fn() }) };
    const element = () => h("video", { src: "https://private.example/clip?token=secret", file: "private-file", fileSize: VIDEO_BYTES.length });
    const record = await new OneBotTranslator(ctx as never).translate(
      {
        type: "message-created",
        platform: "onebot",
        selfId: "10000",
        channelId: isDirect ? "private:30000" : "20000",
        userId: "30000",
        timestamp: 1,
        messageId: "40000",
        isDirect,
        event: { type: "message", channel: { type: 0, name: "Room" }, user: { id: "30000", name: "Alice" } },
        elements: [h("reply", { id: "quoted" }), h("message", {}, [element()])],
        quote: { id: "quoted", user: { id: "10000", isBot: true }, elements: [element()] },
      } as never,
      resources,
    );
    if (!record || !isMessageRecord(record)) throw new Error("Missing message record");
    expect(record.elements[1]!.children[0]!.attrs.id).toMatch(/^[a-f0-9]{32}$/);
    const id = record.elements[1]!.children[0]!.attrs.id;
    expect(record.quote!.elements[0]!.attrs.id).toBe(id);
    expect(JSON.stringify(record)).not.toMatch(/private.example|secret|private-file|token=/);
    expect(http).toHaveBeenCalledTimes(2);
    const message = createMessage(record);
    const resolver = vi.fn();
    const formatted = [
      formatInput(message),
      formatCurrentInput(message),
      await formatInputWithImages(message, resolver),
      await formatCurrentInputWithImages(message, resolver),
    ];
    for (const output of formatted) {
      const content = JSON.stringify(output.content);
      expect(content.split("asset://" + id)).toHaveLength(3);
      expect(content).toContain("QUOTED_MESSAGE");
      expect(content).toContain("quoted");
      expect(content).not.toContain("<video");
      expect(content).not.toMatch(/private.example|secret|token=|file-data|data:video/);
    }
    expect(JSON.stringify(formatted[1])).toContain("CURRENT_MESSAGE");
    expect(JSON.stringify(formatted[3])).toContain("CURRENT_MESSAGE");
    expect(resolver).not.toHaveBeenCalled(); // video stays on-demand, even with imageInput enabled.
  });

  it("renders bounded video failures consistently in ordinary and image-enabled paths", async () => {
    const message = createMessage({
      platform: "onebot",
      selfId: "bot",
      channel: { id: "room", type: 0 },
      user: { id: "user" },
      messageId: "message",
      timestamp: 1,
      elements: [h("video", { yesimbotFailure: "timeout" })],
    });
    const normal = formatInput(message);
    const withImages = await formatInputWithImages(message, vi.fn());
    expect(withImages).toEqual(normal);
    expect(String(normal.content)).not.toContain("<video");
    expect(String(normal.content)).toContain("视频");
    expect(String(normal.content)).not.toContain("asset://");
  });
});
