import { describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));
import { GifReader } from "omggif";

import type { StickerStore } from "../src/store.js";
import { pickBestTaggedSticker, stickerSendMessageBlockReason } from "../src/tools.js";
import { createDeps, pngBytes, sticker, stickerId } from "./preview-fixtures.js";

async function send(deps: ReturnType<typeof createDeps>, input = { sticker_id: stickerId }) {
  return deps.execute(deps.tool("sticker_send"), input);
}

describe("sticker agent tools", () => {
  it("keeps collection and tag switches independent of sending", () => {
    const deps = createDeps({ enableSteal: false, tagMode: true });
    expect(deps.tools.map((t) => t.name)).toEqual(["sticker_send", "sticker_categories", "sticker_search", "sticker_tags"]);
    expect(deps.tools.map((t) => t.description).join("\n")).not.toContain("sticker_steal");
    expect(createDeps().tools.some((t) => t.name === "sticker_steal")).toBe(true);
  });

  it("makes continuation explicit and keeps search metadata-only", () => {
    const deps = createDeps();
    const terminal = deps.tool("sticker_send").terminal;
    if (typeof terminal !== "function") throw new Error("missing terminal predicate");
    expect(terminal({ sticker_id: stickerId })).toBe(true);
    expect(terminal({ sticker_id: stickerId, continue: true })).toBe(false);
    expect(deps.tool("sticker_search").description).toContain("不支持 OR/AND");
    expect(deps.tool("sticker_search").description).toContain("不代表你已经看过");
  });

  it.each([{}, { category: "meme" }, { sticker_id: stickerId }])("rejects unread or blind sends %j", async (input) => {
    const deps = createDeps();
    await deps.execute(deps.tool("sticker_search"), {});
    expect(await deps.execute(deps.tool("sticker_send"), input)).toEqual({ ok: false, error: "sticker_preview_required" });
    expect(deps.sender.send).not.toHaveBeenCalled();
    expect(deps.store.random).not.toHaveBeenCalled();
  });

  it("sends exactly the viewed target and records usage", async () => {
    const deps = createDeps();
    expect(await deps.view({ category: "meme" })).toMatchObject({ ok: true, id: stickerId });
    expect(deps.store.random).toHaveBeenCalledWith("global", "meme");
    expect(deps.store.markUsed).not.toHaveBeenCalled();
    expect(await send(deps)).toMatchObject({ ok: true, id: stickerId });
    expect(deps.sender.send).toHaveBeenCalledWith({ bytes: pngBytes, mediaType: "image/png" });
    expect(deps.store.markUsed).toHaveBeenCalledWith("global", stickerId);
    expect(deps.store.random).toHaveBeenCalledOnce();
    deps.projection.clearAll();
  });

  it("rejects a different target and changed bytes", async () => {
    const deps = createDeps();
    await deps.view();
    expect(await send(deps, { sticker_id: "b".repeat(64) })).toMatchObject({ error: "sticker_preview_mismatch" });
    deps.store.readBytes.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    expect(await send(deps)).toMatchObject({ error: "sticker_preview_stale" });
    expect(deps.sender.send).not.toHaveBeenCalled();
    expect(await send(deps)).toMatchObject({ ok: true });
    deps.projection.clearAll();
  });

  it("blocks concurrent sends before sender is awaited", async () => {
    const deps = createDeps();
    await deps.view();
    const results = await Promise.all([send(deps), send(deps)]);
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true }), { ok: false, error: "sticker_send_limit_reached" }]));
    expect(deps.sender.send).toHaveBeenCalledOnce();
    expect(deps.store.markUsed).toHaveBeenCalledOnce();
    deps.projection.clearAll();
  });

  it("never retries ambiguous delivery", async () => {
    const deps = createDeps();
    await deps.view();
    deps.sender.send.mockRejectedValueOnce(new Error("transport failed"));
    expect(await send(deps)).toEqual({ ok: false, error: "sticker_delivery_uncertain" });
    expect(await send(deps)).toMatchObject({ error: "sticker_send_limit_reached" });
    expect(deps.sender.send).toHaveBeenCalledOnce();
    expect(deps.store.markUsed).not.toHaveBeenCalled();
    deps.projection.clearAll();
  });

  it("reports delivery honestly when usage accounting fails", async () => {
    const deps = createDeps();
    await deps.view();
    deps.store.markUsed.mockRejectedValueOnce(new Error("db failed"));
    expect(await send(deps)).toMatchObject({ ok: true, warning: "sticker_usage_update_failed" });
    expect(await send(deps)).toMatchObject({ error: "sticker_send_limit_reached" });
    deps.projection.clearAll();
  });

  it("requires a new view in a later turn", async () => {
    const deps = createDeps();
    await deps.view();
    await send(deps);
    deps.gate.clearTurn("turn-1");
    deps.slot.clearTurn("turn-1");
    expect(await deps.execute(deps.tool("sticker_send"), { sticker_id: stickerId }, "turn-2")).toMatchObject({ error: "sticker_preview_required" });
    await deps.view({ sticker_id: stickerId }, "turn-2");
    expect(await deps.execute(deps.tool("sticker_send"), { sticker_id: stickerId }, "turn-2")).toMatchObject({ ok: true });
    deps.projection.clearAll();
  });

  it("does not send when abort arrives during byte lookup", async () => {
    const deps = createDeps();
    await deps.view();
    const controller = new AbortController();
    deps.store.readBytes.mockImplementationOnce(async () => {
      controller.abort();
      return pngBytes;
    });
    expect(await deps.execute(deps.tool("sticker_send"), { sticker_id: stickerId }, "turn-1", controller.signal)).toMatchObject({
      error: "resource_read_aborted",
    });
    expect(deps.sender.send).not.toHaveBeenCalled();
    deps.projection.clearAll();
  });

  it("releases preflight failures but not delivery attempts", async () => {
    const deps = createDeps();
    await deps.view();
    deps.store.get.mockResolvedValueOnce(null);
    expect(await send(deps)).toMatchObject({ error: "sticker_not_found" });
    deps.store.readBytes.mockRejectedValueOnce(new Error("missing"));
    expect(await send(deps)).toMatchObject({ ok: false });
    expect(await send(deps)).toMatchObject({ ok: true });
    deps.projection.clearAll();
  });

  it("still converts static art to GIF only on delivery", async () => {
    const deps = createDeps({ sendStaticAsGif: true });
    await deps.view();
    await send(deps);
    const sent = vi.mocked(deps.sender.send).mock.calls[0]![0] as unknown as { bytes: Uint8Array; mediaType: string };
    expect(sent.mediaType).toBe("image/gif");
    expect(new GifReader(sent.bytes).numFrames()).toBe(1);
    deps.projection.clearAll();
  });

  it("preserves collection classification and duplicate handling", async () => {
    const deps = createDeps({ tagMode: true });
    deps.store.get.mockResolvedValueOnce(null);
    expect(await deps.execute(deps.tool("sticker_steal"), { asset_id: "a".repeat(32) })).toMatchObject({ ok: true, status: "created" });
    expect(deps.store.save).toHaveBeenCalledWith(expect.objectContaining({ tags: ["meme", "搞笑"] }));
    expect(await deps.execute(deps.tool("sticker_steal"), { asset_id: "a".repeat(32) })).toMatchObject({ status: "duplicate" });
    expect(deps.store.save).toHaveBeenCalledOnce();
  });

  it("preserves manual collection and invalid/missing asset behavior", async () => {
    const deps = createDeps();
    deps.store.get.mockResolvedValueOnce(null);
    await deps.execute(deps.tool("sticker_steal"), { asset_id: "a".repeat(32), category: "manual" });
    expect(deps.classifier.classify).not.toHaveBeenCalled();
    expect(deps.store.save).toHaveBeenCalledWith(expect.objectContaining({ category: "manual" }));
    expect(await deps.execute(deps.tool("sticker_steal"), { asset_id: "bad" })).toMatchObject({ error: "invalid_asset_id" });
    deps.assets.get.mockRejectedValueOnce(new Error("gone"));
    expect(await deps.execute(deps.tool("sticker_steal"), { asset_id: "a".repeat(32) })).toMatchObject({ error: "asset_not_found" });
  });

  it("preserves categories and search without incrementing usage", async () => {
    const deps = createDeps({ enableSteal: false });
    expect(await deps.execute(deps.tool("sticker_categories"), {})).toMatchObject({ categories: [{ category: "meme", count: 1 }] });
    expect(await deps.execute(deps.tool("sticker_search"), { category: "meme" })).toMatchObject({ stickers: [{ id: stickerId }] });
    expect(deps.store.markUsed).not.toHaveBeenCalled();
  });

  it("retains fuzzy/exact tag selection and random score range for preview", async () => {
    const deps = createDeps({ tagMode: true });
    const a = sticker({ tags: ["可爱猫猫", "工作"] });
    const b = sticker({ id: "b".repeat(64), tags: ["猫"] });
    deps.store.listByScopeKey.mockResolvedValue([a, b]);
    const store = deps.store as unknown as StickerStore;
    expect(await pickBestTaggedSticker(store, "global", ["猫", "可爱"], undefined, true, 0)).toEqual(a);
    expect(await pickBestTaggedSticker(store, "global", ["猫"], undefined, false, 0)).toEqual(b);
    const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
    try {
      expect(await pickBestTaggedSticker(store, "global", ["猫", "可爱"], undefined, true, 1)).toEqual(b);
    } finally {
      random.mockRestore();
    }
  });

  it.each([
    '<text><sticker id="example"/></text>',
    '<text><img src="artifact://sticker/id"/></text>',
    '<inner_thought><sticker id="example"/></inner_thought>visible text',
  ])("allows literal or stripped sticker examples %s", (message) => {
    expect(stickerSendMessageBlockReason({ messages: [message] })).toBeUndefined();
  });

  it.each([
    '<img src="artifact://sticker/id"/>',
    '<file src="artifact://sticker/id"/>',
    '<message><img src="artifact&#58;//sticker/id"/></message>',
    '<sticker id="a"/>',
  ])("blocks the legacy delivery bypass %s", (message) => {
    expect(stickerSendMessageBlockReason({ messages: [message] })).toBe("sticker_send_required");
    expect(stickerSendMessageBlockReason({ messages: [message], mode: "raw" })).toBeUndefined();
  });
});
