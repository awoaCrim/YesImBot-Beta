import { EphemeralImageProjectionStore, type AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { detectImageMediaType, RESOURCE_MAX_BYTES, ResourceReadError } from "../../../core/src/resources/index.js";
import { createGenerateImageTool } from "../src/image-generation.js";
import { PNG_BYTES, png } from "./helpers.js";

const REFERENCE = "asset://0123456789abcdef0123456789abcdef";
const RESULT = "artifact://generate_image/018f1234-5678-7abc-8def-0123456789ab";
const context: AgentToolExecuteContext = {
  toolCallId: "reference-1",
  turnId: "turn-1",
  messages: [],
  runtime: { id: "runtime" },
  channel: {} as never,
  state: {} as never,
  storage: {} as never,
};

function fixture(output = PNG_BYTES, maxBytes = RESOURCE_MAX_BYTES) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(output).toString("base64") }] }), {
      headers: { "content-type": "application/json" },
    });
  });
  const generate = vi.fn(async () => ({ images: [{ uint8Array: output, mediaType: "image/png" }] }));
  const put = vi.fn(async () => RESULT);
  const openStrict = vi.fn(async (_uri: string) => ({ bytes: PNG_BYTES }));
  const resources = { artifacts: { forTool: () => ({ put }) }, maxBytes, detectImageMediaType, openStrict };
  const imageProjection = new EphemeralImageProjectionStore();
  const tool = createGenerateImageTool({
    imageModel: { specificationVersion: "v3", provider: "fixture", modelId: "text-model" } as never,
    modelId: "text-model",
    referenceModelId: "reference-model",
    apiKey: "test-secret",
    baseURL: "https://fixture.invalid/v1",
    timeoutMs: 1000,
    resources,
    generate,
    fetch,
    imageProjection,
  } as never);
  return { tool, requests, fetch, generate, put, openStrict, imageProjection };
}

