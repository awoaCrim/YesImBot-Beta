import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import { describe, expect, it, vi } from "vitest";

import type { ResponsesRequester } from "../src/responses.js";
import { createComputerUseTool } from "../src/tool.js";
import type { ComputerDriver } from "../src/types.js";

const SCREENSHOT = { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" as const };

function context() {
  return { toolCallId: "computer-call", turnId: "turn-1", abortSignal: new AbortController().signal, messages: [] } as never;
}

describe("computer_use tool", () => {
  it("projects only the current turn screenshot into model output", async () => {
    const projection = new EphemeralImageProjectionStore();
    const driver: ComputerDriver = { execute: vi.fn(async () => SCREENSHOT), close: vi.fn(async () => undefined) };
    const tool = createComputerUseTool({
      imageProjection: projection,
      requester: {
        request: vi.fn(async (_input, previous) =>
          previous
            ? { id: "resp-2", status: "completed", output_text: "完成" }
            : { id: "resp-1", output: [{ type: "computer_call", call_id: "call-1", action: { type: "screenshot" } }] },
        ),
      },
      driverFactory: () => driver,
      timeoutMs: 10_000,
    });

    const result = await tool.execute({ task: "查看桌面" }, context());
    const modelOutput = tool.toModelOutput?.({ toolCallId: "computer-call", output: result } as never) as { value: Array<{ type: string; data?: string }> };

    expect(result).toMatchObject({ ok: true, status: "completed" });
    expect(modelOutput.value.map((part) => part.type)).toEqual(["text", "image-data"]);
    expect(modelOutput.value[1]?.data).toBe(Buffer.from(SCREENSHOT.bytes).toString("base64"));
    expect(driver.close).toHaveBeenCalledOnce();
    projection.clearAll();
  });

  it("returns a bounded failure when the execution signal is already aborted", async () => {
    const projection = new EphemeralImageProjectionStore();
    const driverFactory = vi.fn();
    const tool = createComputerUseTool({
      imageProjection: projection,
      requester: { request: vi.fn() },
      driverFactory,
      timeoutMs: 10_000,
    });
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute({ task: "不要执行" }, { ...context(), abortSignal: controller.signal } as never);
    expect(result).toMatchObject({ ok: false, error: { code: "aborted", retryable: false } });
    expect(driverFactory).not.toHaveBeenCalled();
  });

  it("still aborts an in-flight model request and closes the driver on timeout", async () => {
    vi.useFakeTimers();
    try {
      const driver: ComputerDriver = { execute: vi.fn(async () => SCREENSHOT), close: vi.fn(async () => undefined) };
      const request = vi.fn<ResponsesRequester["request"]>(
        (_input, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      );
      const tool = createComputerUseTool({
        imageProjection: new EphemeralImageProjectionStore(),
        requester: { request },
        driverFactory: () => driver,
        timeoutMs: 50,
      });

      const pending = tool.execute({ task: "等待页面" }, context());
      await vi.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "timeout", retryable: false } });
      expect(request).toHaveBeenCalledOnce();
      expect(driver.execute).toHaveBeenCalledOnce();
      expect(driver.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still propagates manual cancellation to the model request and closes the driver", async () => {
    const controller = new AbortController();
    const driver: ComputerDriver = { execute: vi.fn(async () => SCREENSHOT), close: vi.fn(async () => undefined) };
    const request = vi.fn<ResponsesRequester["request"]>(async (_input, signal) => {
      controller.abort();
      throw signal.reason;
    });
    const tool = createComputerUseTool({
      imageProjection: new EphemeralImageProjectionStore(),
      requester: { request },
      driverFactory: () => driver,
      timeoutMs: 10_000,
    });

    const result = await tool.execute({ task: "取消任务" }, { ...context(), abortSignal: controller.signal } as never);

    expect(result).toMatchObject({ ok: false, error: { code: "aborted", retryable: false } });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1].aborted).toBe(true);
    expect(driver.execute).toHaveBeenCalledOnce();
    expect(driver.close).toHaveBeenCalledOnce();
  });
});
