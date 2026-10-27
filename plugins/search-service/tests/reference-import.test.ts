import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { EphemeralImageProjectionStore, type AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { createImagePreviewCapability } from "../../../core/src/agents/image-preview.js";
import { createSendMessageTool } from "../../../core/src/agents/tools.js";
import { ChannelResources } from "../../../core/src/resources/index.js";
import { createGenerateImageTool } from "../../image-tools/src/image-generation.js";
import { PNG_BYTES } from "../../image-tools/tests/helpers.js";
import { createTavilyBackend } from "../src/backends/tavily.js";
import SearchService from "../src/index.js";
import { createImportImageReferenceTool } from "../src/reference-import.js";

const IMPORT_URI = "artifact://import_image_reference/018f1234-5678-7abc-8def-0123456789ab";
const input = { imageUrl: "https://cdn.example/character.png", subject: "public character", sourcePageUrl: "https://official.example/character" };
const context: AgentToolExecuteContext = {
  toolCallId: "import-1",
  turnId: "turn-1",
  messages: [],
  runtime: { id: "runtime" },
  channel: {} as never,
  state: {} as never,
  storage: {} as never,
};
const roots: string[] = [];

function fixture() {
  const projection = new EphemeralImageProjectionStore();
  const preview = createImagePreviewCapability({ policy: { mode: "native" }, projection });
  const put = vi.fn(async () => IMPORT_URI);
  const resources = { artifacts: { forTool: vi.fn(() => ({ put })) }, maxBytes: 1024 };
  const request = vi.fn(async () => ({ status: 200, headers: {}, body: Readable.from([PNG_BYTES]), cancel: vi.fn() }));
  const options = {
    resources,
    imageProjection: projection,
    imagePreview: preview,
    timeoutMs: 1000,
    seams: { resolve: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]), request },
  };
  return { options, projection, preview, put, request };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("reference import and actual content inspection", () => {
  it("wires search/import tools to channel resources and shared projection cleanup", async () => {
    const f = fixture();
    const get = vi.fn(async () => f.options.resources);
    const dispose = vi.fn();
    const service = new SearchService(
      { logger: () => ({ error: vi.fn(), info: vi.fn() }), on: vi.fn(), yesimbot: { resource: { get }, agent: { use: () => dispose } } } as never,
      { provider: "tavily", tavily: { apiKey: "test", searchEndpoint: "https://search.example", extractEndpoint: "https://extract.example" } },
    );
    await service.start();
    const scope = { type: "guild", platform: "onebot", channelId: "room", guildId: "room" } as const;
    const plugin = await service.setup(scope, {} as never, { imageProjection: f.projection, imagePreview: f.preview });
    if (!plugin) throw new Error("Expected search plugin");
    expect(get).toHaveBeenCalledWith(scope);
    expect(Array.isArray(plugin.tools) && plugin.tools.map((tool) => tool.name)).toEqual([
      "tavily_web_search",
      "tavily_image_search",
      "tavily_web_scrape",
      "import_image_reference",
    ]);
    const prompt = await (plugin.appendSystemPrompt as () => string)();
    expect(prompt).toContain("私人或自定义对象缺图");
    expect(prompt).toContain("不要只看标题");
    f.projection.stage({ toolCallId: "import-1", turnId: "turn-1", bytes: PNG_BYTES, mediaType: "image/png" });
    await plugin.onTurnFinish?.({} as never, context);
    expect(f.projection.get("import-1")).toBeUndefined();
    f.projection.stage({ toolCallId: "other", turnId: "turn-2", bytes: PNG_BYTES, mediaType: "image/png" });
    await plugin.stop?.();
    expect(f.projection.get("other")).toBeUndefined();
    await service.stop();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("persists exact candidate pixels and exposes them natively without claiming identity verification", async () => {
    const f = fixture();
    const tool = createImportImageReferenceTool(f.options);
    const result = await tool.execute(input, context);
    expect(result).toEqual({
      ok: true,
      uri: IMPORT_URI,
      mediaType: "image/png",
      width: 1,
      height: 1,
      byteLength: PNG_BYTES.byteLength,
      source: { imageUrl: input.imageUrl, sourcePageUrl: input.sourcePageUrl },
      inspection: { mode: "native" },
    });
    expect(f.put).toHaveBeenCalledWith(PNG_BYTES, { mediaType: "image/png", filename: "reference.png" });
    expect(JSON.stringify(result)).not.toMatch(/base64|identityVerified|data:image/);
    const output = await tool.toModelOutput!({ toolCallId: "import-1", input, output: result });
    expect(output).toMatchObject({
      type: "content",
      value: [{ type: "text" }, { type: "image-data", data: Buffer.from(PNG_BYTES).toString("base64"), mediaType: "image/png" }],
    });
  });

  it("uses only the configured vision capability when native input is unavailable", async () => {
    const f = fixture();
    const describe = vi.fn(async () => "Long pink hair. Identity cannot be established from pixels alone.");
    const tool = createImportImageReferenceTool({ ...f.options, imagePreview: { mode: "vision", preview: vi.fn(), describe } });
    const result = await tool.execute(input, context);
    expect(describe).toHaveBeenCalledWith(
      expect.objectContaining({
        frames: [{ bytes: PNG_BYTES, mediaType: "image/png", label: "Candidate reference image" }],
        question: expect.stringContaining(input.subject),
      }),
    );
    expect(result).toMatchObject({ ok: true, inspection: { mode: "vision", description: expect.stringContaining("Identity cannot") } });
    expect(f.projection.get("import-1")).toBeUndefined();
    const output = await tool.toModelOutput!({ toolCallId: "import-1", input, output: result });
    expect(output.type === "content" && output.value).toHaveLength(1);
  });

  it("does not import when there is no working inspection route", async () => {
    const f = fixture();
    const tool = createImportImageReferenceTool({ ...f.options, imagePreview: undefined });
    await expect(tool.execute(input, context)).resolves.toMatchObject({ ok: false, error: { code: "image_input_unavailable" } });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });

  it("does not grant inspection from failed or empty vision text", async () => {
    const f = fixture();
    const tool = createImportImageReferenceTool({ ...f.options, imagePreview: { mode: "vision", preview: vi.fn(), describe: vi.fn(async () => undefined) } });
    await expect(tool.execute(input, context)).resolves.toMatchObject({ ok: false, error: { code: "image_input_unavailable" } });
    expect(f.put).not.toHaveBeenCalled();
  });

  it("clears projected pixels on storage failure and does not leak paths", async () => {
    const f = fixture();
    f.put.mockRejectedValue(new Error("private/storage/path"));
    const tool = createImportImageReferenceTool(f.options);
    const result = await tool.execute(input, context);
    expect(result).toMatchObject({ ok: false, error: { code: "artifact_write_failed" } });
    expect(JSON.stringify(result)).not.toContain("private/storage/path");
    expect(f.projection.get("import-1")).toBeUndefined();
  });

  it("fails closed on unsafe or invalid sources and cancellation", async () => {
    const f = fixture();
    const tool = createImportImageReferenceTool(f.options);
    await expect(tool.execute({ ...input, imageUrl: "http://127.0.0.1/a.png" }, context)).resolves.toMatchObject({
      ok: false,
      error: { code: "unsafe_destination" },
    });
    await expect(tool.execute({ ...input, sourcePageUrl: "file:///source" }, context)).resolves.toMatchObject({ ok: false, error: { code: "invalid_url" } });
    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute(input, { ...context, abortSignal: controller.signal } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(f.put).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("cancels after a vision call without persisting or staging a late result", async () => {
    const f = fixture();
    const controller = new AbortController();
    const tool = createImportImageReferenceTool({
      ...f.options,
      imagePreview: {
        mode: "vision",
        preview: vi.fn(),
        describe: vi.fn(async () => {
          controller.abort();
          return "late description";
        }),
      },
    });
    await expect(tool.execute(input, { ...context, abortSignal: controller.signal } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
    expect(f.put).not.toHaveBeenCalled();
  });

  it("supports search -> inspected channel artifact -> outbound pixels -> separate generation and delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-reference-flow-"));
    roots.push(root);
    const resources = new ChannelResources(root);
    const f = fixture();
    const search = createTavilyBackend(
      { http: { post: vi.fn(async () => ({ results: [{ url: input.sourcePageUrl, images: [{ url: input.imageUrl }] }] })) } } as never,
      { apiKey: "test", searchEndpoint: "https://search.example", extractEndpoint: "https://extract.example" },
      { defaultLimit: 2, maxLimit: 8, timeoutMs: 1000, blacklist: [] },
      { error: vi.fn() } as never,
    ).createImageSearchTool();
    const candidates = (await search.execute({ query: input.subject }, context)) as { results: Array<{ imageUrl: string; sourcePageUrl: string }> };
    const candidate = candidates.results[0]!;
    const importer = createImportImageReferenceTool({ ...f.options, resources });
    const imported = await importer.execute({ ...candidate, subject: input.subject }, context);
    if (!imported.ok) throw new Error(imported.error.code);
    const reference = await resources.openStrict(imported.uri);
    expect(reference.bytes).toEqual(PNG_BYTES);
    const outbound = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.images).toEqual([{ image_url: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}` }]);
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }] }));
    });
    const generator = createGenerateImageTool({
      apiKey: "test",
      baseURL: "https://images.example/v1",
      modelId: "image-model",
      imageModel: {} as never,
      timeoutMs: 1000,
      resources,
      imageProjection: f.projection,
      fetch: outbound,
    });
    const generated = await generator.execute({ subjectType: "specific", prompt: "Same character, different clothes", referenceUris: [imported.uri] }, {
      ...context,
      toolCallId: "generate-1",
    } as never);
    expect(generated).toMatchObject({ ok: true, referenceInput: { includedInRequest: true, uris: [imported.uri] }, orientationMatches: true });
    if (!generated.ok) throw new Error(generated.error.code);
    const sent = vi.fn(async () => ["delivered-1"]);
    expect(sent).not.toHaveBeenCalled();
    const sender = createSendMessageTool({
      bot: { sendMessage: sent } as never,
      channelId: "room",
      resources,
      pacing: { charactersPerSecond: 10000, maxTotalDelayMs: 1 },
      innerThought: false,
    });
    await expect(sender.execute({ messages: [generated.sendMessageMarkup[0]!] }, context)).resolves.toMatchObject({ ok: true, messageIds: ["delivered-1"] });
    expect(sent).toHaveBeenCalledOnce();
    const otherRoot = await mkdtemp(join(tmpdir(), "yesimbot-reference-other-channel-"));
    roots.push(otherRoot);
    const otherChannel = new ChannelResources(otherRoot);
    await expect(otherChannel.openStrict(imported.uri)).rejects.toMatchObject({ code: "resource_not_found" });
  });
});
