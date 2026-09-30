import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EphemeralImageProjectionStore, type AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { ChannelResources, detectImageMediaType, RESOURCE_MAX_BYTES, ResourceReadError } from "../../../core/src/resources/index.js";
import { PNG_BYTES } from "../../../core/tests/helpers/index.js";
import { createEditImageTool as createProviderEditImageTool, type EditImageToolOptions } from "../src/image-edit.js";
import { ImageOutputBudget } from "../src/image-output.js";

const roots: string[] = [];
const EDIT_URI = "artifact://edit_image/018f1234-5678-7abc-8def-0123456789ab";
const EDIT_MODEL_ID = "custom-image-model";

function createEditImageTool(options: Omit<EditImageToolOptions, "modelId"> & { readonly modelId?: string }) {
  return createProviderEditImageTool({ ...options, modelId: options.modelId ?? EDIT_MODEL_ID });
}

function toolContext(toolCallId = "edit-1", signal?: AbortSignal): AgentToolExecuteContext {
  return {
    runtime: { id: "runtime" },
    channel: {} as never,
    state: {} as never,
    storage: {} as never,
    turnId: "turn-1",
    toolCallId,
    abortSignal: signal,
    messages: [],
  };
}

function mockResources(overrides: Record<string, unknown> = {}) {
  const put = vi.fn(async () => EDIT_URI);
  return {
    resources: {
      artifacts: { forTool: vi.fn(() => ({ put })) },
      maxBytes: RESOURCE_MAX_BYTES,
      detectImageMediaType,
      openStrict: vi.fn(async () => ({ bytes: PNG_BYTES, mediaType: "image/png", filename: "source.png" })),
      ...overrides,
    },
    put,
  };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("edit_image tool", () => {
  it("uses the images array required by the deployed gpt-image-2 edit contract", async () => {
    const fixture = mockResources();
    let requestBody: Record<string, unknown> | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(await new Response(init?.body ?? null).text()) as Record<string, unknown>;
      if (!Array.isArray(requestBody.images)) {
        return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "missing required parameter images" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const tool = createEditImageTool({ apiKey: "test", timeoutMs: 1000, resources: fixture.resources as never, fetch });

    const result = await tool.execute({ uri: "asset://0123456789abcdef0123456789abcdef", prompt: "edit" }, toolContext());

    expect(requestBody).toMatchObject({
      model: EDIT_MODEL_ID,
      prompt: "edit",
      n: 1,
      response_format: "b64_json",
      images: [{ image_url: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}` }],
    });
    expect(requestBody).not.toHaveProperty("image");
    expect(result).toMatchObject({ ok: true, images: [{ uri: expect.stringMatching(/^artifact:\/\/edit_image\//) }] });
  });

  it("posts outbound-only source pixels, persists a new artifact, and projects edited pixels", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-edit-image-"));
    roots.push(root);
    const resources = new ChannelResources(root);
    const sourceUri = await resources.artifacts.forTool("generate_image").put(PNG_BYTES, { mediaType: "image/png", filename: "source.png" });
    const imageProjection = new EphemeralImageProjectionStore();
    let request: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(await new Response(init?.body ?? null).text()) as Record<string, unknown>,
      };
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const tool = createEditImageTool({
      baseURL: "https://fixture.invalid/v1/",
      apiKey: "sk-test-secret",
      modelId: EDIT_MODEL_ID,
      timeoutMs: 1000,
      resources,
      imageProjection,
      fetch,
    });

    expect(
      (JSON.parse(JSON.stringify(tool.inputSchema)) as { jsonSchema: { properties: { prompt: { pattern: string } } } }).jsonSchema.properties.prompt.pattern,
    ).toBe(String.raw`\S`);
    expect(tool.description).toContain("用户消息中的 [图片：asset://<32 位十六进制 id>] 就是可编辑的当前频道图片");
    expect(tool.description).toContain("将消息里的完整 URI 原样作为 uri 传入");
    const result = await tool.execute({ uri: sourceUri, prompt: "  make the sky darker  " }, toolContext());

    expect(request?.url).toBe("https://fixture.invalid/v1/images/edits");
    expect(request?.headers.get("authorization")).toBe("Bearer sk-test-secret");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.body).toMatchObject({ model: EDIT_MODEL_ID, prompt: "make the sky darker", n: 1, response_format: "b64_json" });
    expect(request?.body).not.toHaveProperty("maxRetries");
    const requestImages = request?.body.images as { image_url: string }[] | undefined;
    if (!requestImages?.[0]) throw new Error("expected JSON image reference");
    expect(requestImages[0].image_url).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`);
    expect(JSON.stringify(request?.body)).not.toContain(sourceUri);
    expect(result).toMatchObject({
      ok: true,
      model: EDIT_MODEL_ID,
      images: [{ uri: expect.stringMatching(/^artifact:\/\/edit_image\//), mediaType: "image/png", filename: "edited-1.png" }],
    });
    expect(JSON.stringify(result)).not.toMatch(/sk-test-secret|make the sky darker|data:image|iVBOR/i);
    if (!result.ok) throw new Error(result.error.code);
    expect((await resources.openStrict(result.images[0]!.uri)).bytes).toEqual(PNG_BYTES);

    const projected = await tool.toModelOutput!({ toolCallId: "edit-1", input: { uri: sourceUri, prompt: "x" }, output: result });
    expect(projected.type).toBe("content");
    if (projected.type !== "content") throw new Error("expected current-turn image projection");
    const image = projected.value.find((part) => part.type === "image-data");
    if (!image || image.type !== "image-data") throw new Error("expected image-data");
    expect(Buffer.from(image.data, "base64")).toEqual(Buffer.from(PNG_BYTES));
    imageProjection.clearAll();
  });

  it("edits an uploaded current-channel asset without replacing the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-edit-uploaded-image-"));
    roots.push(root);
    const resources = new ChannelResources(root);
    const assetId = await resources.assets.put(PNG_BYTES);
    const sourceUri = `asset://${assetId}`;
    const edit = vi.fn(async ({ sourceDataUrl, prompt }: { sourceDataUrl: string; prompt: string }) => {
      expect(sourceDataUrl).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`);
      expect(prompt).toBe("remove the background");
      return { images: [{ uint8Array: PNG_BYTES }] };
    });
    const tool = createEditImageTool({
      apiKey: "test",
      modelId: EDIT_MODEL_ID,
      timeoutMs: 1000,
      resources,
      edit,
    });

    const result = await tool.execute({ uri: sourceUri, prompt: "  remove the background  " }, toolContext());

    expect(result).toMatchObject({
      ok: true,
      images: [{ uri: expect.stringMatching(/^artifact:\/\/edit_image\//) }],
    });
    expect(edit).toHaveBeenCalledOnce();
    expect(await resources.assets.get(assetId)).toEqual(PNG_BYTES);
    if (!result.ok) throw new Error(result.error.code);
    expect((await resources.openStrict(result.images[0]!.uri)).bytes).toEqual(PNG_BYTES);
  });

  it("opens only current-channel asset/artifact sources and maps source validation failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const invalidUri = mockResources();
    const invalidUriTool = createEditImageTool({ apiKey: "test", timeoutMs: 1000, resources: invalidUri.resources as never, fetch });
    await expect(invalidUriTool.execute({ uri: "workspace:///source.png", prompt: "edit" }, toolContext())).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_source_uri" },
    });
    expect(invalidUri.resources.openStrict).not.toHaveBeenCalled();

    const invalidImage = mockResources({ openStrict: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" })) });
    const invalidImageTool = createEditImageTool({ apiKey: "test", timeoutMs: 1000, resources: invalidImage.resources as never, fetch });
    await expect(invalidImageTool.execute({ uri: "artifact://generate_image/id", prompt: "edit" }, toolContext())).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_source_image" },
    });

    const oversized = mockResources({
      openStrict: vi.fn(async () => {
        throw new ResourceReadError("resource_too_large");
      }),
    });
    const oversizedTool = createEditImageTool({ apiKey: "test", timeoutMs: 1000, resources: oversized.resources as never, fetch });
    await expect(oversizedTool.execute({ uri: "asset://0123456789abcdef0123456789abcdef", prompt: "edit" }, toolContext())).resolves.toMatchObject({
      ok: false,
      error: { code: "source_too_large" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates edited output before persistence and never retries provider failures", async () => {
    const fixture = mockResources();
    const invalidTool = createEditImageTool({
      apiKey: "test",
      timeoutMs: 1000,
      resources: fixture.resources as never,
      edit: vi.fn(async () => ({ images: [{ uint8Array: new Uint8Array([1, 2, 3]) }] })),
    });
    await expect(invalidTool.execute({ uri: "artifact://generate_image/id", prompt: "edit" }, toolContext())).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_image" },
    });
    expect(fixture.put).not.toHaveBeenCalled();

    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response('{"error":"sk-secret secret prompt internal"}', { status: 503, headers: { "content-type": "application/json" } }),
    );
    const providerTool = createEditImageTool({ apiKey: "sk-secret", timeoutMs: 1000, resources: fixture.resources as never, fetch });
    const result = await providerTool.execute({ uri: "artifact://generate_image/id", prompt: "secret prompt" }, toolContext("provider-call"));
    expect(fetch).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: false, error: { code: "provider_error", message: "The image request failed at the provider.", retryable: true } });
    expect(JSON.stringify(result)).not.toMatch(/sk-secret|secret prompt|fixture\.invalid/i);
  });

  it("bounds edit response bodies before parsing", async () => {
    const fixture = mockResources({ maxBytes: PNG_BYTES.byteLength });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("x".repeat(70_000), { status: 200 }));
    const tool = createEditImageTool({ apiKey: "test", timeoutMs: 1000, resources: fixture.resources as never, fetch });

    await expect(tool.execute({ uri: "artifact://generate_image/id", prompt: "edit" }, toolContext())).resolves.toMatchObject({
      ok: false,
      error: { code: "image_too_large", retryable: false },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it("returns bounded timeout and abort errors even when the edit transport ignores cancellation", async () => {
    vi.useFakeTimers();
    const fixture = mockResources();
    const edit = vi.fn(() => new Promise<never>(() => undefined));
    const timeoutTool = createEditImageTool({ apiKey: "test", timeoutMs: 50, resources: fixture.resources as never, edit });
    const timeout = timeoutTool.execute({ uri: "artifact://generate_image/id", prompt: "edit" }, toolContext("timeout"));
    await vi.advanceTimersByTimeAsync(51);
    await expect(timeout).resolves.toEqual({ ok: false, error: { code: "timeout", message: "The image request timed out.", retryable: true } });
    const editCall = edit.mock.calls[0]?.[0] as { abortSignal: AbortSignal } | undefined;
    if (!editCall) throw new Error("edit transport was not called");
    expect(editCall.abortSignal.aborted).toBe(true);

    const controller = new AbortController();
    const abortTool = createEditImageTool({ apiKey: "test", timeoutMs: 1000, resources: fixture.resources as never, edit });
    const aborted = abortTool.execute({ uri: "artifact://generate_image/id", prompt: "edit" }, toolContext("abort", controller.signal));
    controller.abort();
    await expect(aborted).resolves.toEqual({ ok: false, error: { code: "aborted", message: "The image request was aborted.", retryable: false } });
  });

  it("uses one shared three-output budget across generation and editing primitives", async () => {
    const fixture = mockResources();
    const budget = new ImageOutputBudget();
    const edit = vi.fn(async () => ({ images: [{ uint8Array: PNG_BYTES }] }));
    const tool = createEditImageTool({ apiKey: "test", timeoutMs: 1000, resources: fixture.resources as never, budget, edit });

    for (const toolCallId of ["one", "two", "three"]) {
      await expect(tool.execute({ uri: "artifact://generate_image/id", prompt: "edit" }, toolContext(toolCallId))).resolves.toMatchObject({ ok: true });
    }
    await expect(tool.execute({ uri: "artifact://generate_image/id", prompt: "edit" }, toolContext("four"))).resolves.toEqual({
      ok: false,
      error: {
        code: "image_budget_exhausted",
        message: "This turn has reached the 3-image output limit. Send the best existing image with a brief note.",
        retryable: false,
      },
    });
    expect(edit).toHaveBeenCalledTimes(3);
  });
});
