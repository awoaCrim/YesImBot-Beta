/* eslint-disable vitest/require-mock-type-parameters */
import { createAgent, createUserMessage, jsonSchema, type AgentPlugin } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import type { ChannelContext } from "koishi-plugin-yesimbot";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", () => {
  const chain = () => {
    const target: Record<string, unknown> = {};
    target.default = () => target;
    target.description = () => target;
    target.role = () => target;
    target.min = () => target;
    return target;
  };
  return {
    Context: class {},
    Logger: class {},
    Schema: { object: chain, union: chain, const: chain, dynamic: chain, string: chain, boolean: chain, path: chain, number: chain },
    h: { image: (src: string) => ({ type: "img", attrs: { src } }) },
  };
});

import StickerManagerPlugin from "../src/index.js";
import type { StickerConfig, StickerProjection, StickerRow } from "../src/types.js";
import { createMemoryModel } from "./helpers.js";

interface CommandRecord {
  name: string;
  disposed: boolean;
}

function createCommandMock() {
  const commands: CommandRecord[] = [];
  const command = vi.fn((def: string) => {
    const record: CommandRecord = { name: def.split(/\s+/, 1)[0] ?? def, disposed: false };
    commands.push(record);
    const api = {
      option: () => api,
      action: () => api,
      dispose: () => {
        record.disposed = true;
      },
    };
    return api;
  });
  return { commands, command };
}

const config: StickerConfig = {
  scope: "global",
  storagePath: "data",
  classificationModel: "",
  classificationPrompt: "{{categories}}",
  maxImportFileBytes: 1024 * 1024,
  tagMode: false,
  fuzzyTagMatch: true,
  tagRandomRange: 1,
  sendStaticAsGif: true,
  stickerElement: true,
  enableSteal: true,
};

const scope: ChannelContext = { type: "guild", platform: "test", channelId: "room", guildId: "room" };

