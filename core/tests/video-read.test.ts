import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EphemeralImageProjectionStore, EphemeralVideoProjectionStore } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));
import { createReadTool } from "../src/agents/tools.js";
import { ChannelResources, RESOURCE_MAX_BYTES, VIDEO_MAX_BYTES } from "../src/resources/index.js";
import * as compression from "../src/resources/video-compression.js";
import { PNG_BYTES } from "./helpers/index.js";
import { VIDEO_BYTES, paddedVideo, createVideoPolicy } from "./helpers/video.js";

const roots: string[] = [];
const stores: EphemeralVideoProjectionStore[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  stores.splice(0).forEach((store) => store.clearAll());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(enabled = true, native = true, ttlMs = 60_000) {
  const root = await mkdtemp(join(tmpdir(), "video-read-"));
  roots.push(root);
  const resources = new ChannelResources(root, false, 1000, enabled);
  const projection = new EphemeralVideoProjectionStore({ ttlMs });
  stores.push(projection);
  const tool = createReadTool(resources, false, new EphemeralImageProjectionStore(), { policy: createVideoPolicy(native), projection });
  const uri = "asset://" + (await resources.assets.put(VIDEO_BYTES));
  const execute = (callId = "read", turnId = "turn", abortSignal?: AbortSignal, readUri = uri) =>
    tool.execute({ uri: readUri }, { toolCallId: callId, turnId, messages: [], abortSignal } as never);
  return { resources, projection, tool, uri, execute };
}

describe("on-demand same-main video read", () => {
  it("stages only the compressed derivative and retains the original asset", async () => {
    const f = await fixture();
    const original = paddedVideo(VIDEO_MAX_BYTES + 8);
    const id = await f.resources.assets.put(original);
    const uri = "asset://" + id;
    const compress = vi.spyOn(compression, "prepareVideoForModel").mockResolvedValue(VIDEO_BYTES);
    const result = await f.execute("compressed", "turn", undefined, uri);
    expect(result).toMatchObject({ videoMode: "native", videoCompressed: true, sourceBytes: original.byteLength });
    expect(result.text).toContain("压缩版");
    expect(f.projection.get("compressed")?.bytes).toEqual(VIDEO_BYTES);
    expect((await f.resources.openVideoAssetStrict(uri)).bytes.byteLength).toBe(original.byteLength);
    expect((await f.execute("second", "turn", undefined, uri)).error).toBe("video_turn_limit");
    expect(compress).toHaveBeenCalledOnce();
  });

  it("refunds a failed compression reservation without staging oversized bytes", async () => {
    const f = await fixture();
    const uri = "asset://" + (await f.resources.assets.put(paddedVideo(VIDEO_MAX_BYTES + 8)));
    vi.spyOn(compression, "prepareVideoForModel")
      .mockRejectedValueOnce(new compression.VideoCompressionError("video_compression_unavailable"))
      .mockResolvedValue(VIDEO_BYTES);
    expect(await f.execute("failed", "turn", undefined, uri)).toMatchObject({ videoMode: "unavailable", error: "video_compression_unavailable" });
    expect(f.projection.has("failed")).toBe(false);
    expect(await f.execute("retry", "turn", undefined, uri)).toMatchObject({ videoMode: "native", videoCompressed: true });
  });

  it("rejects a late compression result after cancellation", async () => {
    const f = await fixture();
    const uri = "asset://" + (await f.resources.assets.put(paddedVideo(VIDEO_MAX_BYTES + 8)));
    let complete!: (bytes: Uint8Array) => void;
    const compress = vi.spyOn(compression, "prepareVideoForModel").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = f.execute("cancelled", "turn", controller.signal, uri);
    await vi.waitFor(() => expect(compress).toHaveBeenCalledOnce());
    controller.abort();
    complete(VIDEO_BYTES);
    expect(await pending).toMatchObject({ videoMode: "unavailable", error: "resource_read_aborted" });
    expect(f.projection.has("cancelled")).toBe(false);
  });

  it("returns only safe metadata durably, projecting actual file-data for the matching live call", async () => {
    const f = await fixture();
    const result = await f.execute();
    expect(result).toMatchObject({ uri: f.uri, mediaType: "video/mp4", videoMode: "native" });
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(Buffer.from(VIDEO_BYTES).toString("base64"));
    const output = await f.tool.toModelOutput!({ toolCallId: "read", input: { uri: f.uri }, output: result });
    expect(output.type).toBe("content");
    if (output.type !== "content") throw new Error("Expected native content");
    const files = output.value.filter((part) => part.type === "file-data");
    expect(files).toHaveLength(1);
    const video = files[0] as { data: string; mediaType: string };
    expect(video.mediaType).toBe("video/mp4");
    expect(createHash("sha256").update(Buffer.from(video.data, "base64")).digest("hex")).toBe(createHash("sha256").update(VIDEO_BYTES).digest("hex"));
    const repeat = await f.tool.toModelOutput!({ toolCallId: "read", input: { uri: f.uri }, output: result });
    expect(repeat).toEqual(output);
  });

  it.each([
    [false, true],
    [true, false],
  ])("fails closed for input=%s/native transport=%s without staging", async (enabled, native) => {
    const f = await fixture(enabled, native);
    const result = await f.execute();
    expect(result.videoMode).toBe("unavailable");
    expect(result.error).toBeTruthy();
    expect(f.projection.get("read")).toBeUndefined();
    const output = await f.tool.toModelOutput!({ toolCallId: "read", input: { uri: f.uri }, output: result });
    expect(JSON.stringify(output)).not.toContain(Buffer.from(VIDEO_BYTES).toString("base64"));
  });

  it("enforces one successful video per turn even after TTL, new/reused call IDs and concurrent reads", async () => {
    const f = await fixture(true, true, 50);
    vi.useFakeTimers();
    const first = await f.execute("first");
    expect(first.videoMode).toBe("native");
    await vi.advanceTimersByTimeAsync(51);
    const second = await f.execute("second");
    expect(second.error).toBeTruthy();
    expect(second.videoMode).toBe("unavailable");
    const reused = await f.execute("first");
    expect(reused.error).toBeTruthy();
    const next = await Promise.all([f.execute("a", "next"), f.execute("b", "next")]);
    expect(next.filter((result) => result.videoMode === "native")).toHaveLength(1);
    expect(next.filter((result) => !!result.error)).toHaveLength(1);
  });

  it("explicitly fails projection after expiration, never returns metadata pretending native viewing", async () => {
    const f = await fixture(true, true, 50);
    vi.useFakeTimers();
    const result = await f.execute();
    await vi.advanceTimersByTimeAsync(51);
    const output = await f.tool.toModelOutput!({ toolCallId: "read", input: { uri: f.uri }, output: result });
    expect(output.type).toBe("json");
    if (output.type !== "json") throw new Error("Expected explicit error");
    expect(output.value).toMatchObject({ videoMode: "unavailable", error: expect.any(String) });
  });

  it("pre-abort and abort after staging revoke new projections without consuming another turn", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect((await f.execute("pre", "pre", controller.signal)).error).toBe("resource_read_aborted");
    const running = new AbortController();
    const result = await f.execute("current", "turn", running.signal);
    expect(result.videoMode).toBe("native");
    running.abort();
    expect(f.projection.get("current")).toBeUndefined();
    const output = await f.tool.toModelOutput!({ toolCallId: "current", input: { uri: f.uri }, output: result });
    expect(JSON.stringify(output)).not.toContain(Buffer.from(VIDEO_BYTES).toString("base64"));
    expect((await f.execute("new", "new-turn")).videoMode).toBe("native");
  });

  it("rejects stale/cloned receipts after call-ID reuse even for the same asset in another turn", async () => {
    const f = await fixture();
    const old = await f.execute("reused", "old-turn");
    const current = await f.execute("reused", "new-turn");
    expect(current.videoMode).toBe("native");
    for (const receipt of [old, { ...current }]) {
      const output = await f.tool.toModelOutput!({ toolCallId: "reused", input: { uri: f.uri }, output: receipt });
      expect(output).toMatchObject({ type: "json", value: { error: "video_projection_unavailable" } });
    }
    const output = await f.tool.toModelOutput!({ toolCallId: "reused", input: { uri: f.uri }, output: current });
    expect(output.type).toBe("content");
  });

  it("refunds the per-turn reservation when staging fails, without claiming viewing", async () => {
    const f = await fixture();
    vi.spyOn(f.projection, "stage").mockReturnValueOnce(false);
    expect(await f.execute("failed")).toMatchObject({ videoMode: "unavailable", error: "video_projection_unavailable" });
    expect((await f.execute("retry")).videoMode).toBe("native");
    expect((await f.execute("third")).error).toBe("video_turn_limit");
  });

  it("uses the narrow >5MiB MP4 path but preserves ordinary oversize errors for images/text", async () => {
    const f = await fixture();
    const bigVideoUri = "asset://" + (await f.resources.assets.put(paddedVideo(RESOURCE_MAX_BYTES + 32)));
    const video = await f.execute("large", "large", undefined, bigVideoUri);
    expect(video.videoMode).toBe("native");
    for (const prefix of [PNG_BYTES, new TextEncoder().encode("plain text")]) {
      const bytes = new Uint8Array(RESOURCE_MAX_BYTES + 32);
      bytes.set(prefix);
      const uri = "asset://" + (await f.resources.assets.put(bytes));
      expect((await f.execute("not-video", "other", undefined, uri)).error).toBe("resource_too_large");
    }
  });
});
