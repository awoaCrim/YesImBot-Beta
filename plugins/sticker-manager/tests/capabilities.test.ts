import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAssistantMessage, createToolMessage, type AgentMessage } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));
import { StickerFileStore } from "../src/files.js";
import { StickerPreviewGate, StickerSendSlot } from "../src/preview-evidence.js";
import { StickerStore } from "../src/store.js";
import { createStickerTools } from "../src/tools.js";
import type { StickerConfig, StickerRow } from "../src/types.js";
import { createMemoryModel } from "./helpers.js";
import { config, pngBytes, scope, stickerId } from "./preview-fixtures.js";

const assetId = stickerId.slice(0, 32);
const uri = `asset://${assetId}`;
function readHistory(): AgentMessage[] {
  return [
    createAssistantMessage([{ type: "tool-call", toolName: "read", toolCallId: "read", input: { uri } }]),
    createToolMessage([
      {
        type: "tool-result",
        toolName: "read",
        toolCallId: "read",
        output: { type: "content", value: [{ type: "image-data", data: Buffer.from(pngBytes).toString("base64"), mediaType: "image/png" }] },
      },
    ]),
  ];
}

describe("scoped opt-in management and classified collection", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  async function fixture(overrides: Partial<StickerConfig> = {}) {
    const dir = await mkdtemp(join(tmpdir(), "sticker-capabilities-"));
    dirs.push(dir);
    const files = new StickerFileStore(dir, "data");
    const model = createMemoryModel<StickerRow>();
    const store = new StickerStore(model as never, files);
    await store.ensure();
    const effective = { ...config, enableManage: true, ...overrides };
    let current = true;
    const sender = { send: vi.fn(async () => {}) };
    const classifier = { classify: vi.fn(async () => ({ category: "unused", tags: [] })) };
    const assets = {
      get: vi.fn(async (id: string) => {
        if (id !== assetId) throw new Error("foreign");
        return pngBytes;
      }),
      put: vi.fn(async () => assetId),
      clear: vi.fn(async () => {}),
    };
    const slot = new StickerSendSlot();
    const tools = createStickerTools({
      store,
      classifier,
      sender,
      assets,
      scope,
      config: effective,
      previewGate: new StickerPreviewGate(),
      sendSlot: slot,
      captureTurn: () => () => current,
    });
    const execute = (name: string, input: unknown, messages = readHistory(), signal?: AbortSignal) =>
      tools.find((tool) => tool.name === name)!.execute(input, { toolCallId: "action", turnId: "turn", messages, abortSignal: signal } as never);
    const save = (scopeKey = "global", category = "imported") =>
      store.save({ scopeKey, category, bytes: pngBytes, mediaType: "image/png", tags: ["old"], source: { kind: "import" } });
    return {
      model,
      store,
      files,
      sender,
      classifier,
      assets,
      slot,
      tools,
      config: effective,
      execute,
      save,
      retire: () => {
        current = false;
      },
    };
  }
  it.each([false, true].flatMap((enableSteal) => [false, true].map((enableManage) => ({ enableSteal, enableManage }))))(
    "switches remain independent: $enableSteal/$enableManage",
    async (flags) => {
      const f = await fixture(flags);
      const names = f.tools.map((tool) => tool.name);
      expect(names.includes("sticker_steal")).toBe(flags.enableSteal);
      expect(names.includes("sticker_manage")).toBe(flags.enableManage);
      expect(names).toEqual(expect.arrayContaining(["sticker_send", "sticker_search", "sticker_categories"]));
      await f.save();
      expect(await f.execute("sticker_send", { sticker_id: stickerId }, [])).toMatchObject({ ok: true });
    },
  );
  it("move/rename/merge preserve ID, source, usage and tags, while current queries update immediately", async () => {
    const f = await fixture();
    await f.save();
    await f.store.markUsed("global", stickerId);
    expect(await f.execute("sticker_manage", { action: "move", sticker_id: stickerId, category: " moved " })).toMatchObject({
      ok: true,
      affected: 1,
      category: "moved",
    });
    expect(await f.execute("sticker_manage", { action: "rename_category", source_category: "moved", category: "renamed" })).toMatchObject({ affected: 1 });
    expect(await f.execute("sticker_manage", { action: "merge_category", source_category: "renamed", category: "target" })).toMatchObject({ affected: 1 });
    expect(await f.store.get("global", stickerId)).toMatchObject({
      id: stickerId,
      category: "target",
      tags: ["old"],
      source: { kind: "import" },
      usageCount: 1,
    });
    expect(await f.execute("sticker_categories", {})).toMatchObject({ categories: [{ category: "target", count: 1 }] });
    expect(f.slot.status("turn")).toBe("eligible");
  });
  it("single imported-record deletion is scoped, last-reference-only and reports cleanup failure", async () => {
    const f = await fixture();
    await f.save();
    await f.save("other");
    expect(await f.execute("sticker_manage", { action: "delete", sticker_id: stickerId })).toMatchObject({ ok: true, removed: 1, files: 0 });
    expect(await f.store.get("other", stickerId)).not.toBeNull();
    await f.save();
    await f.store.deleteSticker("other", stickerId);
    vi.spyOn(f.files, "remove").mockRejectedValueOnce(new Error("disk busy"));
    expect(await f.execute("sticker_manage", { action: "delete", sticker_id: stickerId })).toMatchObject({
      ok: true,
      removed: 1,
      files: 0,
      warning: "sticker_file_cleanup_failed",
    });
    expect(await f.store.get("global", stickerId)).toBeNull();
  });
  it.each([
    { action: "delete", sticker_id: [stickerId] },
    { action: "delete", sticker_id: "*" },
    { action: "delete", sticker_id: stickerId, confirmed: true },
    { action: "delete", category: "imported" },
    { action: "delete", sticker_id: stickerId, scope: "other" },
    { action: "delete_category", category: "imported" },
  ])("rejects destructive selector or authorization bypass %j", async (input) => {
    const f = await fixture();
    await f.save();
    expect(await f.execute("sticker_manage", input)).toMatchObject({ ok: false });
    expect(f.model.remove).not.toHaveBeenCalled();
  });
  it("missing/same category and not-found single operations are explicit", async () => {
    const f = await fixture();
    expect(await f.execute("sticker_manage", { action: "move", sticker_id: stickerId, category: "target" })).toMatchObject({ error: "sticker_not_found" });
    expect(await f.execute("sticker_manage", { action: "delete", sticker_id: stickerId })).toMatchObject({ error: "sticker_not_found" });
    expect(await f.execute("sticker_manage", { action: "rename_category", source_category: "missing", category: "target" })).toMatchObject({
      error: "category_not_found",
    });
    expect(await f.execute("sticker_manage", { action: "merge_category", source_category: "same", category: "same" })).toMatchObject({
      error: "category_unchanged",
    });
  });
  it("off/retired retained tools and retirement during scoped row lookup cannot mutate", async () => {
    const f = await fixture();
    await f.save();
    f.config.enableManage = false;
    expect(await f.execute("sticker_manage", { action: "delete", sticker_id: stickerId })).toMatchObject({ error: "StickerCapabilityRetired" });
    f.config.enableManage = true;
    f.model.get.mockImplementationOnce(async () => {
      f.retire();
      return [...f.model.tables.get("yesimbot_sticker")!];
    });
    expect(await f.execute("sticker_manage", { action: "delete", sticker_id: stickerId })).toMatchObject({ error: "StickerCapabilityRetired" });
    expect(f.model.remove).not.toHaveBeenCalled();
  });
  it("new classified collection works with management off; duplicates never secretly move or tag", async () => {
    const f = await fixture({ enableManage: false, tagMode: true });
    expect(await f.execute("sticker_steal", { asset_id: assetId, category: " happy ", tags: ["fun"] })).toMatchObject({
      ok: true,
      status: "created",
      id: stickerId,
      category: "happy",
      tags: ["happy", "fun"],
    });
    expect(await f.execute("sticker_steal", { asset_id: assetId, category: "different", tags: ["new"] })).toMatchObject({
      ok: true,
      status: "duplicate",
      category: "happy",
      tags: ["happy", "fun"],
    });
    expect(f.classifier.classify).not.toHaveBeenCalled();
    expect(f.slot.status("turn")).toBe("eligible");
    expect(await f.execute("sticker_search", { category: "happy" })).toMatchObject({ stickers: [{ id: stickerId }] });
    expect(await f.execute("sticker_send", { sticker_id: stickerId }, [])).toMatchObject({ ok: true });
  });
  it("old unclassified duplicate requires explicit management and retains its real ID/category", async () => {
    const f = await fixture();
    await f.save("global", "未分类");
    expect(await f.execute("sticker_steal", { asset_id: assetId, category: "happy" })).toMatchObject({
      ok: false,
      error: "classification_required",
      status: "duplicate",
      id: stickerId,
      category: "未分类",
    });
    expect(await f.execute("sticker_manage", { action: "move", sticker_id: stickerId, category: "happy" })).toMatchObject({ ok: true });
    expect(await f.execute("sticker_steal", { asset_id: assetId, category: "another" })).toMatchObject({ ok: true, status: "duplicate", category: "happy" });
  });
  it.each([undefined, "", " \n\t", "未分类", " 未分类 "])("rejects non-concrete collection category %j before reads", async (category) => {
    const f = await fixture();
    expect(await f.execute("sticker_steal", { asset_id: assetId, category })).toMatchObject({ error: "classification_required" });
    expect(f.assets.get).not.toHaveBeenCalled();
    expect(f.model.create).not.toHaveBeenCalled();
  });
  it("rejects foreign/mismatched/oversized/unsupported Assets and hidden tag input", async () => {
    const f = await fixture();
    const input = { asset_id: assetId, category: "happy" };
    expect(await f.execute("sticker_steal", { ...input, asset_id: "f".repeat(32) })).toMatchObject({ error: "asset_not_found" });
    expect(await f.execute("sticker_steal", { ...input, asset_id: uri })).toMatchObject({ error: "invalid_asset_id" });
    expect(await f.execute("sticker_steal", { ...input, tags: ["hidden"] })).toMatchObject({ error: "invalid_collection_input" });
    f.assets.get.mockResolvedValueOnce(new Uint8Array([...pngBytes, 0]));
    expect(await f.execute("sticker_steal", input)).toMatchObject({ error: "asset_identity_mismatch" });
    f.assets.get.mockResolvedValueOnce(new Uint8Array(5 * 1024 * 1024 + 1));
    expect(await f.execute("sticker_steal", input)).toMatchObject({ error: "resource_too_large" });
    f.assets.get.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    expect(await f.execute("sticker_steal", input)).toMatchObject({ error: "unsupported_image" });
    expect(f.model.create).not.toHaveBeenCalled();
  });
  it("metadata/sanitized/missing completed read requires reread; abort/retirement cannot commit", async () => {
    const f = await fixture();
    const input = { asset_id: assetId, category: "happy" };
    expect(await f.execute("sticker_steal", input, [])).toMatchObject({ error: "image_read_required" });
    expect(await f.execute("sticker_steal", input, readHistory().slice(0, 1))).toMatchObject({ error: "image_read_required" });
    const controller = new AbortController();
    controller.abort();
    expect(await f.execute("sticker_steal", input, readHistory(), controller.signal)).toMatchObject({ error: "resource_read_aborted" });
    vi.spyOn(f.files, "write").mockImplementationOnce(async () => {
      f.retire();
    });
    expect(await f.execute("sticker_steal", input)).toMatchObject({ error: "StickerCapabilityRetired" });
    expect(f.model.create).not.toHaveBeenCalled();
  });
});
