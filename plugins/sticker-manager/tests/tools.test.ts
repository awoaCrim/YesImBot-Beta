/* eslint-disable vitest/require-mock-type-parameters */
import type { AgentTool } from "@yesimbot/agent-runtime";
import type { AssetStore, ChannelContext } from "koishi-plugin-yesimbot";
import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";

import type { StickerClassifier } from "../src/classifier.js";
import type { StickerSender } from "../src/sender.js";
import type { StickerStore } from "../src/store.js";
import { createStickerTools } from "../src/tools.js";
import type { StickerConfig, StickerProjection } from "../src/types.js";

const scope: ChannelContext = { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1" };

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

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function projection(overrides: Partial<StickerProjection> = {}): StickerProjection {
  return {
    id: "a".repeat(64),
    category: "meme",
    tags: [],
    mime: "image/png",
    size: pngBytes.byteLength,
    source: { kind: "steal" },
    usageCount: 0,
    lastUsedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createDeps(overrides: Partial<StickerConfig> = {}) {
  const effectiveConfig = { ...config, ...overrides };
  const store = {
    listCategories: vi.fn(async () => []),
    listTags: vi.fn(async () => []),
    save: vi.fn(async (input: { tags?: readonly string[] }) => ({ status: "created", sticker: projection({ tags: [...(input.tags ?? [])] }) })),
    get: vi.fn(async () => null),
    search: vi.fn(async () => [projection()]),
    listByScopeKey: vi.fn(async () => [projection()]),
    random: vi.fn(async () => projection()),
    readBytes: vi.fn(async () => pngBytes),
    markUsed: vi.fn(async () => projection({ usageCount: 1 })),
  };
  const classifier: StickerClassifier = { classify: vi.fn(async () => ({ category: "meme", tags: ["搞笑"] })) };
  const sender: StickerSender = { send: vi.fn(async () => undefined) };
  const assets: AssetStore = { put: vi.fn(async () => "a".repeat(32)), get: vi.fn(async () => pngBytes), clear: vi.fn(async () => undefined) };
  const sentTurnIds = new Set<string>();
  const tools = createStickerTools({ store: store as unknown as StickerStore, classifier, sender, assets, scope, config: effectiveConfig, sentTurnIds });
  return { store, classifier, sender, assets, sentTurnIds, tools };
}

async function execute(tool: AgentTool, input: unknown, turnId = "turn-1"): Promise<unknown> {
  return tool.execute!(input, { abortSignal: undefined, turnId } as never);
}

function toolNames(tools: AgentTool[]): Set<string> {
  return new Set(tools.map((tool) => tool.name));
}

function toolByName(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

describe("sticker agent tools", () => {
  it("keeps the legacy tool set while stealing is enabled", () => {
    const { tools } = createDeps({ enableSteal: true });
    expect(toolNames(tools)).toEqual(new Set(["sticker_steal", "sticker_send", "sticker_categories", "sticker_search"]));
  });

  it("marks sticker_send as terminal because the tool performs platform delivery", () => {
    const { tools } = createDeps({ enableSteal: false });

    expect(toolByName(tools, "sticker_send").terminal).toBe(true);
  });

  it("hides sticker_steal but keeps sending, categories and search when stealing is disabled", async () => {
    const deps = createDeps({ enableSteal: false });
    expect(toolNames(deps.tools)).toEqual(new Set(["sticker_send", "sticker_categories", "sticker_search"]));
    expect(deps.tools.map((tool) => tool.description).join("\n")).not.toContain("sticker_steal");
    expect(toolByName(deps.tools, "sticker_search").description).toContain("必须调用 sticker_send");
    expect(toolByName(deps.tools, "sticker_search").description).not.toContain("<sticker");

    const sendResult = await execute(toolByName(deps.tools, "sticker_send"), {});
    expect(deps.sender.send).toHaveBeenCalledWith({ bytes: pngBytes, mediaType: "image/png" });
    expect(deps.store.markUsed).toHaveBeenCalledWith("global", "a".repeat(64));
    expect(sendResult).toMatchObject({ ok: true, category: "meme" });

    deps.store.listCategories.mockResolvedValue([{ category: "meme", count: 1 }]);
    const categoriesResult = await execute(toolByName(deps.tools, "sticker_categories"), {});
    expect(categoriesResult).toMatchObject({ ok: true, categories: [{ category: "meme", count: 1 }] });

    const searchResult = await execute(toolByName(deps.tools, "sticker_search"), { category: "meme" });
    expect(deps.store.search).toHaveBeenCalledWith("global", { category: "meme" });
    expect(searchResult).toMatchObject({ ok: true, stickers: [{ id: "a".repeat(64), category: "meme" }] });
  });

  it("keeps the tagMode tool set unchanged when stealing is disabled", () => {
    const { tools } = createDeps({ enableSteal: false, tagMode: true });
    expect(toolNames(tools)).toEqual(new Set(["sticker_send", "sticker_categories", "sticker_search", "sticker_tags"]));
  });

  it("exposes sticker_tags only in experimental tag mode", () => {
    const disabled = createDeps();
    expect(disabled.tools.some((tool) => tool.name === "sticker_tags")).toBe(false);

    const enabled = createDeps({ tagMode: true });
    expect(enabled.tools.some((tool) => tool.name === "sticker_tags")).toBe(true);
  });

  it("sticker_steal reads the asset and saves with classified category", async () => {
    const deps = createDeps();
    const [tool] = deps.tools;
    const result = await execute(tool, { asset_id: "a".repeat(32) });
    expect(deps.assets.get).toHaveBeenCalledWith("a".repeat(32));
    expect(deps.classifier.classify).toHaveBeenCalled();
    expect(deps.store.save).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: "global", category: "meme", mediaType: "image/png" }));
    expect(result).toMatchObject({ ok: true, status: "created", id: "a".repeat(64) });
  });

  it("sticker_steal auto-tags the classified category in tag mode", async () => {
    const deps = createDeps({ tagMode: true });
    const [tool] = deps.tools;
    const result = await execute(tool, { asset_id: "a".repeat(32) });
    expect(deps.store.save).toHaveBeenCalledWith(expect.objectContaining({ tags: ["meme", "搞笑"] }));
    expect(result).toMatchObject({ ok: true, tags: ["meme", "搞笑"] });
  });

  it("sticker_steal skips classifier and save for an existing sticker", async () => {
    const deps = createDeps({ tagMode: true });
    deps.store.get.mockResolvedValue(projection({ id: "a".repeat(64), category: "meme", tags: ["meme"] }));
    const [tool] = deps.tools;

    const result = await execute(tool, { asset_id: "a".repeat(32) });

    expect(deps.classifier.classify).not.toHaveBeenCalled();
    expect(deps.store.save).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, status: "duplicate", id: "a".repeat(64) });
  });

  it("sticker_send with fuzzy tags scores multiple tag matches on one sticker", async () => {
    const deps = createDeps({ tagMode: true, tagRandomRange: 0 });
    deps.store.listByScopeKey.mockResolvedValue([
      projection({ id: "a".repeat(64), tags: ["可爱猫猫", "工作"] }),
      projection({ id: "b".repeat(64), tags: ["猫"] }),
    ]);
    const [, sendTool] = deps.tools;
    const result = await execute(sendTool, { tags: ["猫", "可爱"] });
    expect(deps.store.listByScopeKey).toHaveBeenCalledWith("global");
    expect(deps.sender.send).toHaveBeenCalledWith({ bytes: pngBytes, mediaType: "image/png" });
    expect(deps.store.markUsed).toHaveBeenCalledWith("global", "a".repeat(64));
    expect(result).toMatchObject({ ok: true, tags: ["可爱猫猫", "工作"] });
  });

  it("sticker_send tag random range can include lower-scoring matches", async () => {
    const deps = createDeps({ tagMode: true, tagRandomRange: 1 });
    deps.store.listByScopeKey.mockResolvedValue([
      projection({ id: "a".repeat(64), tags: ["可爱猫猫", "工作"] }),
      projection({ id: "b".repeat(64), tags: ["可爱"] }),
    ]);
    const [, sendTool] = deps.tools;
    const random = vi.spyOn(Math, "random").mockReturnValue(0.99);

    try {
      await execute(sendTool, { tags: ["猫", "可爱"] });
    } finally {
      random.mockRestore();
    }

    expect(deps.store.markUsed).toHaveBeenCalledWith("global", "b".repeat(64));
  });

  it("sticker_send with one fuzzy tag can match multiple stickers", async () => {
    const deps = createDeps({ tagMode: true });
    const first = projection({ id: "a".repeat(64), tags: ["猫猫"] });
    const second = projection({ id: "b".repeat(64), tags: ["猫"] });
    deps.store.listByScopeKey.mockResolvedValue([first, second]);
    const [, sendTool] = deps.tools;

    await execute(sendTool, { tags: ["猫"] });

    expect(deps.sender.send).toHaveBeenCalledOnce();
    expect(deps.store.markUsed).toHaveBeenCalledWith("global", expect.stringMatching(/^(a{64}|b{64})$/));
  });

  it("sticker_send keeps exact tag matching when fuzzy matching is disabled", async () => {
    const deps = createDeps({ tagMode: true, fuzzyTagMatch: false });
    deps.store.listByScopeKey.mockResolvedValue([projection({ id: "a".repeat(64), tags: ["猫猫"] }), projection({ id: "b".repeat(64), tags: ["猫"] })]);
    const [, sendTool] = deps.tools;

    const result = await execute(sendTool, { tags: ["猫"] });

    expect(deps.store.markUsed).toHaveBeenCalledWith("global", "b".repeat(64));
    expect(result).toMatchObject({ ok: true, tags: ["猫"] });
  });

  it("sticker_send sends the selected sticker and records usage", async () => {
    const deps = createDeps();
    deps.store.get.mockResolvedValue(projection());
    const sendTool = toolByName(deps.tools, "sticker_send");
    const result = await execute(sendTool, { sticker_id: "a".repeat(64) });
    expect(deps.sender.send).toHaveBeenCalledWith({ bytes: pngBytes, mediaType: "image/png" });
    expect(deps.store.markUsed).toHaveBeenCalledWith("global", "a".repeat(64));
    expect(result).toMatchObject({ ok: true, category: "meme" });
  });

  it("allows only one successful sticker send per turn", async () => {
    const deps = createDeps();
    const sendTool = toolByName(deps.tools, "sticker_send");

    const first = await execute(sendTool, {}, "turn-1");
    const second = await execute(sendTool, {}, "turn-1");

    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual({ ok: false, error: "sticker_send_limit_reached" });
    expect(deps.sender.send).toHaveBeenCalledOnce();
    expect(deps.store.markUsed).toHaveBeenCalledOnce();
  });

  it("allows sticker sends in different turns", async () => {
    const deps = createDeps();
    const sendTool = toolByName(deps.tools, "sticker_send");

    await execute(sendTool, {}, "turn-1");
    const second = await execute(sendTool, {}, "turn-2");

    expect(second).toMatchObject({ ok: true });
    expect(deps.sender.send).toHaveBeenCalledTimes(2);
    expect(deps.store.markUsed).toHaveBeenCalledTimes(2);
  });

  it("does not claim a turn when sticker sending fails", async () => {
    const deps = createDeps();
    deps.sender.send.mockRejectedValueOnce(new Error("send_failed"));
    const sendTool = toolByName(deps.tools, "sticker_send");

    const first = await execute(sendTool, {}, "turn-1");
    const second = await execute(sendTool, {}, "turn-1");

    expect(first).toEqual({ ok: false, error: "send_failed" });
    expect(second).toMatchObject({ ok: true });
    expect(deps.sender.send).toHaveBeenCalledTimes(2);
    expect(deps.store.markUsed).toHaveBeenCalledOnce();
  });

  it("claims a turn before usage accounting completes", async () => {
    const deps = createDeps();
    deps.store.markUsed.mockRejectedValueOnce(new Error("usage_failed"));
    const sendTool = toolByName(deps.tools, "sticker_send");

    const first = await execute(sendTool, {}, "turn-1");
    const second = await execute(sendTool, {}, "turn-1");

    expect(first).toEqual({ ok: false, error: "usage_failed" });
    expect(second).toEqual({ ok: false, error: "sticker_send_limit_reached" });
    expect(deps.sender.send).toHaveBeenCalledOnce();
    expect(deps.store.markUsed).toHaveBeenCalledOnce();
  });

  it("does not claim a turn when sticker selection fails", async () => {
    const deps = createDeps();
    deps.store.random.mockResolvedValueOnce(null);
    const sendTool = toolByName(deps.tools, "sticker_send");

    const first = await execute(sendTool, {}, "turn-1");
    const second = await execute(sendTool, {}, "turn-1");

    expect(first).toEqual({ ok: false, error: "sticker_not_found" });
    expect(second).toMatchObject({ ok: true });
    expect(deps.sender.send).toHaveBeenCalledOnce();
  });

  it("sticker_send converts a static PNG to a single-frame GIF", async () => {
    const deps = createDeps({ sendStaticAsGif: true });
    deps.store.get.mockResolvedValue(projection({ id: "a".repeat(64), mime: "image/png" }));
    const png = new PNG({ width: 1, height: 1 });
    png.data.set([255, 0, 0, 255]);
    deps.store.readBytes.mockResolvedValue(new Uint8Array(PNG.sync.write(png)));
    const [, sendTool] = deps.tools;

    await execute(sendTool, { sticker_id: "a".repeat(64) });

    expect(deps.sender.send).toHaveBeenCalledWith({ bytes: expect.any(Uint8Array), mediaType: "image/gif" });
  });

  it("sticker_categories returns category summaries", async () => {
    const deps = createDeps();
    deps.store.listCategories.mockResolvedValue([{ category: "meme", count: 2 }]);
    const [, , categoriesTool] = deps.tools;
    const result = await execute(categoriesTool, {});
    expect(result).toMatchObject({ ok: true, categories: [{ category: "meme", count: 2 }] });
  });

  it("sticker_tags returns tag summaries in tag mode", async () => {
    const deps = createDeps({ tagMode: true });
    deps.store.listTags.mockResolvedValue([{ tag: "猫猫", count: 2 }]);
    const tagsTool = deps.tools.find((tool) => tool.name === "sticker_tags");
    const result = await execute(tagsTool!, {});
    expect(result).toMatchObject({ ok: true, tags: [{ tag: "猫猫", count: 2 }] });
  });
});
