import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { Context, h } from "@koishijs/core";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { MessageDebounceController } from "../../plugins/message-debounce/src/index.js";
import { defaultWillEngine } from "../src/agents/will.js";
import { Channel } from "../src/channels/index.js";
import { createMessage, type Event, type MessageRecord } from "../src/messages/index.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import { defaultConfig, defaultMessageRecord } from "./helpers/index.js";

const roots: string[] = [];
const runtimes: ChannelRuntime[] = [];
const state = { activeTurnId: null };
const poke: Event = {
  id: "poke",
  role: "custom",
  type: "yesimbot.event",
  timestamp: 1,
  data: { eventType: "notice.poke", platform: "test", selfId: "bot-1", channel: { id: "room", type: 0 }, actorId: "user", targetId: "bot-1", text: "poke" },
};

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
  vi.useRealTimers();
});

function message(id: string, patch: Partial<MessageRecord> = {}) {
  return createMessage(defaultMessageRecord({ messageId: id, elements: [h.text(id)], ...patch }));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-default-will-"));
  roots.push(root);
  const channel = new Channel({ type: "guild", platform: "test", channelId: "room", guildId: "room", selfId: "bot-1" }, root);
  await channel.conversation.init();
  const requests: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      requests.push(request);
      return {
        stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: `finish-${requests.length}`, toolName: "finish", input: "{}" },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      };
    },
  });
  const context = new Context();
  const batches: Promise<void>[] = [];
  const runtime = new ChannelRuntime(context, {
    channel,
    bot: { selfId: "bot-1", platform: "test", sendMessage: vi.fn(async () => ["unexpected-send"]) } as never,
    will: defaultWillEngine,
    model,
    plugins: [],
    readImagePolicy: { mode: "unavailable" },
    config: defaultConfig({ basePath: root, modelRetries: 0 }),
    messageBatch: {
      priority: 0,
      match: () => true,
      setup: (_scope, flush, extensions) =>
        new MessageDebounceController(
          context,
          15_000,
          flush,
          extensions &&
            ((inputs) => {
              const batch = extensions.flushInputs(inputs);
              batches.push(batch);
              return batch;
            }),
          context.logger("test.debounce"),
          () => undefined,
        ),
    },
  });
  runtimes.push(runtime);
  await runtime.init();
  return {
    runtime,
    requests,
    drain: async () => {
      await Promise.all(batches.splice(0));
      await runtime.wait();
    },
  };
}

describe("retained Core default triggers", () => {
  it("triggers direct messages and explicit current-bot mentions", () => {
    expect(defaultWillEngine.decide(message("direct", { channel: { id: "private", type: 1 } }), state)).toBe("trigger");
    expect(defaultWillEngine.decide(message("mention", { elements: [h.at("bot-1")] }), state)).toBe("trigger");
  });

  it.each([
    ["ordinary", {}],
    ["other bot", { elements: [h.at("other")] }],
    ["all", { elements: [h("at", { type: "all" })] }],
    ["here", { elements: [h("at", { type: "here" })] }],
    ["quoted mention", { elements: [h("quote", { id: "quoted" }, [h.at("bot-1")])] }],
    ["self quote", { quote: { messageId: "quoted", author: { id: "bot-1" }, elements: [h.text("quoted")] } }],
    ["image", { elements: [h.image("https://fixture.invalid/image.png")] }],
  ] satisfies Array<[string, Partial<MessageRecord>]>)("waits for %s without adding willingness behavior", (_name, patch) => {
    expect(defaultWillEngine.decide(message("waiting", patch), state)).toBe("wait");
  });

  it("waits for a typed targeted poke", () => {
    expect(defaultWillEngine.decide(poke, state)).toBe("wait");
  });

  it("keeps a mentioned request after ordinary chatter in a real trailing-edge batch", async () => {
    const { runtime, requests, drain } = await fixture();
    await runtime.handle(defaultMessageRecord({ messageId: "request", elements: [h.at("bot-1"), h.text("addressed-request")] }));
    await vi.advanceTimersByTimeAsync(10_000);
    await runtime.handle(defaultMessageRecord({ messageId: "ambient", elements: [h.text("ambient-chatter")] }));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await drain();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.prompt)).toContain("ambient-chatter");
    const prompt = requests[0]!.prompt
      .flatMap((entry) => (typeof entry.content === "string" ? [entry.content] : entry.content.filter((part) => part.type === "text").map((part) => part.text)))
      .join("\n");
    expect(prompt.match(/\[CURRENT_MESSAGE\]\n([\s\S]*?)\n\[\/CURRENT_MESSAGE\]/)?.[1]).toContain("addressed-request");
  });

  it("does not let default-engine pokes refresh the message timer and cancels on stop", async () => {
    const { runtime, requests, drain } = await fixture();
    await runtime.handle(defaultMessageRecord({ messageId: "request", elements: [h.at("bot-1")] }));
    await vi.advanceTimersByTimeAsync(10_000);
    await runtime.handle(poke);
    await vi.advanceTimersByTimeAsync(5_000);
    await drain();
    expect(requests).toHaveLength(1);
    await runtime.handle(defaultMessageRecord({ messageId: "pending", elements: [h.at("bot-1")] }));
    await runtime.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(requests).toHaveLength(1);
  });
});
