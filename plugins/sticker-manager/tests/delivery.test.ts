import { createAssistantMessage } from "@yesimbot/agent-runtime";
import { describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));
import { StickerDeliveryService } from "../src/delivery.js";
import type { StickerStore } from "../src/store.js";
import { config, createDeps, pngBytes, scope, stickerId } from "./preview-fixtures.js";
function fixture() {
  const deps = createDeps();
  const sendWithProof = vi.fn(async (): Promise<readonly string[]> => ["actual-id"]);
  const service = new StickerDeliveryService({
    store: deps.store as unknown as StickerStore,
    sender: { send: deps.sender.send, sendWithProof },
    scope,
    config,
    sendSlot: deps.slot,
    previewGate: deps.gate,
  });
  const view = async () => {
    await deps.view();
    deps.messages.splice(
      deps.messages.length - 1,
      0,
      createAssistantMessage([{ type: "tool-call", toolName: "sticker_preview", toolCallId: "preview-call", input: { sticker_id: stickerId } }]),
    );
  };
  const preflight = (signal?: AbortSignal) => service.preflight({ stickerId, turnId: "turn-1", messages: deps.messages, signal });
  return { deps, service, sendWithProof, view, preflight };
}

describe("shared sticker delivery lease", () => {
  it("preflights actual bytes/preparation before any output; reservation and consumed quota are distinct", async () => {
    const f = fixture();
    await f.view();
    f.deps.store.readBytes.mockClear();
    const result = await f.preflight();
    expect("lease" in result).toBe(true);
    expect(f.deps.store.readBytes).toHaveBeenCalledOnce();
    expect(f.sendWithProof).not.toHaveBeenCalled();
    expect(f.service.status("turn-1")).toBe("reserved");
    if (!("lease" in result)) throw new Error("lease missing");
    expect(await result.lease.send()).toMatchObject({ status: "confirmed", messageIds: ["actual-id"] });
    expect(f.service.status("turn-1")).toBe("consumed");
    result.lease.release();
    expect(f.service.status("turn-1")).toBe("consumed");
    expect(await f.preflight()).toMatchObject({ error: "sticker_send_limit_reached" });
  });
  it("modern proof requires one earlier real call and completed result, not metadata/echo alone", async () => {
    const f = fixture();
    await f.deps.view();
    expect(await f.preflight()).toMatchObject({ error: "sticker_preview_required" });
    await f.view(); // Reset duplicated test receipts before a real modern pair.
    f.deps.messages.splice(0, 1);
    expect(await f.preflight()).toHaveProperty("lease");
  });
  it("same-step preview evidence is not usable before its result", async () => {
    const f = fixture();
    await f.view();
    f.deps.messages.pop();
    expect(await f.preflight()).toMatchObject({ error: "sticker_preview_required" });
    expect(f.sendWithProof).not.toHaveBeenCalled();
  });
  it("changed bytes fail before the phase's first output and release reservation", async () => {
    const f = fixture();
    await f.view();
    f.deps.store.readBytes.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    expect(await f.preflight()).toMatchObject({ error: "sticker_preview_stale" });
    expect(f.service.status("turn-1")).toBe("eligible");
    expect(f.sendWithProof).not.toHaveBeenCalled();
  });
  it("rechecks bytes and generation immediately before the sticker boundary", async () => {
    const f = fixture();
    await f.view();
    const result = await f.preflight();
    if (!("lease" in result)) throw new Error("missing lease");
    f.deps.store.readBytes.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    expect(await result.lease.send()).toMatchObject({ status: "failed", error: "sticker_preview_stale" });
    expect(f.service.status("turn-1")).toBe("eligible");
    expect(f.sendWithProof).not.toHaveBeenCalled();
  });
  it("old leases cannot release or transport through a replacement claim", async () => {
    const f = fixture();
    await f.view();
    const old = await f.preflight();
    if (!("lease" in old)) throw new Error("missing lease");
    f.deps.slot.clearTurn("turn-1");
    f.deps.gate.clearTurn("turn-1");
    f.deps.messages.splice(0);
    await f.view();
    const fresh = await f.preflight();
    if (!("lease" in fresh)) throw new Error("missing replacement");
    old.lease.release();
    expect(f.service.status("turn-1")).toBe("reserved");
    expect(await old.lease.send()).toMatchObject({ status: "failed" });
    expect(await fresh.lease.send()).toMatchObject({ status: "confirmed" });
    expect(f.sendWithProof).toHaveBeenCalledOnce();
  });
  it("retires an existing lease when provider/runtime permission changes during its byte read", async () => {
    const f = fixture();
    await f.view();
    let allowed = true;
    const result = await f.service.preflight({ stickerId, turnId: "turn-1", messages: f.deps.messages, stillAllowed: () => allowed });
    if (!("lease" in result)) throw new Error("missing lease");
    let resolve!: (bytes: typeof pngBytes) => void;
    const pendingBytes = new Promise<typeof pngBytes>((done) => {
      resolve = done;
    });
    f.deps.store.readBytes.mockImplementationOnce(async () => pendingBytes);
    const pending = result.lease.send();
    await vi.waitFor(() => expect(f.deps.store.readBytes).toHaveBeenCalledTimes(3));
    allowed = false;
    resolve(pngBytes);
    expect(await pending).toMatchObject({ status: "failed", messageIds: [] });
    expect(f.sendWithProof).not.toHaveBeenCalled();
    expect(f.deps.store.markUsed).not.toHaveBeenCalled();
    expect(f.service.status("turn-1")).toBe("eligible");
  });
  it("private views are exact-object and generation bound; late byte lookup cannot restore them", async () => {
    const f = fixture();
    await f.view();
    const view = await f.service.view("turn-1", f.deps.messages);
    expect(view?.frames?.length).toBeGreaterThan(0);
    expect(view && f.service.isViewCurrent(view, "turn-1")).toBe(true);
    expect(view && f.service.isViewCurrent({ ...view }, "turn-1")).toBe(false);
    expect(view && f.service.isViewCurrent(view, "other-turn")).toBe(false);
    f.deps.store.readBytes.mockImplementationOnce(async () => {
      f.deps.gate.begin("turn-1");
      return pngBytes;
    });
    expect(await f.service.view("turn-1", f.deps.messages)).toBeUndefined();
    expect(view && f.service.isViewCurrent(view, "turn-1")).toBe(false);
  });
  it("an empty native frame snapshot cannot authorize a modern expression view", async () => {
    const f = fixture();
    const ticket = f.deps.gate.begin("turn-1");
    const evidence = { stickerId, contentHash: "a".repeat(64), mediaType: "image/png", mode: "native" as const, toolCallId: "preview-call" };
    expect(f.deps.gate.record("turn-1", evidence, ticket)).toBe(true);
    expect(f.deps.gate.recordSnapshot("turn-1", { ...evidence, frames: [] }, ticket)).toBe(false);
    expect(f.deps.gate.snapshotFor(evidence)).toBeUndefined();
    expect(await f.service.view("turn-1", f.deps.messages)).toBeUndefined();
    expect(f.sendWithProof).not.toHaveBeenCalled();
  });
  it("confirm consumes the slot before fallible usage accounting", async () => {
    const f = fixture();
    await f.view();
    const result = await f.preflight();
    if (!("lease" in result)) throw new Error("missing lease");
    f.deps.store.markUsed.mockImplementationOnce(async () => {
      expect(f.service.status("turn-1")).toBe("consumed");
      throw new Error("db failed");
    });
    expect(await result.lease.send()).toMatchObject({ status: "confirmed", messageIds: ["actual-id"], warning: "sticker_usage_update_failed" });
    expect(await f.preflight()).toMatchObject({ error: "sticker_send_limit_reached" });
  });
  it.each([[], [""], ["same", "same"], ["with spaces"], ["x".repeat(513)]].map((ids) => ({ ids })))(
    "invalid platform IDs $ids consume uncertainty without usage",
    async ({ ids }) => {
      const f = fixture();
      await f.view();
      f.sendWithProof.mockResolvedValueOnce(ids);
      const result = await f.preflight();
      if (!("lease" in result)) throw new Error("missing lease");
      expect(await result.lease.send()).toMatchObject({ status: "uncertain", messageIds: [] });
      expect(f.deps.store.markUsed).not.toHaveBeenCalled();
      expect(await f.preflight()).toMatchObject({ error: "sticker_send_limit_reached" });
    },
  );
  it("legacy void send retains compatibility, modern void sender cannot invent IDs", async () => {
    const deps = createDeps();
    await deps.view();
    deps.messages.unshift(
      createAssistantMessage([{ type: "tool-call", toolName: "sticker_preview", toolCallId: "preview-call", input: { sticker_id: stickerId } }]),
    );
    const service = new StickerDeliveryService({
      store: deps.store as unknown as StickerStore,
      sender: deps.sender,
      scope,
      config,
      sendSlot: deps.slot,
      previewGate: deps.gate,
    });
    const lease = await service.preflight({ stickerId, turnId: "turn-1", messages: deps.messages });
    if (!("lease" in lease)) throw new Error("missing lease");
    expect(await lease.lease.send()).toMatchObject({ status: "uncertain", messageIds: [] });
    expect(deps.store.markUsed).not.toHaveBeenCalled();
  });
});
