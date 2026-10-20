import { describe, expect, it, vi } from "vitest";

import { createResponsesRequester, runResponsesComputerUse, type ResponseInputItem, type ResponsesRequester } from "../src/responses.js";
import type { ComputerDriver, ComputerScreenshot } from "../src/types.js";

const SCREENSHOT: ComputerScreenshot = { bytes: new Uint8Array([137, 80, 78, 71, 1]), mediaType: "image/png" };

function driver(): { driver: ComputerDriver; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => SCREENSHOT);
  return { driver: { execute, close: vi.fn(async () => undefined) }, execute };
}

function call(name: string, args: Record<string, unknown>, callId = "call-1"): unknown {
  return { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) };
}

describe("createResponsesRequester", () => {
  it("sends stateless function tools and the replayed history without leaking the API key", async () => {
    const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      requests.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ id: "resp-1", output: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const requester = createResponsesRequester({ apiKey: "test-secret", baseURL: "https://fixture.invalid/v1", model: "vision-model", maxSteps: 3 }, fetcher);

    await requester.request([{ role: "user", content: [{ type: "input_text", text: "查看桌面" }] }], new AbortController().signal);

    expect(fetcher).toHaveBeenCalledWith("https://fixture.invalid/v1/responses", expect.objectContaining({ method: "POST" }));
    const body = requests[0]?.body as { model: string; store: boolean; tools: Array<{ type: string; name: string }>; input: unknown };
    expect(body.model).toBe("vision-model");
    expect(body.store).toBe(false);
    expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "查看桌面" }] }]);
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body.tools.every((tool) => tool.type === "function")).toBe(true);
    expect(body.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["desktop_click", "desktop_move", "desktop_type", "desktop_key", "desktop_scroll", "request_confirmation"]),
    );
    expect(body).not.toHaveProperty("apiKey");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-secret");
  });

  it("surfaces the provider status and message while redacting secrets", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: { message: "Unsupported tool type: computer (key sk-abcdefgh1234)", code: "bad_request" } }), { status: 400 }),
    );
    const requester = createResponsesRequester({ apiKey: "sk-abcdefgh1234", baseURL: "https://fixture.invalid/v1", model: "m", maxSteps: 1 }, fetcher);

    await expect(requester.request([], new AbortController().signal)).rejects.toThrow(/HTTP 400: Unsupported tool type: computer .* \| bad_request/);
    await expect(requester.request([], new AbortController().signal)).rejects.not.toThrow(/abcdefgh1234/);
  });
});

describe("runResponsesComputerUse", () => {
  it("captures a starting screenshot, replays actions and returns the verified summary", async () => {
    const requests: Array<readonly ResponseInputItem[]> = [];
    const requester: ResponsesRequester = {
      request: vi.fn(async (input) => {
        requests.push(input);
        if (requests.length === 1) {
          return { status: "completed", output: [call("desktop_click", { x: 12, y: 30 })] };
        }
        return { status: "completed", output: [], output_text: "打开并确认了页面。" };
      }),
    };
    const bound = driver();
    const result = await runResponsesComputerUse({ prompt: "打开页面", requester, driver: bound.driver, maxSteps: 3, signal: new AbortController().signal });

    expect(bound.execute).toHaveBeenNthCalledWith(1, [], expect.any(AbortSignal));
    expect(bound.execute).toHaveBeenNthCalledWith(2, [{ type: "click", button: "left", x: 12, y: 30 }], expect.any(AbortSignal));
    expect(requests[0]?.[0]).toMatchObject({ role: "user" });
    expect(requests[1]).toHaveLength(4);
    expect(requests[1]?.[1]).toMatchObject({ type: "function_call", call_id: "call-1", name: "desktop_click" });
    expect(requests[1]?.[2]).toMatchObject({ type: "function_call_output", call_id: "call-1" });
    expect(result.result).toMatchObject({ ok: true, status: "completed", summary: "打开并确认了页面。", steps: 2 });
    expect(result.screenshot).toBe(SCREENSHOT);
  });

  it("stops without executing anything when the model asks for confirmation", async () => {
    const bound = driver();
    const result = await runResponsesComputerUse({
      prompt: "付款",
      requester: {
        request: vi.fn(async () => ({ status: "completed", output: [call("request_confirmation", { reason: "支付 2399 元" })] })),
      },
      driver: bound.driver,
      maxSteps: 3,
      signal: new AbortController().signal,
    });

    expect(bound.execute).toHaveBeenCalledTimes(1);
    expect(bound.execute).toHaveBeenCalledWith([], expect.any(AbortSignal));
    expect(result.result).toMatchObject({
      ok: false,
      error: { code: "safety_check_required" },
      safetyChecks: [{ id: "call-1", code: "confirmation_requested", message: "支付 2399 元" }],
    });
  });

  it("rejects an invalid tool call without touching the desktop", async () => {
    const bound = driver();
    const result = await runResponsesComputerUse({
      prompt: "点击",
      requester: { request: vi.fn(async () => ({ status: "completed", output: [call("desktop_click", { x: -5, y: 10 })] })) },
      driver: bound.driver,
      maxSteps: 2,
      signal: new AbortController().signal,
    });

    expect(bound.execute).toHaveBeenCalledTimes(1);
    expect(result.result).toMatchObject({ ok: false, error: { code: "invalid_response" } });
  });

  it("stops at the configured step limit without retrying an unknown action result", async () => {
    const bound = driver();
    const request = vi.fn(async () => ({ status: "completed", output: [call("desktop_wait", {}, "call-2")] }));
    const result = await runResponsesComputerUse({
      prompt: "等待",
      requester: { request },
      driver: bound.driver,
      maxSteps: 2,
      signal: new AbortController().signal,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(bound.execute).toHaveBeenCalledTimes(3);
    expect(result.result).toMatchObject({ ok: false, error: { code: "step_limit" }, steps: 2 });
  });

  it("keeps the replayed history bounded to the executed steps", async () => {
    const requests: Array<readonly ResponseInputItem[]> = [];
    const requester: ResponsesRequester = {
      request: vi.fn(async (input) => {
        requests.push(input);
        return requests.length < 3
          ? { status: "completed", output: [call("desktop_screenshot", {}, `call-${requests.length}`)] }
          : { status: "completed", output: [] };
      }),
    };
    const bound = driver();
    await runResponsesComputerUse({ prompt: "截图", requester, driver: bound.driver, maxSteps: 4, signal: new AbortController().signal });

    // 1 user turn per step plus a function call and its output per executed step.
    expect(requests.map((input) => input.length)).toEqual([1, 4, 7]);
  });

  it("keeps only the latest screenshot after the replay window is full", async () => {
    const requests: Array<readonly ResponseInputItem[]> = [];
    const requester: ResponsesRequester = {
      request: vi.fn(async (input) => {
        requests.push(input);
        return requests.length < 8
          ? { status: "completed", output: [call("desktop_screenshot", {}, `call-${requests.length}`)] }
          : { status: "completed", output: [] };
      }),
    };
    const bound = driver();
    await runResponsesComputerUse({ prompt: "截图", requester, driver: bound.driver, maxSteps: 8, signal: new AbortController().signal });

    expect(requests[7]).toHaveLength(13);
    const screenshots = requests[7]!.flatMap((item) =>
      "role" in item && item.role === "user" ? item.content.filter((part) => part.type === "input_image") : [],
    );
    expect(screenshots).toHaveLength(1);
    expect(JSON.stringify(requests[7])).toContain("Earlier screenshots were omitted");
  });
});
