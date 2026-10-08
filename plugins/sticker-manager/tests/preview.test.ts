import { createToolMessage } from "@yesimbot/agent-runtime";
import { GifWriter } from "omggif";
import { describe, expect, it, vi } from "vitest";

import { createDeps, pngBytes, sticker, stickerId } from "./preview-fixtures.js";

const context = (messages: unknown[] = [], signal?: AbortSignal) => ({ toolCallId: "preview-call", turnId: "turn-1", messages, abortSignal: signal }) as never;

describe("sticker content preview", () => {
  it("can preview category entries past the search page limit", async () => {
    const deps = createDeps();
    const candidates = Array.from({ length: 60 }, (_, index) => sticker({ id: String(index).padStart(64, "0") }));
    deps.store.listCategory.mockResolvedValue(candidates);
    const output = await deps.preview.execute({ category: "meme", index: 51 }, context());
    expect(output).toMatchObject({ ok: true, id: candidates[50]!.id });
    expect(deps.store.listCategory).toHaveBeenCalledWith("global", "meme");
    expect(deps.store.search).not.toHaveBeenCalled();
    deps.projection.clearAll();
  });

  it("native output contains real bytes but execute result contains only metadata", async () => {
    const deps = createDeps();
    const output = await deps.preview.execute({ sticker_id: stickerId }, context());
    expect(output).toMatchObject({ ok: true, mode: "native", previewed: true });
    expect(JSON.stringify(output)).not.toContain(Buffer.from(pngBytes).toString("base64"));
    const projected = await deps.preview.toModelOutput!({ toolCallId: "preview-call", input: {}, output });
    expect(projected).toMatchObject({ type: "content", value: expect.arrayContaining([expect.objectContaining({ type: "image-data" })]) });
    expect(deps.store.markUsed).not.toHaveBeenCalled();
    expect(deps.sender.send).not.toHaveBeenCalled();
    // Same-step callers have no prior result even if preview execute already completed.
    expect(await deps.execute(deps.tool("sticker_send"), { sticker_id: stickerId })).toMatchObject({ error: "sticker_preview_required" });
    deps.messages.push(createToolMessage([{ type: "tool-result", toolName: "sticker_preview", toolCallId: "preview-call", output: projected }]));
    expect(await deps.execute(deps.tool("sticker_send"), { sticker_id: stickerId })).toMatchObject({ ok: true });
    deps.projection.clearAll();
  });

  it("expiry before materialization is an explicit failure, not visual evidence", async () => {
    const deps = createDeps();
    const output = await deps.preview.execute({}, context());
    deps.projection.clearAll();
    const projected = await deps.preview.toModelOutput!({ toolCallId: "preview-call", input: {}, output });
    expect(projected).toEqual({ type: "json", value: { ok: false, error: "sticker_preview_expired" } });
    deps.messages.push(createToolMessage([{ type: "tool-result", toolName: "sticker_preview", toolCallId: "preview-call", output: projected }]));
    expect(await deps.execute(deps.tool("sticker_send"), { sticker_id: stickerId })).toMatchObject({ error: "sticker_preview_required" });
  });

  it("TTL cleanup after materialization does not erase already-visible current-turn content", async () => {
    const deps = createDeps();
    await deps.view();
    deps.projection.clearAll();
    expect(await deps.execute(deps.tool("sticker_send"), { sticker_id: stickerId })).toMatchObject({ ok: true });
  });

  it("metadata or an unrelated tool receipt cannot forge proof", async () => {
    const deps = createDeps();
    const output = await deps.preview.execute({}, context());
    deps.messages.push(
      createToolMessage([{ type: "tool-result", toolName: "sticker_preview", toolCallId: "preview-call", output: { type: "json", value: output } }]),
    );
    expect(await deps.execute(deps.tool("sticker_send"), { sticker_id: stickerId })).toMatchObject({ error: "sticker_preview_required" });
    deps.projection.clearAll();
  });

  it("uses real vision descriptions when direct viewing is unavailable", async () => {
    const deps = createDeps({}, "vision");
    const output = await deps.view();
    expect(output).toMatchObject({ ok: true, mode: "description", description: "红色与蓝色的画面" });
    expect(deps.capability.describe).toHaveBeenCalledOnce();
    expect(deps.projection.has("preview-call")).toBe(false);
    expect(await deps.execute(deps.tool("sticker_send"), { sticker_id: stickerId })).toMatchObject({ ok: true });
  });

  it.each(["", "   "])("empty vision result %j is not evidence", async (text) => {
    const deps = createDeps({}, "vision");
    vi.mocked(deps.capability.describe).mockResolvedValue(text);
    expect(await deps.view()).toMatchObject({ ok: false });
    expect(await deps.execute(deps.tool("sticker_send"), { sticker_id: stickerId })).toMatchObject({ error: "sticker_preview_required" });
  });

  it("does not read or send when no image capability exists", async () => {
    const deps = createDeps({}, "unavailable");
    expect(await deps.view()).toMatchObject({ error: "image_input_unavailable" });
    expect(deps.store.readBytes).not.toHaveBeenCalled();
    expect(deps.sender.send).not.toHaveBeenCalled();
  });

  it("cleanup and new turns reject late vision completion", async () => {
    const deps = createDeps({}, "vision");
    let resolve!: (value: string) => void;
    vi.mocked(deps.capability.describe).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = deps.preview.execute({}, context());
    await vi.waitFor(() => expect(deps.capability.describe).toHaveBeenCalledOnce());
    deps.gate.clearTurn("turn-1");
    deps.gate.begin("turn-2");
    deps.gate.clearTurn("turn-2");
    resolve("late description");
    expect(await pending).toMatchObject({ error: "resource_read_aborted" });
    expect(deps.gate.resolve("turn-1", [])).toBeUndefined();
  });

  it("abort during vision does not record a late successful result", async () => {
    const deps = createDeps({}, "vision");
    const controller = new AbortController();
    vi.mocked(deps.capability.describe).mockImplementationOnce(async () => {
      controller.abort();
      return "late";
    });
    expect(await deps.preview.execute({}, context([], controller.signal))).toMatchObject({ error: "resource_read_aborted" });
    expect(deps.gate.resolve("turn-1", [])).toBeUndefined();
  });

  it("a second failed preview invalidates the previous target", async () => {
    const deps = createDeps();
    await deps.view();
    deps.store.random.mockResolvedValueOnce(null);
    expect(await deps.preview.execute({}, context())).toMatchObject({ error: "sticker_not_found" });
    expect(await deps.execute(deps.tool("sticker_send"), { sticker_id: stickerId })).toMatchObject({ error: "sticker_preview_required" });
    deps.projection.clearAll();
  });

  it("previews multiple GIF frames in both modes and sends original animation", async () => {
    const buffer = new Uint8Array(2048);
    const writer = new GifWriter(buffer, 2, 1, { palette: [0xff0000, 0x0000ff] });
    writer.addFrame(0, 0, 2, 1, [0, 0], { delay: 10 });
    writer.addFrame(1, 0, 1, 1, [1], { delay: 10 });
    const gif = buffer.slice(0, writer.end());
    for (const mode of ["native", "vision"] as const) {
      const deps = createDeps({}, mode);
      deps.store.get.mockResolvedValue(sticker({ mime: "image/gif", size: gif.length }));
      deps.store.readBytes.mockResolvedValue(gif);
      expect(await deps.view()).toMatchObject({ ok: true, frameCount: 2, totalFrames: 2, frames: ["frame 1/2, 0ms", "frame 2/2, 100ms"] });
      if (mode === "vision") expect(vi.mocked(deps.capability.describe).mock.calls[0]![0].frames).toHaveLength(2);
      await deps.execute(deps.tool("sticker_send"), { sticker_id: stickerId });
      expect(deps.sender.send).toHaveBeenCalledWith({ bytes: gif, mediaType: "image/gif" });
      deps.projection.clearAll();
    }
  });
});
