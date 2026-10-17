import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import { describe, expect, it, vi } from "vitest";

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
      maxSteps: 3,
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
      maxSteps: 3,
      timeoutMs: 10_000,
    });
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute({ task: "不要执行" }, { ...context(), abortSignal: controller.signal } as never);
    expect(result).toMatchObject({ ok: false, error: { code: "aborted", retryable: false } });
    expect(driverFactory).not.toHaveBeenCalled();
  });
});
