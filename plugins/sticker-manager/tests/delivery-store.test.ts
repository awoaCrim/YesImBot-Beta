import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));
import { StickerDeliveryService } from "../src/delivery.js";
import { StickerFileStore } from "../src/files.js";
import { StickerPreviewGate, StickerSendSlot } from "../src/preview-evidence.js";
import { StickerStore } from "../src/store.js";
import type { StickerRow } from "../src/types.js";
import { createMemoryModel } from "./helpers.js";
import { config, pngBytes, scope } from "./preview-fixtures.js";

describe("real Store transport boundary", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), "sticker-delivery-"));
    dirs.push(dir);
    const files = new StickerFileStore(dir, "data");
    const store = new StickerStore(createMemoryModel<StickerRow>() as never, files);
    await store.ensure();
    const save = (scopeKey = "global") => store.save({ scopeKey, bytes: pngBytes, mediaType: "image/png", category: "meme", source: { kind: "import" } });
    const saved = await save();
    const sendWithProof = vi.fn(async (): Promise<readonly string[]> => ["actual"]);
    const slot = new StickerSendSlot();
    const service = new StickerDeliveryService({
      store,
      sender: { send: async () => {}, sendWithProof },
      scope,
      config,
      sendSlot: slot,
      previewGate: new StickerPreviewGate(),
    });
    const preflight = () => service.preflight({ stickerId: saved.sticker.id, turnId: "turn" });
    const lease = async () => {
      const result = await preflight();
      if (!("lease" in result)) throw new Error(result.error);
      return result.lease;
    };
    return { store, files, save, sendWithProof, service, slot, preflight, lease, id: saved.sticker.id };
  }
  it("scope deletion revokes admission even when another scope keeps the file; reinsert never revives it", async () => {
    const f = await fixture();
    await f.save("other");
    const old = await f.lease();
    await f.store.deleteCategory("global", "meme");
    expect(await f.files.exists(f.id)).toBe(true);
    await f.save();
    expect(await old.send()).toMatchObject({ status: "failed" });
    expect(f.sendWithProof).not.toHaveBeenCalled();
    expect(await (await f.lease()).send()).toMatchObject({ status: "confirmed" });
  });
  it("network transport does not hold the queue; deletion after start keeps real IDs and truthful accounting warning", async () => {
    const f = await fixture();
    let done!: (ids: readonly string[]) => void;
    f.sendWithProof.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const lease = await f.lease();
    const pending = lease.send();
    await vi.waitFor(() => expect(f.sendWithProof).toHaveBeenCalledOnce());
    expect(await f.store.deleteCategory("global", "meme")).toMatchObject({ removed: 1, files: 1 });
    done(["real-id"]);
    expect(await pending).toMatchObject({ status: "confirmed", messageIds: ["real-id"], warning: "sticker_usage_update_failed" });
    expect(f.slot.status("turn")).toBe("consumed");
  });
  it("replacement by another valid PNG fails hash revalidation, not merely malformed-image parsing", async () => {
    const f = await fixture();
    const lease = await f.lease();
    const png = new PNG({ width: 1, height: 1 });
    png.data.set([0, 255, 0, 255]);
    await writeFile(join(f.files.directory, f.id), PNG.sync.write(png));
    expect(await lease.send()).toMatchObject({ status: "failed", error: "sticker_preview_stale" });
    expect(f.sendWithProof).not.toHaveBeenCalled();
  });
  it("bounded file reads enforce the actual byte cap and pre-abort without trusting row metadata", async () => {
    const f = await fixture();
    await expect(f.files.read(f.id, pngBytes.length - 1)).rejects.toThrow("sticker_too_large");
    expect(await f.files.read(f.id, pngBytes.length)).toEqual(pngBytes);
    const controller = new AbortController();
    controller.abort();
    await expect(f.files.read(f.id, pngBytes.length, controller.signal)).rejects.toThrow();
    expect(f.sendWithProof).not.toHaveBeenCalled();
  });
  it("row deletion reports irreversible DB effects even if final file cleanup fails", async () => {
    const f = await fixture();
    const lease = await f.lease();
    vi.spyOn(f.files, "remove").mockRejectedValueOnce(new Error("disk busy"));
    expect(await f.store.deleteCategory("global", "meme")).toEqual({ removed: 1, files: 0, warning: "sticker_file_cleanup_failed" });
    expect(await f.store.get("global", f.id)).toBeNull();
    expect(await f.files.exists(f.id)).toBe(true);
    expect(await lease.send()).toMatchObject({ status: "failed" });
  });
});