describe("StickerManagerPlugin", () => {
  let ready: Array<() => Promise<void> | void> = [];
  let dispose: Array<() => Promise<void> | void> = [];
  let registeredPlugin: StickerManagerPlugin | undefined;

  afterEach(async () => {
    for (const callback of dispose) await callback();
    vi.restoreAllMocks();
    ready = [];
    dispose = [];
    registeredPlugin = undefined;
  });

  function createHarness(overrides: Partial<StickerConfig> = {}) {
    const model = createMemoryModel<StickerRow>();
    const { commands, command } = createCommandMock();
    const agentDispose = { current: undefined as (() => void) | undefined };
    const logger = { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ctx = {
      baseDir: process.cwd(),
      logger: () => logger,
      on: vi.fn((event: string, callback: () => Promise<void> | void) => {
        if (event === "ready") ready.push(callback);
        if (event === "dispose") dispose.push(callback);
      }),
      model,
      command,
      yesimbot: {
        agent: {
          use: vi.fn((plugin: StickerManagerPlugin) => {
            registeredPlugin = plugin;
            agentDispose.current = vi.fn();
            return agentDispose.current;
          }),
        },
        resource: {
          get: vi.fn(async () => ({
            path: process.cwd(),
            assets: { get: vi.fn(), put: vi.fn(), clear: vi.fn() },
            artifacts: { forTool: vi.fn(() => ({ put: vi.fn() })) },
          })),
        },
        model: { getDefaultChatModelId: vi.fn(), resolveChatModel: vi.fn() },
      },
    };

    new StickerManagerPlugin(ctx as never, { ...config, ...overrides });
    return {
      ctx,
      model,
      commands,
      agentDispose,
      logger,
      async start(bot: unknown = { selfId: "bot" }, channelScope: ChannelContext = scope): Promise<AgentPlugin | null> {
        await ready[0]?.();
        if (!registeredPlugin) throw new Error("sticker plugin was not registered");
        return registeredPlugin.setup(channelScope, bot as never);
      },
      async stop(): Promise<void> {
        await dispose[0]?.();
      },
    };
  }

  async function toolNames(agentPlugin: AgentPlugin | null): Promise<string[]> {
    const tools = typeof agentPlugin?.tools === "function" ? ((await agentPlugin.tools({} as never)) ?? []) : [];
    return tools.map((tool) => tool.name);
  }

  async function pluginPrompt(agentPlugin: AgentPlugin | null): Promise<string> {
    return String(await agentPlugin?.appendSystemPrompt?.({} as never));
  }

  async function expectToolNames(agentPlugin: AgentPlugin | null, expected: string[]): Promise<void> {
    const names = await toolNames(agentPlugin);
    expect(names).toHaveLength(expected.length);
    expect(names).toEqual(expect.arrayContaining(expected));
  }

  it("registers the model, AgentPlugin factory and commands on ready", async () => {
    const harness = createHarness();
    expect(harness.model.extend).toHaveBeenCalledOnce();
    expect(harness.commands).toHaveLength(0);
    const agentPlugin = await harness.start();

    expect(harness.ctx.yesimbot.agent.use).toHaveBeenCalledOnce();
    expect(harness.commands.length).toBeGreaterThan(0);
    expect(harness.commands.map((record) => record.name)).toContain("yesimbot.sticker.reclassify");
    expect(agentPlugin?.name).toBe("sticker-manager");

    await harness.stop();
    expect(harness.agentDispose.current).toHaveBeenCalledOnce();
    expect(harness.commands.every((record) => record.disposed)).toBe(true);
  });

  it("hides sticker_steal from tools and prompt when stealing is disabled", async () => {
    const harness = createHarness({ enableSteal: false, tagMode: true });
    const agentPlugin = await harness.start();

    await expectToolNames(agentPlugin, ["sticker_send", "sticker_categories", "sticker_search", "sticker_tags"]);
    const prompt = await pluginPrompt(agentPlugin);
    expect(prompt).not.toContain("sticker_steal");
    expect(prompt).not.toContain("收藏当前消息");
    expect(prompt).toContain("sticker_send");
    expect(prompt).toContain("sticker_tags");

    const commandNames = harness.commands.map((record) => record.name);
    expect(commandNames).toEqual(
      expect.arrayContaining(["yesimbot.sticker.add", "yesimbot.sticker.import", "yesimbot.sticker.migrate-v3", "yesimbot.sticker.migrate"]),
    );
  });

  it("requires sticker_send instead of advertising direct sticker output", async () => {
    const harness = createHarness({ enableSteal: false, stickerElement: true });
    const agentPlugin = await harness.start();

    const prompt = await pluginPrompt(agentPlugin);
    expect(prompt).toContain("发送表情包必须调用 sticker_send");
    expect(prompt).not.toContain("当前角色本身喜欢用表情包");
    expect(prompt).not.toContain("千早爱音");
    expect(prompt).toContain("同一轮最多实际发送一张");
    expect(prompt).toContain("开心、得意、吐槽、害羞");
    expect(prompt).toContain("不必等对方要求");
    expect(prompt).toContain("发送文字前先决定");
    expect(prompt).toContain("不合适时可省略");
    expect(prompt).toContain("不要为完成规则强行发送");
    expect(prompt.length).toBeLessThan(700);
    expect(prompt).toContain("先调用 send_message 并设置 continue=true，再调用 terminal 的 sticker_send");
    expect(prompt).not.toContain("也可以直接输出 <sticker");
    expect(prompt).not.toContain("需要发图时可直接输出");
    expect(prompt).not.toContain("不需要调用 sticker_send");

    const tools = (await agentPlugin?.tools?.({} as never)) ?? [];
    const sendTool = tools.find((tool) => tool.name === "sticker_send");
    expect(sendTool?.description).toContain("不传 sticker_id、category、index、tags 时会随机选择一张");
    expect(sendTool?.description).toContain("先让 send_message 使用 continue=true，再调用本工具");
  });

  function preparation(turnId: string, stepNumber = 0) {
    return { turnId, stepNumber } as never;
  }

  function catalogFrom(messages: readonly ModelMessage[]) {
    const catalog = messages.find((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("[表情包库概览"));
    if (!catalog || typeof catalog.content !== "string") throw new Error("missing sticker catalog");
    return catalog.content;
  }

  it("provides a scoped catalog as request-only data without changing the stable prompt or input", async () => {
    const harness = createHarness({ enableSteal: false });
    const plugin = await harness.start();
    if (!registeredPlugin || !plugin) throw new Error("missing plugin");
    const list = vi.spyOn(registeredPlugin.store, "listCategories").mockResolvedValue([
      { category: "开心", count: 3 },
      { category: "害羞", count: 1 },
    ]);
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }];
    const prepared = (await plugin.prepareStep?.(messages, preparation("turn-1"))) ?? messages;
    const catalog = catalogFrom(prepared);

    expect(list).toHaveBeenCalledWith("global");
    expect(JSON.parse(catalog.split("\n")[1])).toEqual({
      total: 4,
      categories: [
        { category: "开心", count: 3 },
        { category: "害羞", count: 1 },
      ],
      omittedCategories: 0,
    });
    expect(messages).toEqual([{ role: "user", content: "hello" }]);
    expect(await pluginPrompt(plugin)).not.toContain("表情包库概览");
    expect(catalog).not.toMatch(/asset:\/\/|artifact:\/\/|workspace:\/\//);
    expect(harness.model.create).not.toHaveBeenCalled();
    expect(harness.model.set).not.toHaveBeenCalled();
  });

  it("reads only the current channel's categories when the library is channel-scoped", async () => {
    const harness = createHarness({ scope: "channel" });
    const plugin = await harness.start();
    if (!plugin) throw new Error("missing plugin");
    const row = (scopeKey: string, category: string): StickerRow => ({
      id: `${scopeKey}:id`,
      contentId: "a".repeat(64),
      scopeKey,
      category,
      tags: [],
      mime: "image/png",
      size: 1,
      source: { kind: "import" },
      usageCount: 0,
      lastUsedAt: null,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });
    harness.model.tables.set("yesimbot_sticker", [row("group:test:room", "本频道"), row("group:test:other", "其他频道")]);
    const prepared = (await plugin.prepareStep?.([], preparation("turn-1"))) ?? [];

    expect(harness.model.get).toHaveBeenCalledWith("yesimbot_sticker", { scopeKey: "group:test:room" });
    expect(catalogFrom(prepared)).toContain("本频道");
    expect(catalogFrom(prepared)).not.toContain("其他频道");
  });

  it("keeps one snapshot across steps and rebuilds, then refreshes for a new turn", async () => {
    const harness = createHarness();
    const plugin = await harness.start();
    if (!registeredPlugin || !plugin) throw new Error("missing plugin");
    const list = vi
      .spyOn(registeredPlugin.store, "listCategories")
      .mockResolvedValueOnce([{ category: "旧分类", count: 1 }])
      .mockResolvedValue([{ category: "新分类", count: 2 }]);
    const first = (await plugin.prepareStep?.([], preparation("turn-1"))) ?? [];
    const nextStep = (await plugin.prepareStep?.([], preparation("turn-1", 1))) ?? [];
    const rebuild = (await plugin.prepareStep?.(first, preparation("turn-1"))) ?? [];

    expect(catalogFrom(nextStep)).toBe(catalogFrom(first));
    expect(rebuild).toBe(first);
    expect(list).toHaveBeenCalledOnce();
    const nextTurn = (await plugin.prepareStep?.([], preparation("turn-2"))) ?? [];
    expect(catalogFrom(nextTurn)).toContain("新分类");
    expect(catalogFrom(nextTurn)).not.toContain("旧分类");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("clears the catalog snapshot when the turn finishes", async () => {
    const harness = createHarness();
    const plugin = await harness.start();
    if (!registeredPlugin || !plugin) throw new Error("missing plugin");
    const list = vi.spyOn(registeredPlugin.store, "listCategories").mockResolvedValue([]);
    await plugin.prepareStep?.([], preparation("turn-1"));
    await plugin.onTurnFinish?.({ turnId: "turn-1", status: "done", messages: [] }, { turnId: "turn-1" } as never);
    await plugin.prepareStep?.([], preparation("turn-1"));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("limits catalog entries without enumerating every sticker", async () => {
    const harness = createHarness();
    const plugin = await harness.start();
    if (!registeredPlugin || !plugin) throw new Error("missing plugin");
    const categories = Array.from({ length: 50 }, (_, index) => ({ category: `分类-${index}`, count: 50 - index }));
    vi.spyOn(registeredPlugin.store, "listCategories").mockResolvedValue(categories);
    const text = catalogFrom((await plugin.prepareStep?.([], preparation("turn-1"))) ?? []);
    const data = JSON.parse(text.split("\n")[1]);

    expect(text.length).toBeLessThanOrEqual(2000);
    expect(data.categories).toHaveLength(20);
    expect(data.omittedCategories).toBe(30);
    expect(data.total).toBe(1275);
    expect(data.categories[0]).toEqual({ category: "分类-0", count: 50 });
  });

  it("caps serialized characters and preserves complete JSON-quoted category names", async () => {
    const harness = createHarness();
    const plugin = await harness.start();
    if (!registeredPlugin || !plugin) throw new Error("missing plugin");
    const names = Array.from({ length: 20 }, (_, index) => `${"\\".repeat(60)}${index}`);
    const categories = [{ category: "x".repeat(3000), count: 99 }, ...names.map((category) => ({ category, count: 1 }))];
    vi.spyOn(registeredPlugin.store, "listCategories").mockResolvedValue(categories);
    const text = catalogFrom((await plugin.prepareStep?.([], preparation("turn-1"))) ?? []);
    const data = JSON.parse(text.split("\n")[1]);

    expect(text.length).toBeLessThanOrEqual(2000);
    expect(data.categories.length).toBeGreaterThan(0);
    expect(data.categories.length).toBeLessThan(20);
    expect(data.categories.every((item: { category: string }) => names.includes(item.category))).toBe(true);
    expect(data.omittedCategories).toBe(categories.length - data.categories.length);
  });

  it("announces an empty visible library without attempting delivery", async () => {
    const harness = createHarness({ enableSteal: false });
    const sendMessage = vi.fn();
    const plugin = await harness.start({ selfId: "bot", sendMessage });
    const text = catalogFrom((await plugin?.prepareStep?.([], preparation("turn-1"))) ?? []);

    expect(text).toContain("回合开始时可见库为空");
    expect(text).toContain("未获得新库存结果前");
    expect(text).toContain("不要随机调用 sticker_send");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("fails open for a catalog read error and retries on the next turn", async () => {
    const harness = createHarness();
    const plugin = await harness.start();
    if (!registeredPlugin || !plugin) throw new Error("missing plugin");
    const list = vi
      .spyOn(registeredPlugin.store, "listCategories")
      .mockRejectedValueOnce(new Error("database_unavailable"))
      .mockResolvedValue([{ category: "恢复", count: 1 }]);
    const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

    expect(await plugin.prepareStep?.(messages, preparation("turn-1"))).toBe(messages);
    expect(await plugin.prepareStep?.(messages, preparation("turn-1", 1))).toBe(messages);
    expect(list).toHaveBeenCalledOnce();
    expect(harness.logger.warn).toHaveBeenCalledOnce();
    expect(catalogFrom((await plugin.prepareStep?.(messages, preparation("turn-2"))) ?? messages)).toContain("恢复");
  });

  it("includes the catalog in the real model request but never persists it in Agent storage", async () => {
    const harness = createHarness();
    const plugin = await harness.start();
    if (!registeredPlugin || !plugin) throw new Error("missing plugin");
    const list = vi.spyOn(registeredPlugin.store, "listCategories").mockResolvedValue([{ category: "CATALOG_SENTINEL", count: 1 }]);
    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        const index = step++;
        return {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: `call-${index}`, toolName: index === 0 ? "inspect" : "finish", input: "{}" },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            },
          ]),
        };
      },
    });
    const schema = jsonSchema<Record<string, never>>({ type: "object", additionalProperties: false });
    const agent = createAgent({
      model,
      plugins: [plugin],
      requireTerminalTool: true,
      tools: [
        { name: "inspect", inputSchema: schema, execute: async () => ({ ok: true }) },
        { name: "finish", terminal: true, inputSchema: schema, execute: async () => ({ ok: true }) },
      ],
    });
    try {
      agent.send(createUserMessage("hello"));
      await agent.wait();
      expect(model.doStreamCalls).toHaveLength(2);
      expect(model.doStreamCalls.every((call) => JSON.stringify(call.prompt).includes("CATALOG_SENTINEL"))).toBe(true);
      expect(list).toHaveBeenCalledOnce();
      expect(JSON.stringify(await agent.storage.read())).not.toContain("CATALOG_SENTINEL");
      expect(harness.model.create).not.toHaveBeenCalled();
    } finally {
      await agent.stop();
    }
  });

  it("keeps sticker_steal in tools and prompt while stealing is enabled", async () => {
    const harness = createHarness({ enableSteal: true });
    const agentPlugin = await harness.start();

    await expectToolNames(agentPlugin, ["sticker_steal", "sticker_send", "sticker_categories", "sticker_search"]);
    const prompt = await pluginPrompt(agentPlugin);
    expect(prompt).toContain("sticker_steal");
    expect(prompt).toContain("收藏当前消息");
  });

  it("clears the per-turn sticker claim when the Agent turn finishes", async () => {
    const harness = createHarness({ sendStaticAsGif: false });
    const sendMessage = vi.fn(async () => ["message-1"]);
    const agentPlugin = await harness.start({ selfId: "bot", sendMessage });
    if (!registeredPlugin || !agentPlugin) throw new Error("sticker plugin was not initialized");

    const sticker: StickerProjection = {
      id: "a".repeat(64),
      category: "meme",
      tags: [],
      mime: "image/png",
      size: 1,
      source: { kind: "import" },
      usageCount: 0,
      lastUsedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    vi.spyOn(registeredPlugin.store, "random").mockResolvedValue(sticker);
    vi.spyOn(registeredPlugin.store, "readBytes").mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.spyOn(registeredPlugin.store, "markUsed").mockResolvedValue(sticker);

    const tool = () => agentPlugin.tools?.({} as never);
    const firstTool = (await tool())?.find((candidate) => candidate.name === "sticker_send");
    const first = await firstTool?.execute?.({}, { turnId: "turn-1" } as never);
    const blocked = await firstTool?.execute?.({}, { turnId: "turn-1" } as never);

    await agentPlugin.onTurnFinish?.({ turnId: "turn-1", status: "done", messages: [] }, { turnId: "turn-1" } as never);

    const nextTool = (await tool())?.find((candidate) => candidate.name === "sticker_send");
    const afterFinish = await nextTool?.execute?.({}, { turnId: "turn-1" } as never);

    expect(first).toMatchObject({ ok: true });
    expect(blocked).toEqual({ ok: false, error: "sticker_send_limit_reached" });
    expect(afterFinish).toMatchObject({ ok: true });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
