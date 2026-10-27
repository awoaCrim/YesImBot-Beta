import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { Context } from "@koishijs/core";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { h } from "koishi";

import { Channel } from "../../../core/src/channels/index.js";
import { ChannelResources } from "../../../core/src/resources/index.js";
import { ChannelRuntime } from "../../../core/src/runtimes/channel.js";
import { defaultConfig, defaultMessageRecord } from "../../../core/tests/helpers/index.js";
import { createHtmlRenderTool } from "../src/html-render.js";

const roots: string[] = [];
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXYsAAAAASUVORK5CYII=", "base64"));

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("delivers the renderer artifact through the active Core parts protocol as an image, not text", async () => {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-html-delivery-"));
  roots.push(root);
  const scope = { type: "guild" as const, platform: "onebot", selfId: "bot", channelId: "730867358", guildId: "730867358" };
  const channel = new Channel(scope, root);
  await channel.conversation.init();
  const resources = channel.resources;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(PNG, { headers: { "Content-Type": "image/png" } })),
  );
  const rendered = await createHtmlRenderTool("http://renderer.internal/render", resources).execute(
    { html: '<!doctype html><meta charset="utf-8"><h1>AI 每日早报</h1>' },
    { toolCallId: "render", turnId: "turn" } as never,
  );
  if (!rendered?.ok) throw new Error("HTML rendering failed");
  expect(Buffer.from((await resources.openStrict(rendered.uri)).bytes)).toEqual(Buffer.from(PNG));
  const sendMessage = vi.fn(async () => ["image-message-1"]);
  let requests = 0;
  const model = {
    specificationVersion: "v3" as const,
    provider: "synthetic",
    modelId: "offline",
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(async (options: LanguageModelV3CallOptions) => {
      if (++requests > 1) throw new Error("unexpected_model_retry");
      expect(options.tools?.find((tool) => tool.type === "function" && tool.name === "send_message")).toMatchObject({ inputSchema: { required: ["parts"] } });
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "send",
              toolName: "send_message",
              input: JSON.stringify({ parts: [{ kind: "text", text: rendered.sendMessageMarkup }] }),
            });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 0, reasoning: 0 } },
            });
            controller.close();
          },
        }),
      };
    }),
  };
  const runtime = new ChannelRuntime(new Context() as never, {
    channel,
    bot: { selfId: "bot", platform: "onebot", sendMessage } as never,
    will: { decide: async () => "trigger", observe: () => {} },
    model: model as never,
    readImagePolicy: { mode: "native" },
    roleProfile: { characterDefinition: "SYNTHETIC_REPORT_ROLE", roleInstructions: "SYNTHETIC_REPORT_RULE" },
    config: defaultConfig({ basePath: root, modelRetries: 0, logLevel: 0, pacing: { charactersPerSecond: 10_000, maxTotalDelayMs: 0 } }),
    plugins: [],
  });
  try {
    await runtime.init();
    const result = await runtime.post(
      defaultMessageRecord({
        platform: "onebot",
        selfId: "bot",
        channel: { id: "730867358", type: 0 },
        guild: { id: "730867358" },
        elements: [h.text("SYNTHETIC_IMAGE_DELIVERY_REQUEST")],
      }),
      { trigger: true, delivery: "channel", historyMode: "conversation" },
    );
    if (result.kind === "run") await result.done;
    await runtime.wait();
    expect(requests).toBe(1);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("730867358", [h.image(PNG, "image/png")]);
    expect(JSON.stringify(await channel.conversation.storage.read())).toContain("image-message-1");
  } finally {
    await runtime.stop();
  }
  const otherRoot = await mkdtemp(join(tmpdir(), "yesimbot-html-other-channel-"));
  roots.push(otherRoot);
  await expect(new ChannelResources(otherRoot).openStrict(rendered.uri)).rejects.toThrow("resource_not_found");
});
