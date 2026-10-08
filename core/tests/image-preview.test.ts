import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), generateText: vi.fn() }));
import { generateText } from "ai";

import { createImagePreviewCapability } from "../src/agents/image-preview.js";

const frames = [{ bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png", label: "frame 1" }];
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Core plugin image preview capability", () => {
  it("uses the shared projection with the correct turn ownership", () => {
    const projection = new EphemeralImageProjectionStore();
    const capability = createImagePreviewCapability({ policy: { mode: "native" }, projection });
    expect(capability.preview({ frames, turnId: "turn", toolCallId: "call" })).toEqual({ mode: "native" });
    expect(projection.getFrames("call")).toHaveLength(1);
    projection.clearTurn("turn");
    expect(projection.has("call")).toBe(false);
  });

  it("never stages native bytes for an unavailable/vision-only route", () => {
    for (const mode of ["vision", "unavailable"] as const) {
      const projection = new EphemeralImageProjectionStore();
      const capability = createImagePreviewCapability({ policy: { mode }, projection });
      expect(capability.preview({ frames, turnId: "turn", toolCallId: "call" })).toMatchObject({ error: "image_input_unavailable" });
      expect(projection.has("call")).toBe(false);
    }
  });

  it("uses one bounded vision call for all sampled frames with labels", async () => {
    vi.mocked(generateText).mockResolvedValue({ text: "two frames" } as never);
    const capability = createImagePreviewCapability({ policy: { mode: "vision", visionModel: {} as never }, projection: new EphemeralImageProjectionStore() });
    expect(await capability.describe({ frames: [...frames, { ...frames[0]!, label: "frame 2" }], question: "what" })).toBe("two frames");
    const request = vi.mocked(generateText).mock.calls[0]![0];
    expect(request).toMatchObject({ maxRetries: 0, maxOutputTokens: 2048 });
    expect(JSON.stringify(request.messages)).toContain("frame 2");
    expect(vi.mocked(generateText)).toHaveBeenCalledOnce();
  });

  it("bounds waiting even when vision ignores cancellation", async () => {
    vi.useFakeTimers();
    vi.mocked(generateText).mockImplementation(() => new Promise(() => undefined));
    const capability = createImagePreviewCapability({
      policy: { mode: "vision", visionModel: {} as never },
      projection: new EphemeralImageProjectionStore(),
      timeoutMs: 20,
    });
    const result = capability.describe({ frames, question: "what" });
    await vi.advanceTimersByTimeAsync(21);
    expect(await result).toBeUndefined();
    expect(vi.mocked(generateText).mock.calls[0]![0].abortSignal?.aborted).toBe(true);
  });

  it("handles pre-abort and mid-call abort without results", async () => {
    const controller = new AbortController();
    vi.mocked(generateText).mockImplementation(() => new Promise(() => undefined));
    const capability = createImagePreviewCapability({ policy: { mode: "vision", visionModel: {} as never }, projection: new EphemeralImageProjectionStore() });
    const result = capability.describe({ frames, question: "what", signal: controller.signal });
    controller.abort();
    expect(await result).toBeUndefined();
    expect(await capability.describe({ frames, question: "what", signal: controller.signal })).toBeUndefined();
    expect(generateText).toHaveBeenCalledOnce();
  });

  it("rejects excessive frame counts and bounds returned descriptions", async () => {
    const capability = createImagePreviewCapability({ policy: { mode: "vision", visionModel: {} as never }, projection: new EphemeralImageProjectionStore() });
    expect(await capability.describe({ frames: Array(7).fill(frames[0]), question: "what" })).toBeUndefined();
    expect(generateText).not.toHaveBeenCalled();
    vi.mocked(generateText).mockResolvedValue({ text: "x".repeat(10_000) } as never);
    expect((await capability.describe({ frames, question: "what" }))?.length).toBe(6000);
  });
});
