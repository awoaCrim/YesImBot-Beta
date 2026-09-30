import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpenAI } from "@ai-sdk/openai";
import { EphemeralImageProjectionStore, type AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import { APICallError, NoImageGeneratedError } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { createSendMessageTool } from "../../../core/src/agents/tools.js";
import { ChannelResources, detectImageMediaType, RESOURCE_MAX_BYTES } from "../../../core/src/resources/index.js";
import { PNG_BYTES } from "../../../core/tests/helpers/index.js";
import { createGenerateImageTool } from "../src/image-generation.js";

const MODEL_ID = "configured-image-model";
const ARTIFACT_URI = "artifact://generate_image/018f1234-5678-7abc-8def-0123456789ab";
const roots: string[] = [];

function toolContext(signal?: AbortSignal): AgentToolExecuteContext {
  return {
    runtime: { id: "runtime" },
    channel: {} as never,
    state: {} as never,
    storage: {} as never,
    turnId: "turn-1",
    toolCallId: "generate-1",
    abortSignal: signal,
    messages: [],
  };
}

function createTool(overrides: Record<string, unknown> = {}) {
  const imageModel = { specificationVersion: "v3", provider: "fixture", modelId: MODEL_ID };
  const generate = vi.fn(async () => ({ images: [{ uint8Array: PNG_BYTES, mediaType: "image/png" }] }));
  const put = vi.fn(async () => ARTIFACT_URI);
  const forTool = vi.fn(() => ({ put }));
  const resources = { artifacts: { forTool }, maxBytes: RESOURCE_MAX_BYTES, detectImageMediaType };
  const imageProjection = new EphemeralImageProjectionStore();
  const tool = createGenerateImageTool({
    imageModel: imageModel as never,
    modelId: MODEL_ID,
    timeoutMs: 120_000,
    resources,
    generate,
    imageProjection,
    ...overrides,
  } as never);
  return { tool, imageModel, generate, put, forTool, imageProjection };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("generate_image tool", () => {
  it("exposes only prompt and orientation, generates one bounded image, and returns artifact metadata only", async () => {
    const { tool, imageModel, generate, put, forTool } = createTool();

    expect(tool.name).toBe("generate_image");
    const schema = JSON.stringify(tool.inputSchema);
    expect(schema).toContain('"prompt"');
    expect(schema).toContain('"orientation"');
    expect(schema).toContain('"square"');
    expect(schema).toContain('"landscape"');
    expect(schema).toContain('"portrait"');
    expect((JSON.parse(schema) as { jsonSchema: { properties: { prompt: { pattern: string } } } }).jsonSchema.properties.prompt.pattern).toBe(String.raw`\S`);
    for (const forbidden of ["quality", "seed", "style", "fallback", "model", "n", "channel", "referenceUri", "sourceUri", "prototype", "search"])
      expect(schema).not.toContain(`"${forbidden}"`);
    expect(tool.description).not.toContain("原型图");
    expect(tool.description).not.toContain("图片搜索");

    const result = await tool.execute({ prompt: "  A quiet lake at dawn  ", orientation: "landscape" }, toolContext());

    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith({
      model: imageModel,
      prompt: "A quiet lake at dawn",
      n: 1,
      size: "1536x1024",
      maxRetries: 0,
      abortSignal: expect.any(AbortSignal),
    });
    expect(forTool).toHaveBeenCalledWith("generate_image");
    expect(put).toHaveBeenCalledWith(PNG_BYTES, { mediaType: "image/png", filename: "generated-1.png" });
    expect(result).toEqual({
      ok: true,
      model: MODEL_ID,
      images: [{ uri: ARTIFACT_URI, mediaType: "image/png", filename: "generated-1.png", byteLength: PNG_BYTES.byteLength }],
      sendMessageMarkup: [`<img src="${ARTIFACT_URI}"/>`],
      warnings: [],
    });
    expect(JSON.stringify(result)).not.toContain(Buffer.from(PNG_BYTES).toString("base64"));
    expect(JSON.stringify(result)).not.toContain("A quiet lake at dawn");
    expect(tool.description).toContain("必须先实际查看");
    expect(tool.description).toContain("每轮合计最多输出 3 张图片");
    const projected = await tool.toModelOutput!({ toolCallId: "generate-1", input: { prompt: "fixture" }, output: result });
    expect(projected.type).toBe("content");
    if (projected.type !== "content") throw new Error("expected generated image projection");
    const image = projected.value.find((part) => part.type === "image-data");
    if (!image || image.type !== "image-data") throw new Error("expected image-data");
    expect(Buffer.from(image.data, "base64")).toEqual(Buffer.from(PNG_BYTES));
  });

  it("keeps only the first image and returns a bounded warning if the provider ignores n=1", async () => {
    const generate = vi.fn(async () => ({
      images: [
        { uint8Array: PNG_BYTES, mediaType: "image/png" },
        { uint8Array: PNG_BYTES, mediaType: "image/png" },
      ],
    }));
    const { tool, put } = createTool({ generate });
    const result = await tool.execute({ prompt: "fixture" }, toolContext());
    expect(put).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      images: [{ uri: ARTIFACT_URI }],
      warnings: ["The provider returned multiple images; only the first was saved."],
    });
  });
  it.each([
    [undefined, "1024x1024"],
    ["square", "1024x1024"],
    ["portrait", "1024x1536"],
  ] as const)("maps orientation %s to size %s", async (orientation, size) => {
    const { tool, generate } = createTool();
    await tool.execute({ prompt: "fixture", ...(orientation === undefined ? {} : { orientation }) }, toolContext());
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ size }));
  });

  it("rejects empty, invalid, and oversized provider output before persistence", async () => {
    for (const [images, code] of [
      [[], "empty_result"],
      [[{ uint8Array: new Uint8Array([1, 2, 3]), mediaType: "image/png" }], "invalid_image"],
      [[{ uint8Array: new Uint8Array(RESOURCE_MAX_BYTES + 1).fill(1), mediaType: "image/png" }], "image_too_large"],
    ] as const) {
      const generate = vi.fn(async () => ({ images }));
      const { tool, put } = createTool({ generate });
      await expect(tool.execute({ prompt: "fixture" }, toolContext())).resolves.toMatchObject({ ok: false, error: { code } });
      expect(put).not.toHaveBeenCalled();
    }
  });

  it("maps artifact failures without leaking storage details", async () => {
    const put = vi.fn(async () => {
      throw new Error("/secret/channel/path EACCES");
    });
    const { tool } = createTool({
      resources: {
        artifacts: { forTool: () => ({ put }) },
        maxBytes: RESOURCE_MAX_BYTES,
        detectImageMediaType,
      },
    });
    const result = await tool.execute({ prompt: "fixture" }, toolContext());

    expect(result).toEqual({ ok: false, error: { code: "artifact_write_failed", message: "The image could not be saved.", retryable: true } });
    expect(JSON.stringify(result)).not.toContain("/secret/channel/path");
  });

  it("returns bounded provider, refusal, and empty-result errors", async () => {
    const cases = [
      {
        cause: new APICallError({
          message: `upstream failed ${"x".repeat(1000)} sk-secret`,
          url: "https://fixture.invalid/v1/images/generations",
          requestBodyValues: { prompt: "secret prompt" },
          statusCode: 503,
          responseBody: '{"error":"internal","api_key":"sk-secret"}',
          isRetryable: true,
        }),
        expected: { code: "provider_error", message: "The image request failed at the provider.", retryable: true },
      },
      {
        cause: new APICallError({
          message: "Request was blocked by the content policy",
          url: "https://fixture.invalid/v1/images/generations",
          requestBodyValues: {},
          statusCode: 400,
          responseBody: '{"error":"safety refusal"}',
          isRetryable: false,
        }),
        expected: { code: "content_refused", message: "The image request was refused by the provider.", retryable: false },
      },
      {
        cause: new NoImageGeneratedError({ message: "No image generated", responses: [] }),
        expected: { code: "empty_result", message: "The provider returned no image.", retryable: true },
      },
    ];

    for (const { cause, expected } of cases) {
      const generate = vi.fn(async () => {
        throw cause;
      });
      const { tool } = createTool({ generate });
      const result = await tool.execute({ prompt: "secret prompt" }, toolContext());
      expect(result).toEqual({ ok: false, error: expected });
      expect(JSON.stringify(result)).not.toMatch(/sk-secret|secret prompt|fixture\.invalid|responseBody/i);
      expect(JSON.stringify(result).length).toBeLessThan(240);
    }
  });

  it("enforces timeout even when the generator ignores abort", async () => {
    vi.useFakeTimers();
    const generate = vi.fn(() => new Promise(() => undefined));
    const { tool } = createTool({ generate, timeoutMs: 50 });
    const pending = tool.execute({ prompt: "fixture" }, toolContext());

    await vi.advanceTimersByTimeAsync(51);

    await expect(pending).resolves.toEqual({ ok: false, error: { code: "timeout", message: "The image request timed out.", retryable: true } });
    const call = generate.mock.calls[0]?.[0] as { abortSignal: AbortSignal } | undefined;
    if (!call) throw new Error("generator was not called");
    expect(call.abortSignal.aborted).toBe(true);
  });

  it("honors an already-aborted or live execution signal", async () => {
    for (const abortBefore of [true, false]) {
      const controller = new AbortController();
      const generate = vi.fn(() => new Promise(() => undefined));
      const { tool } = createTool({ generate });
      if (abortBefore) controller.abort(new Error("cancelled"));
      const pending = tool.execute({ prompt: "fixture" }, toolContext(controller.signal));
      if (!abortBefore) controller.abort(new Error("cancelled"));

      await expect(pending).resolves.toEqual({ ok: false, error: { code: "aborted", message: "The image request was aborted.", retryable: false } });
      if (abortBefore) {
        expect(generate).not.toHaveBeenCalled();
      } else {
        const call = generate.mock.calls[0]?.[0] as { abortSignal: AbortSignal } | undefined;
        if (!call) throw new Error("generator was not called");
        expect(call.abortSignal.aborted).toBe(true);
      }
    }
  });
  it("persists generated bytes and sends the returned artifact through the existing send_message path", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-generate-image-"));
    roots.push(root);
    const resources = new ChannelResources(root);
    const imageModel = { specificationVersion: "v3", provider: "fixture", modelId: MODEL_ID };
    const tool = createGenerateImageTool({
      imageModel: imageModel as never,
      modelId: MODEL_ID,
      timeoutMs: 1000,
      resources,
      generate: async () => ({ images: [{ uint8Array: PNG_BYTES, mediaType: "image/png" }] }),
    });

    const result = await tool.execute({ prompt: "fixture" }, toolContext());
    if (!result.ok) throw new Error(result.error.code);
    expect(JSON.stringify(result)).not.toContain(Buffer.from(PNG_BYTES).toString("base64"));

    const sent: Array<{ channelId: string; elements: unknown[] }> = [];
    const send = createSendMessageTool({
      bot: {
        platform: "onebot",
        sendMessage: vi.fn(async (channelId: string, elements: unknown[]) => {
          sent.push({ channelId, elements });
          return ["message-1"];
        }),
      } as never,
      channelId: "room",
      resources,
      pacing: { charactersPerSecond: 10_000, maxTotalDelayMs: 1 },
      innerThought: false,
    });

    await expect(send.execute({ messages: [result.sendMessageMarkup[0]!] }, toolContext())).resolves.toEqual({
      ok: true,
      messageIds: ["message-1"],
      count: 1,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channelId).toBe("room");
    expect(sent[0]?.elements[0]).toMatchObject({
      type: "img",
      attrs: { src: expect.stringContaining("data:image/png;base64,") },
    });
  });
});

