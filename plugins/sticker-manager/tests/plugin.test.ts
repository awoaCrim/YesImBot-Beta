/* eslint-disable vitest/require-mock-type-parameters */
import { createAgent, createUserMessage, createToolMessage, EphemeralImageProjectionStore, jsonSchema, type AgentPlugin } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import type { ChannelContext, ChannelPluginSetupContext, ReplyStickerProvider } from "koishi-plugin-yesimbot";
import { PNG } from "pngjs";
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

import type { StickerDeliveryService } from "../src/delivery.js";
import { sha256Hex } from "../src/files.js";
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
    const model = createMemoryModel<{ [K in keyof StickerRow]: StickerRow[K] }>();
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
      async start(bot: unknown = { selfId: "bot" }, channelScope: ChannelContext = scope, runtime?: ChannelPluginSetupContext): Promise<AgentPlugin | null> {
        await ready[0]?.();
        if (!registeredPlugin) throw new Error("sticker plugin was not registered");
        return registeredPlugin.setup(channelScope, bot as never, runtime);
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

    await expectToolNames(agentPlugin, ["sticker_preview", "sticker_send", "sticker_categories", "sticker_search", "sticker_tags"]);
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

  it.each([false, true])("exposes management only with explicit enableManage=%s", async (enableManage) => {
    const plugin = await createHarness({ enableManage, enableSteal: false }).start();
    expect((await toolNames(plugin)).includes("sticker_manage")).toBe(enableManage);
    expect((await pluginPrompt(plugin)).includes("sticker_manage")).toBe(enableManage);
  });

  it("modern authored hides standalone delivery and registers one disposable capability", async () => {
    const harness = createHarness({ enableSteal: false, tagMode: true });
    const unregister = vi.fn();
    const unregisterChannelOutput = vi.fn();
    const registerSticker = vi.fn((_provider: ReplyStickerProvider) => unregister);
    const registerTools = vi.fn((_names: readonly string[]) => unregisterChannelOutput);
    const runtime = {
      imageProjection: new EphemeralImageProjectionStore(),
      replyDelivery: { version: 1 as const, ownership: "authored" as const, registerSticker },
      channelOutput: { version: 1 as const, registerTools },
    };
    const plugin = await harness.start({ selfId: "bot" }, scope, runtime);
    expect(registerSticker).toHaveBeenCalledOnce();
    expect(registerTools).toHaveBeenCalledWith(["sticker_send"]);
    await expectToolNames(plugin, ["sticker_preview", "sticker_categories", "sticker_search", "sticker_tags"]);
    const prompt = await pluginPrompt(plugin);
    expect(prompt).not.toContain("sticker_send");
    expect(prompt).not.toContain("continue 设为 true");
    expect(prompt).toContain("send_message");
    expect(prompt).toContain("sticker parts");
    const tools = typeof plugin?.tools === "function" ? await plugin.tools({} as never) : [];
    expect(tools?.find((tool) => tool.name === "sticker_preview")?.description).not.toContain("sticker_send");
    const provider = registerSticker.mock.calls[0]![0];
    const revision = provider.revision;
    expect(provider.status("turn")).toBe("eligible");
    await plugin?.stop?.();
    await plugin?.stop?.();
    expect(unregister).toHaveBeenCalledOnce();
    expect(unregisterChannelOutput).toHaveBeenCalledOnce();
    expect(provider.revision).toBeGreaterThan(revision);
    expect(provider.status("turn")).toBe("unavailable");
    await expect(provider.preflight({ stickerId: "s", turnId: "turn", messages: [] })).resolves.toEqual({ error: "StickerCapabilityRetired" });
    expect(harness.commands.map((command) => command.name)).toContain("yesimbot.sticker.import");
  });

  it("binds each lease preflight to provider disposal and Core's later permission", async () => {
    const harness = createHarness();
    await harness.start();
    if (!registeredPlugin) throw new Error("missing plugin");
    const registerSticker = vi.fn((_provider: ReplyStickerProvider) => vi.fn());
    const runtime: ChannelPluginSetupContext = {
      imageProjection: new EphemeralImageProjectionStore(),
      replyDelivery: { version: 1, ownership: "authored", registerSticker },
    };
    const preflight = vi.fn(async (_input: Parameters<StickerDeliveryService["preflight"]>[0]) => ({ error: "test_preflight" }));
    const delivery = { preflight } as unknown as StickerDeliveryService;
    const unregister = registeredPlugin.registerDelivery(scope, {} as never, runtime, delivery);
    const provider = registerSticker.mock.calls[0]![0];
    let coreAllowed = true;
    await provider.preflight({ stickerId: "s", turnId: "turn", messages: [], stillAllowed: () => coreAllowed });
    const bound = preflight.mock.calls[0]![0].stillAllowed!;
    expect(bound()).toBe(true);
    coreAllowed = false;
    expect(bound()).toBe(false);
    coreAllowed = true;
    await harness.stop();
    expect(bound()).toBe(false); // Existing lease carries this callback past later byte awaits.
    unregister?.();
  });

  it("modern guards reject legacy sticker resources in authored parts before output", async () => {
    const harness = createHarness();
    const plugin = await harness.start({ selfId: "bot" }, scope, {
      imageProjection: new EphemeralImageProjectionStore(),
      replyDelivery: { version: 1, ownership: "authored", registerSticker: () => () => {} },
    });
    const blocked = [{ toolName: "send_message", args: { parts: [{ kind: "text", text: '<img src="artifact://sticker/old.png"/>' }] } }];
    for (const call of blocked) expect(await plugin?.beforeToolCall?.(call as never, {} as never)).toMatchObject({ type: "block" });
    expect(
      await plugin?.beforeToolCall?.({ toolName: "send_message", args: { parts: [{ kind: "sticker", sticker_id: "viewed-id" }] } } as never, {} as never),
    ).toBeUndefined();
  });

  it("does not infer modern delivery from an unsupported setup seam", async () => {
    const harness = createHarness();
    const registerSticker = vi.fn();
    const plugin = await harness.start({ selfId: "bot" }, scope, {
      imageProjection: new EphemeralImageProjectionStore(),
      replyDelivery: { version: 2, ownership: "authored", registerSticker },
    } as unknown as ChannelPluginSetupContext);
    expect(registerSticker).not.toHaveBeenCalled();
    expect(await toolNames(plugin)).toContain("sticker_send");
  });

  it("keeps optional choice in the capability note and legacy mechanics in the sending tool", async () => {
    const agentPlugin = await createHarness({ enableSteal: false, stickerElement: true }).start();
    const prompt = await pluginPrompt(agentPlugin);
    expect(prompt).toContain("自主选用");
    expect(prompt).toContain("sticker_categories");
    expect(prompt).toContain("sticker_search");
    expect(prompt).toContain("sticker_send");
    expect(prompt).not.toMatch(/开心、得意|先表情后文字|两段文字之间|同一轮最多|continue|artifact:/);
    expect(prompt.length).toBeLessThan(300);

    const tools = typeof agentPlugin?.tools === "function" ? ((await agentPlugin.tools({} as never)) ?? []) : [];
    const sendTool = tools.find((tool) => tool.name === "sticker_send");
    expect(sendTool?.description).toContain("精确 sticker_id");
    expect(sendTool?.description).toContain("sticker_preview 可选");
    expect(sendTool?.description).toContain("sticker_send_limit_reached");
    expect(sendTool?.description).toContain("continue=true");
    expect(sendTool?.description).toContain("artifact://sticker/");
    expect(sendTool?.description).not.toMatch(/文字之前或之后|固定搭配|不合适的场合/);
  });

  it.each(
    [false, true].flatMap((modern) =>
      [false, true].flatMap((enableSteal) =>
        [false, true].flatMap((enableManage) => [false, true].map((tagMode) => ({ modern, enableSteal, enableManage, tagMode }))),
      ),
    ),
  )("keeps a compact capability note for %j", async ({ modern, enableSteal, enableManage, tagMode }) => {
    const harness = createHarness({ enableSteal, enableManage, tagMode });
    const plugin = await harness.start(
      { selfId: "bot" },
      scope,
      modern
        ? {
            imageProjection: new EphemeralImageProjectionStore(),
            replyDelivery: { version: 1, ownership: "authored", registerSticker: () => () => {} },
          }
        : undefined,
    );
    const prompt = await pluginPrompt(plugin);
    const names = await toolNames(plugin);
    expect(prompt).toContain("自主选用");
    expect(prompt).toContain("sticker_categories");
    expect(prompt).toContain("sticker_search");
    expect(prompt).toContain(modern ? "send_message" : "sticker_send");
    expect(prompt.includes("sticker_steal")).toBe(enableSteal);
    expect(prompt.includes("sticker_manage")).toBe(enableManage);
    expect(prompt.includes("sticker_tags")).toBe(tagMode);
    expect(names.includes("sticker_send")).toBe(!modern);
    expect(names.includes("sticker_steal")).toBe(enableSteal);
    expect(names.includes("sticker_manage")).toBe(enableManage);
    expect(names.includes("sticker_tags")).toBe(tagMode);
    expect(prompt.length).toBeLessThan(300);
    expect(prompt.split("\n").length).toBeLessThanOrEqual(5);
    expect(prompt).not.toMatch(/表情包库概览|回合开始快照|开心、得意|两段文字之间|每轮发送/);
  });

  function preparation(turnId: string, stepNumber = 0) {
    return { turnId, stepNumber } as never;
  }

  it("leaves fresh, continued and rebuilt requests unchanged without querying a catalog", async () => {
    const harness = createHarness({ enableSteal: false });
    const plugin = await harness.start();
    if (!registeredPlugin || !plugin) throw new Error("missing plugin");
    const list = vi.spyOn(registeredPlugin.store, "listCategories").mockRejectedValue(new Error("database_unavailable"));
    const messages: ModelMessage[] = [
      { role: "user", content: "[表情包库概览：这是用户实际说的话]" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "signed-call", toolName: "inspect", input: {}, providerOptions: { google: { thoughtSignature: "signature" } } },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "signed-call", toolName: "inspect", output: { type: "json", value: { ok: true } } }] },
    ];
    const snapshot = structuredClone(messages);
    for (const context of [preparation("turn-1"), preparation("turn-1", 1), preparation("turn-1"), preparation("turn-2")]) {
      const prepared = await plugin.prepareStep?.(messages, context);
      expect(prepared).toBe(messages);
      expect(prepared).toEqual(snapshot);
      for (const [index, message] of messages.entries()) expect(prepared?.[index]).toBe(message);
    }
    expect(list).not.toHaveBeenCalled();
    expect(harness.logger.warn).not.toHaveBeenCalled();
    expect(harness.model.create).not.toHaveBeenCalled();
    expect(harness.model.set).not.toHaveBeenCalled();
  });

  it.each(["global", "channel"] as const)("queries the current %s library only on demand and observes mutations", async (libraryScope) => {
    const harness = createHarness({ scope: libraryScope, enableManage: true });
    const plugin = await harness.start();
    if (!registeredPlugin || !plugin) throw new Error("missing plugin");
    const scopeKey = libraryScope === "global" ? "global" : "group:test:room";
    const id = "a".repeat(64);
    const row = (key: string, contentId: string, category: string): StickerRow => ({
      id: key + ":" + contentId,
      contentId,
      scopeKey: key,
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
    harness.model.tables.set("yesimbot_sticker", [row(scopeKey, id, "old"), row("group:test:other", "b".repeat(64), "foreign")]);
    const list = vi.spyOn(registeredPlugin.store, "listCategories");
    await plugin.prepareStep?.([], preparation("turn-1"));
    expect(list).not.toHaveBeenCalled();
    const tools = typeof plugin.tools === "function" ? await plugin.tools({} as never) : [];
    const execute = async (name: string, input: unknown) => {
      const tool = tools?.find((candidate) => candidate.name === name);
      if (!tool) throw new Error("missing " + name);
      return tool.execute(input, { turnId: "turn-1", messages: [] } as never);
    };
    expect(await execute("sticker_categories", {})).toMatchObject({ ok: true, categories: [{ category: "old", count: 1 }] });
    expect(list).toHaveBeenCalledWith(scopeKey);
    expect(await execute("sticker_manage", { action: "rename_category", source_category: "old", category: "new" })).toMatchObject({ ok: true, affected: 1 });
    expect(await execute("sticker_categories", {})).toMatchObject({ ok: true, categories: [{ category: "new", count: 1 }] });
    expect(await execute("sticker_search", { category: "new" })).toMatchObject({ ok: true, stickers: [{ id, category: "new" }] });
    expect(await execute("sticker_search", { category: "foreign" })).toMatchObject({ ok: true, stickers: [] });
  });

  it.each(["finish", "replacement", "stop"] as const)("retains awaited mutation guards after %s without catalog preparation", async (boundary) => {
    const harness = createHarness({ enableManage: true });
    const plugin = await harness.start();
    if (!registeredPlugin || !plugin) throw new Error("missing plugin");
    await plugin.prepareStep?.([], preparation("turn-1"));
    let complete!: () => void;
    const pause = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let stillAllowed: (() => boolean) | undefined;
    const remove = vi.spyOn(registeredPlugin.store, "deleteSticker").mockImplementationOnce(async (_key, _id, guard) => {
      stillAllowed = guard?.stillAllowed;
      await pause;
      throw new Error("retired operation");
    });
    const tools = typeof plugin.tools === "function" ? await plugin.tools({} as never) : [];
    const manage = tools?.find((tool) => tool.name === "sticker_manage");
    if (!manage) throw new Error("missing management tool");
    const input = { action: "delete", sticker_id: "a".repeat(64) };
    const pending = manage.execute(input, { turnId: "turn-1", messages: [] } as never);
    try {
      expect(remove).toHaveBeenCalledOnce();
      expect(stillAllowed?.()).toBe(true);
      if (boundary === "finish") {
        await plugin.onTurnFinish?.({ turnId: "turn-1", status: "done", messages: [] }, { turnId: "turn-1" } as never);
        await plugin.prepareStep?.([], preparation("turn-1"));
      } else if (boundary === "replacement") {
        await plugin.prepareStep?.([], preparation("turn-2"));
      } else {
        await harness.stop();
        await plugin.prepareStep?.([], preparation("turn-2"));
      }
      expect(stillAllowed?.()).toBe(false);
      expect(await manage.execute(input, { turnId: "turn-1", messages: [] } as never)).toMatchObject({ error: "StickerCapabilityRetired" });
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      complete();
      expect(await pending).toMatchObject({ error: "StickerCapabilityRetired" });
    }
    expect(harness.model.remove).not.toHaveBeenCalled();
  });

  it("keeps automatic catalogs out of real model requests and storage across tool steps and turns", async () => {
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
            { type: "tool-call", toolCallId: "call-" + index, toolName: index % 2 === 0 ? "inspect" : "finish", input: "{}" },
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
      for (const text of ["hello", "next scene"]) {
        agent.send(createUserMessage(text));
        await agent.wait();
      }
      expect(model.doStreamCalls).toHaveLength(4);
      for (const call of model.doStreamCalls) {
        expect(JSON.stringify(call.prompt)).not.toMatch(/CATALOG_SENTINEL|表情包库概览/);
      }
      expect(list).not.toHaveBeenCalled();
      expect(JSON.stringify(await agent.storage.read())).not.toMatch(/CATALOG_SENTINEL|表情包库概览/);
      expect(harness.model.create).not.toHaveBeenCalled();
    } finally {
      await agent.stop();
    }
  });

  it("keeps sticker_steal in tools and prompt while stealing is enabled", async () => {
    const harness = createHarness({ enableSteal: true });
    const agentPlugin = await harness.start();

    await expectToolNames(agentPlugin, ["sticker_preview", "sticker_steal", "sticker_send", "sticker_categories", "sticker_search"]);
    const prompt = await pluginPrompt(agentPlugin);
    expect(prompt).toContain("sticker_steal");
    expect(prompt).toContain("聊天图片");
  });

  it("clears the per-turn sticker claim when the Agent turn finishes", async () => {
    const harness = createHarness({ sendStaticAsGif: false });
    const sendMessage = vi.fn(async () => ["message-1"]);
    const projection = new EphemeralImageProjectionStore();
    const agentPlugin = await harness.start({ selfId: "bot", sendMessage }, scope, {
      imageProjection: projection,
      imagePreview: { mode: "vision", preview: () => ({ mode: "unavailable", error: "image_input_unavailable" }), describe: async () => "红色画面" },
    });
    if (!registeredPlugin || !agentPlugin) throw new Error("sticker plugin was not initialized");

    const png = new PNG({ width: 1, height: 1 });
    png.data.set([255, 0, 0, 255]);
    const bytes = new Uint8Array(PNG.sync.write(png));
    const sticker: StickerProjection = {
      id: sha256Hex(bytes),
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
    vi.spyOn(registeredPlugin.store, "get").mockResolvedValue(sticker);
    harness.model.tables.set("yesimbot_sticker", [
      { ...sticker, id: `global:${sticker.id}`, contentId: sticker.id, scopeKey: "global", updatedAt: sticker.createdAt },
    ]);
    vi.spyOn(registeredPlugin.store, "readBytes").mockResolvedValue(bytes);
    vi.spyOn(registeredPlugin.store, "markUsed").mockResolvedValue(sticker);

    const tool = async () => (typeof agentPlugin.tools === "function" ? ((await agentPlugin.tools({} as never)) ?? []) : []);
    const firstTools = await tool();
    const firstTool = firstTools?.find((candidate) => candidate.name === "sticker_send");
    const preview = firstTools?.find((candidate) => candidate.name === "sticker_preview");
    if (!preview) throw new Error("no preview");
    const view = async (turnId: string) => {
      await agentPlugin.prepareStep?.([], preparation(turnId));
      const output = await preview.execute({}, { turnId, toolCallId: "view", messages: [] } as never);
      const projected = await preview.toModelOutput!({ toolCallId: "view", input: {}, output });
      return { turnId, messages: [createToolMessage([{ type: "tool-result", toolName: "sticker_preview", toolCallId: "view", output: projected }])] } as never;
    };
    const context = await view("turn-1");
    const first = await firstTool?.execute?.({ sticker_id: sticker.id }, context);
    const blocked = await firstTool?.execute?.({ sticker_id: sticker.id }, context);

    await agentPlugin.onTurnFinish?.({ turnId: "turn-1", status: "done", messages: [] }, { turnId: "turn-1" } as never);

    const nextTool = (await tool())?.find((candidate) => candidate.name === "sticker_send");
    expect(await nextTool?.execute?.({ sticker_id: sticker.id }, context)).toMatchObject({ error: "StickerCapabilityRetired" });
    const afterFinish = await nextTool?.execute?.({ sticker_id: sticker.id }, await view("turn-2"));
    projection.clearAll();

    expect(first).toMatchObject({ ok: true });
    expect(blocked).toEqual({ ok: false, error: "sticker_send_limit_reached" });
    expect(afterFinish).toMatchObject({ ok: true });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