describe("reference-grounded generation", () => {
  it("requires a subject declaration and schema-level references for specific subjects", () => {
    const { tool } = fixture();
    const schema = (tool.inputSchema as { jsonSchema: Record<string, unknown> }).jsonSchema;
    expect(schema.required).toEqual(expect.arrayContaining(["prompt", "subjectType"]));
    expect(JSON.stringify(schema)).toContain("referenceUris");
    expect(schema).toHaveProperty("anyOf");
    expect(tool.description).toContain("自拍指向当前角色时同样属于 specific");
    expect(tool.description).toContain("身份不明先澄清");
  });

  it.each([
    { prompt: "a named character", subjectType: "specific" },
    { prompt: "a named character", subjectType: "specific", referenceUris: [] },
    { prompt: "a named character" },
    { prompt: "a named character", subjectType: "other" },
  ])("never invokes a provider with a missing subject contract: %j", async (input) => {
    const f = fixture();
    await expect(f.tool.execute(input as never, context)).resolves.toMatchObject({ ok: false });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });

  it("sends actual reference pixels and mapped orientation through the edit-capable route", async () => {
    const f = fixture(png(2, 3));
    const result = await f.tool.execute(
      { prompt: "  same person, different clothes  ", subjectType: "specific", referenceUris: [REFERENCE], orientation: "portrait" } as never,
      context,
    );
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.requests).toEqual([
      {
        url: "https://fixture.invalid/v1/images/edits",
        body: {
          model: "reference-model",
          prompt: "same person, different clothes",
          images: [{ image_url: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}` }],
          n: 1,
          size: "1024x1536",
          response_format: "b64_json",
        },
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      model: "reference-model",
      referenceInput: { includedInRequest: true, uris: [REFERENCE] },
      images: [{ uri: RESULT, width: 2, height: 3, orientation: "portrait" }],
      requestedOrientation: "portrait",
      orientationMatches: true,
      warnings: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/test-secret|data:image|same person|identityVerified/);
    expect(f.imageProjection.get("reference-1")?.bytes).toEqual(png(2, 3));
  });

  it("supports several explicit references and validates all before provider execution", async () => {
    const f = fixture();
    const second = "artifact://import_image_reference/018f1234-5678-7abc-8def-0123456789ab";
    await expect(f.tool.execute({ prompt: "together", subjectType: "specific", referenceUris: [REFERENCE, second] } as never, context)).resolves.toMatchObject({
      ok: true,
    });
    expect(f.openStrict.mock.calls.map(([uri]) => uri)).toEqual([REFERENCE, second]);
    expect(f.requests[0]?.body.images).toHaveLength(2);
  });

  it.each(["https://external.invalid/a.png", "workspace:///a.png", "artifact://sticker/018f1234-5678-7abc-8def-0123456789ab"])(
    "rejects forbidden reference URI %s",
    async (uri) => {
      const f = fixture();
      await expect(f.tool.execute({ prompt: "same subject", subjectType: "specific", referenceUris: [uri] } as never, context)).resolves.toMatchObject({
        ok: false,
        error: { code: "invalid_source_uri" },
      });
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
    },
  );

  it("does not silently generate without a missing or unreadable channel reference", async () => {
    const f = fixture();
    f.openStrict.mockRejectedValue(new ResourceReadError("resource_not_found"));
    await expect(f.tool.execute({ prompt: "same subject", subjectType: "specific", referenceUris: [REFERENCE] } as never, context)).resolves.toMatchObject({
      ok: false,
      error: { code: "source_not_found" },
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("bounds reference counts and aggregate bytes", async () => {
    const f = fixture();
    await expect(
      f.tool.execute({ prompt: "same subject", subjectType: "specific", referenceUris: Array(5).fill(REFERENCE) } as never, context),
    ).resolves.toMatchObject({ ok: false });
    f.openStrict.mockResolvedValue({ bytes: new Uint8Array(RESOURCE_MAX_BYTES + 1) });
    await expect(f.tool.execute({ prompt: "same subject", subjectType: "specific", referenceUris: [REFERENCE] } as never, context)).resolves.toMatchObject({
      ok: false,
      error: { code: "source_too_large" },
    });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("never retries a failed reference request as text-only generation", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response('{"error":"bad input"}', { status: 400 }));
    await expect(f.tool.execute({ prompt: "same subject", subjectType: "specific", referenceUris: [REFERENCE] } as never, context)).resolves.toMatchObject({
      ok: false,
      error: { code: "provider_error", retryable: false },
    });
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("retains a 1374x1145 portrait mismatch with accurate metadata and a warning", async () => {
    const f = fixture(png(1374, 1145));
    const result = await f.tool.execute({ prompt: "a generic view", subjectType: "generic", orientation: "portrait" } as never, context);
    expect(result).toMatchObject({
      ok: true,
      referenceInput: { includedInRequest: false, uris: [] },
      images: [{ uri: RESULT, width: 1374, height: 1145, orientation: "landscape" }],
      requestedOrientation: "portrait",
      orientationMatches: false,
      warnings: [expect.stringMatching(/orientation/i)],
    });
    expect(f.put).toHaveBeenCalledOnce();
    expect(f.generate).toHaveBeenCalledOnce();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["square", 1, 1],
    ["portrait", 2, 3],
    ["landscape", 3, 2],
  ] as const)("reports a matching %s output without warnings", async (orientation, width, height) => {
    const f = fixture(png(width, height));
    await expect(f.tool.execute({ prompt: "generic scene", subjectType: "generic", orientation }, context)).resolves.toMatchObject({
      ok: true,
      requestedOrientation: orientation,
      orientationMatches: true,
      warnings: [],
      images: [{ width, height, orientation }],
    });
  });

  it("keeps orientation and multiple-image warnings together", async () => {
    const f = fixture();
    f.generate.mockResolvedValue({
      images: [
        { uint8Array: PNG_BYTES, mediaType: "image/png" },
        { uint8Array: PNG_BYTES, mediaType: "image/png" },
      ],
    });
    const result = await f.tool.execute({ prompt: "generic scene", subjectType: "generic", orientation: "portrait" }, context);
    expect(result).toMatchObject({
      ok: true,
      orientationMatches: false,
      warnings: [expect.stringMatching(/multiple images/), expect.stringMatching(/orientation/)],
    });
  });

  it("rejects the aggregate reference limit even if individual images fit", async () => {
    const f = fixture(PNG_BYTES, PNG_BYTES.byteLength + 1);
    await expect(f.tool.execute({ prompt: "same subject", subjectType: "specific", referenceUris: [REFERENCE, REFERENCE] }, context)).resolves.toMatchObject({
      ok: false,
      error: { code: "source_too_large" },
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects truncated reference and output images before persistence", async () => {
    const f = fixture();
    f.openStrict.mockResolvedValue({ bytes: PNG_BYTES.subarray(0, 8) });
    await expect(f.tool.execute({ prompt: "same subject", subjectType: "specific", referenceUris: [REFERENCE] }, context)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_source_image" },
    });
    expect(f.fetch).not.toHaveBeenCalled();
    const invalid = fixture(PNG_BYTES.subarray(0, 8));
    await expect(invalid.tool.execute({ prompt: "generic scene", subjectType: "generic" }, context)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_image" },
    });
    expect(invalid.put).not.toHaveBeenCalled();
  });

  it("does not report successful generation when canceled during artifact persistence", async () => {
    const f = fixture();
    const controller = new AbortController();
    let finish!: (uri: string) => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.put.mockImplementation(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = f.tool.execute({ prompt: "generic scene", subjectType: "generic" }, { ...context, abortSignal: controller.signal } as never);
    await writing;
    controller.abort();
    finish(RESULT);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(f.imageProjection.get("reference-1")).toBeUndefined();
  });

  it("bounds reference reads with the operation timeout, even if a source ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      let finish!: (value: { bytes: Uint8Array }) => void;
      f.openStrict.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = f.tool.execute({ prompt: "same subject", subjectType: "specific", referenceUris: [REFERENCE] } as never, context);
      await vi.advanceTimersByTimeAsync(1001);
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "timeout" } });
      finish({ bytes: PNG_BYTES });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.generate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