describe("OpenAI-compatible image request contract", () => {
  it("posts the configured model and mapped size to images/generations without quality or retries", async () => {
    let request: { url: string; body: Record<string, unknown> } | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = { url: String(input), body: JSON.parse(await new Response(init?.body ?? null).text()) as Record<string, unknown> };
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = createOpenAI({ apiKey: "test", baseURL: "https://fixture.invalid/v1", fetch });
    const put = vi.fn(async () => ARTIFACT_URI);
    const tool = createGenerateImageTool({
      imageModel: client.image(MODEL_ID),
      modelId: MODEL_ID,
      timeoutMs: 1000,
      resources: {
        artifacts: { forTool: () => ({ put }) } as never,
        maxBytes: RESOURCE_MAX_BYTES,
        detectImageMediaType,
      },
    });

    await expect(tool.execute({ prompt: "fixture prompt", orientation: "portrait" }, toolContext())).resolves.toMatchObject({ ok: true });

    expect(request?.url).toBe("https://fixture.invalid/v1/images/generations");
    expect(request?.body).toEqual({ model: MODEL_ID, prompt: "fixture prompt", n: 1, size: "1024x1536", response_format: "b64_json" });
    expect(request?.body).not.toHaveProperty("quality");
    expect(put).toHaveBeenCalledWith(PNG_BYTES, { mediaType: "image/png", filename: "generated-1.png" });
  });
});
