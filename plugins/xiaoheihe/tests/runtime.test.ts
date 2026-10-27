import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { Context } from "@koishijs/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { Channel } from "../../../core/src/channels/index.js";
import { ChannelRuntime } from "../../../core/src/runtimes/channel.js";
import { defaultConfig } from "../../../core/tests/helpers/index.js";
import { Account } from "../src/account.js";
import { publicationText } from "../src/index.js";
import { AccountStore } from "../src/store.js";
import { createAccountPlugin } from "../src/tools.js";
import type { Config, XiaoheiheApi } from "../src/types.js";

const heading = "【本轮角色决策流程；这是运行规则，不是新增聊天内容】";
const steps = ["1. 确定当前互动", "2. 确定本轮角色依据", "3. 确定本轮行为和目的", "4. 核对事实并处理必要工具", "5. 组织对外表达", "6. 发送前检查"];

describe("Xiaoheihe uses the existing Core persona workflow", () => {
  it.each(["post", "comment", "reply"] as const)("injects the complete workflow before every %s request, including tool continuations", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "xhh-runtime-"));
    const store = await AccountStore.open(join(root, "account"), "bot");
    const api: XiaoheiheApi = {
      login: async () => ({ userId: "bot" }),
      profile: async () => ({ userId: "bot", posts: [] }),
      feed: async () => [],
      search: async () => [],
      post: async () => ({
        id: "p",
        authorId: "other",
        title: "title",
        text: "UNTRUSTED_POST",
        comments: [{ id: "c", authorId: "other", text: "question", rootId: "c" }],
      }),
      publish: vi.fn(async () => ({ accepted: true, verified: true, id: "published" })),
      comment: vi.fn(async () => ({ accepted: true, verified: true, id: "commented" })),
      close: async () => {},
    };
    const cfg: Config = {
      selfId: "bot",
      mcp: { type: "stdio", command: "unused" },
      dailyPostLimit: 1,
      dailyInteractionLimit: 10,
      pollIntervalMinutes: 30,
      feedLimit: 10,
      maxWatchedPosts: 50,
      communities: [],
      browseCommunities: [],
      browseTopics: [],
    };
    const account = new Account(cfg, api, store, async () => {});
    const channelId = kind === "post" ? "account:bot" : "post:bot:p";
    const scope = { type: "guild" as const, platform: "xiaoheihe", selfId: "bot", channelId, guildId: channelId };
    const channel = new Channel(scope, root);
    await channel.conversation.init();
    const prompts: LanguageModelV3CallOptions["prompt"][] = [];
    const text = kind === "post" ? "TITLE\nPUBLIC_BODY" : kind === "reply" ? '<quote id="c"/>PUBLIC_BODY' : "PUBLIC_BODY";
    const model = {
      specificationVersion: "v3" as const,
      provider: "synthetic",
      modelId: "offline",
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: vi.fn(async (options: LanguageModelV3CallOptions) => {
        const first = prompts.length === 0;
        prompts.push(options.prompt);
        if (prompts.length > 2) throw new Error("unexpected_request");
        const toolName = first ? (kind === "post" ? "xiaoheihe_feed" : "xiaoheihe_read_post") : "send_message";
        const input = first ? (kind === "post" ? {} : { postId: "p" }) : { parts: [{ kind: "text", text }] };
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "tool-call", toolCallId: `call-${prompts.length}`, toolName, input: JSON.stringify(input) });
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
    const bot = {
      selfId: "bot",
      platform: "xiaoheihe",
      sendMessage: vi.fn(async (target, content) => {
        const value = publicationText(content);
        return account.send(target, value.text, value.quoteId);
      }),
    };
    const runtime = new ChannelRuntime(new Context() as never, {
      channel,
      bot: bot as never,
      will: { decide: async () => "trigger", observe: () => {} },
      model: model as never,
      readImagePolicy: { mode: "native" },
      roleProfile: { characterDefinition: "SYNTHETIC_SHARED_PERSONA", roleInstructions: "SYNTHETIC_ROLE_RULE" },
      config: defaultConfig({ basePath: root, modelRetries: 0, logLevel: 0, pacing: { charactersPerSecond: 100, maxTotalDelayMs: 0 } }),
      plugins: [createAccountPlugin(account, scope)!],
    });
    try {
      await runtime.init();
      const event =
        kind === "post"
          ? { eventType: "xiaoheihe.browse" as const, xiaoheihe: { kind: "browse" as const } }
          : { eventType: "xiaoheihe.thread" as const, xiaoheihe: { kind: "thread" as const, postId: "p", commentIds: kind === "reply" ? ["c"] : [] } };
      const result = await runtime.post(
        { ...event, platform: "xiaoheihe", selfId: "bot", channel: { id: channelId, type: 0 }, timestamp: Date.now(), text: "SYNTHETIC_PUBLIC_ACTIVITY" },
        { trigger: true, delivery: "channel", historyMode: "conversation" },
      );
      if (result.kind === "run") await result.done;
      await runtime.wait();
      expect(prompts).toHaveLength(2);
      expect(bot.sendMessage).toHaveBeenCalledTimes(1);
      for (const prompt of prompts) {
        const wire = JSON.stringify(prompt);
        expect(wire.split(heading)).toHaveLength(2);
        for (const step of steps) expect(wire).toContain(step);
        expect(wire).toContain("SYNTHETIC_SHARED_PERSONA");
        expect(wire).toContain("SYNTHETIC_ROLE_RULE");
        expect(JSON.stringify(prompt.at(-1))).toContain(heading);
      }
      if (kind === "post") expect(api.publish).toHaveBeenCalledWith("TITLE", "PUBLIC_BODY", []);
      else expect(api.comment).toHaveBeenCalledWith("p", "PUBLIC_BODY", kind === "reply" ? "question" : undefined);
      const history = JSON.stringify(await channel.conversation.storage.read());
      expect(history).not.toContain(heading);
      expect(history).toContain("SYNTHETIC_PUBLIC_ACTIVITY");
      expect(store.snapshot().actions[0]).toMatchObject({ status: "sent" });
    } finally {
      await runtime.stop();
      await account.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
