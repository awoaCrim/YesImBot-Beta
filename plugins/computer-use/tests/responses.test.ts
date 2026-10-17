import { describe, expect, it, vi } from "vitest";

import { createResponsesRequester, runResponsesComputerUse, type ResponsesRequester } from "../src/responses.js";
import type { ComputerDriver, ComputerScreenshot } from "../src/types.js";

const SCREENSHOT: ComputerScreenshot = { bytes: new Uint8Array([137, 80, 78, 71, 1]), mediaType: "image/png" };

function driver(): { driver: ComputerDriver; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => SCREENSHOT);
  return { driver: { execute, close: vi.fn(async () => undefined) }, execute };
}

describe("createResponsesRequester", () => {
  it("serializes the native computer tool and continuation id without exposing the API key in the body", async () => {
    const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      requests.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ id: "resp-1", output: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const requester = createResponsesRequester({ apiKey: "test-secret", baseURL: "https://fixture.invalid/v1", model: "computer-model", maxSteps: 3 }, fetcher);

    await requester.request("查看桌面", undefined, new AbortController().signal);
    await requester.request([], "resp-1", new AbortController().signal);

    expect(fetcher).toHaveBeenNthCalledWith(2, "https://fixture.invalid/v1/responses", expect.objectContaining({ method: "POST" }));
    expect(requests[0]?.body).toMatchObject({
      model: "computer-model",
      store: true,
      input: "查看桌面",
      tools: [{ type: "computer" }],
    });
    expect(requests[0]?.body).not.toHaveProperty("apiKey");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-secret");
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(requests[1]?.body).toMatchObject({ previous_response_id: "resp-1", input: [] });
  });
});

describe("runResponsesComputerUse", () => {
  it("executes structured actions and returns the verified screenshot to the continuation", async () => {
    const requests: Array<{ input: unknown; previousResponseId: string | undefined }> = [];
    const requester: ResponsesRequester = {
      request: vi.fn(async (input, previousResponseId) => {
        requests.push({ input, previousResponseId });
        if (requests.length === 1) {
          return { id: "resp-1", output: [{ type: "computer_call", id: "call-1", action: { type: "click", button: "left", x: 12, y: 30 } }] };
        }
        return { id: "resp-2", status: "completed", output_text: "打开并确认了页面。", output: [] };
      }),
    };
    const bound = driver();
    const result = await runResponsesComputerUse({ prompt: "打开页面", requester, driver: bound.driver, maxSteps: 3, signal: new AbortController().signal });

    expect(bound.execute).toHaveBeenCalledWith([{ type: "click", button: "left", x: 12, y: 30 }], expect.any(AbortSignal));
    expect(requests[0]).toMatchObject({ input: "打开页面", previousResponseId: undefined });
    expect(requests[1]).toMatchObject({ previousResponseId: "resp-1" });
    expect(requests[1]?.input).toMatchObject([
      {
        type: "computer_call_output",
        call_id: "call-1",
        output: { type: "computer_screenshot", detail: "original" },
      },
    ]);
    expect(result.result).toMatchObject({ ok: true, status: "completed", summary: "打开并确认了页面。", steps: 1 });
    expect(result.screenshot).toBe(SCREENSHOT);
  });

  it("does not execute a batch that carries a safety check", async () => {
    const bound = driver();
    const result = await runResponsesComputerUse({
      prompt: "付款",
      requester: {
        request: vi.fn(async () => ({
          id: "resp-1",
          output: [
            {
              type: "computer_call",
              call_id: "call-1",
              action: { type: "click", button: "left", x: 1, y: 1 },
              pending_safety_checks: [{ id: "safety-1", code: "financial", message: "payment" }],
            },
          ],
        })),
      },
      driver: bound.driver,
      maxSteps: 3,
      signal: new AbortController().signal,
    });

    expect(bound.execute).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({ ok: false, error: { code: "safety_check_required" }, safetyChecks: [{ id: "safety-1" }] });
  });

  it("stops at the configured step limit without retrying an unknown action result", async () => {
    const bound = driver();
    const request = vi.fn(async (_input: unknown, previousResponseId: string | undefined) => ({
      id: previousResponseId ? "resp-next" : "resp-1",
      output: [{ type: "computer_call", call_id: previousResponseId ? "call-2" : "call-1", action: { type: "wait" } }],
    }));
    const result = await runResponsesComputerUse({
      prompt: "等待",
      requester: { request },
      driver: bound.driver,
      maxSteps: 2,
      signal: new AbortController().signal,
    });

    expect(request).toHaveBeenCalledTimes(3);
    expect(bound.execute).toHaveBeenCalledTimes(2);
    expect(result.result).toMatchObject({ ok: false, error: { code: "step_limit" }, steps: 2 });
  });
});
