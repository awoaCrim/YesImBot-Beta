import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { detectImageMediaType, RESOURCE_MAX_BYTES } from "../../../core/src/resources/index.js";
import { Config, apply } from "../src/index.js";
import { PNG_BYTES } from "./helpers.js";

type RegisteredChannelAgent = {
  name: string;
  tools: () => Array<{ name: string; description?: string; execute: (input: never, context: never) => Promise<unknown> }>;
  onTurnFinish?: (result: unknown, context: { turnId: string }) => void;
};

type RegisteredChannelPlugin = {
  setup(scope: unknown, bot: unknown, runtime?: { imageProjection: EphemeralImageProjectionStore }): Promise<RegisteredChannelAgent | null>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function runtime(config: Record<string, unknown>) {
  let dispose: (() => void) | undefined;
  const disposeAgent = vi.fn();
  const agent = { use: vi.fn(() => disposeAgent) };
  const artifactWriter = { put: vi.fn(async () => "artifact://fixture/output") };
  const resource = {
    get: vi.fn(async () => ({
      artifacts: { forTool: vi.fn(() => artifactWriter) },
      maxBytes: RESOURCE_MAX_BYTES,
      detectImageMediaType,
      openStrict: vi.fn(async () => ({ bytes: PNG_BYTES, mediaType: "image/png", filename: "source.png" })),
    })),
  };
  const ctx = {
    on(event: string, callback: () => void) {
      if (event === "dispose") dispose = callback;
    },
    yesimbot: { agent, resource },
  };
  const normalized = Config(config as never);
  apply(ctx as never, normalized as never);
  return { agent, resource, dispose, disposeAgent, normalized };
}

describe("image-tools configuration", () => {
  it("groups presentation without nesting or changing the existing configuration", () => {
    expect(Config.type).toBe("intersect");
    expect(Config.list?.map((group) => group.meta.description)).toEqual(["启用与连接", "模型选择", "请求限制"]);
    const previous = { enabled: true, apiKey: "test", baseURL: "https://fixture.invalid/v1", model: "text-model", editModel: "reference-model", timeout: 7 };
    expect(Config({ ...previous })).toEqual(previous);
    expect(Config({ apiKey: "test" })).toMatchObject({ enabled: true, apiKey: "test", timeout: 120 });
    expect(() => Config({ enabled: false } as never)).toThrow();
  });

  it.each([0, 601])("keeps the existing timeout bounds for %s seconds", (timeout) => {
    expect(() => Config({ apiKey: "test", model: "image-model", timeout })).toThrow();
  });

  it("defaults to enabled with a bounded timeout", () => {
    const configured = runtime({ apiKey: "test", model: "image-model" });
    expect(configured.normalized).toMatchObject({ enabled: true, model: "image-model", timeout: 120 });
    expect(configured.agent.use).toHaveBeenCalledOnce();
  });

  it("does not register tools when disabled", () => {
    const configured = runtime({ enabled: false, apiKey: "test" });
    expect(configured.agent.use).not.toHaveBeenCalled();
    expect(configured.dispose).toBeUndefined();
  });

  it("requires an explicit image model when enabled", () => {
    expect(() => runtime({ apiKey: "test" })).toThrow("requires model when image tools are enabled");
  });
});

describe("image-tools registration", () => {
  it("registers only generate_image and edit_image and disposes cleanly", async () => {
    const configured = runtime({ apiKey: "test", baseURL: "https://fixture.invalid/v1", model: "image-model" });
    const plugin = configured.agent.use.mock.calls[0]?.[0] as RegisteredChannelPlugin;
    const imageProjection = new EphemeralImageProjectionStore();
    const channelPlugin = await plugin.setup({ type: "guild", platform: "onebot", channelId: "group", guildId: "group" }, {}, { imageProjection });

    expect(configured.resource.get).toHaveBeenCalledWith({ type: "guild", platform: "onebot", channelId: "group", guildId: "group" });
    expect(channelPlugin?.name).toBe("image-tools");
    const tools = channelPlugin?.tools() ?? [];
    expect(tools.map((tool) => tool.name)).toEqual(["generate_image", "edit_image"]);
    expect(tools.every((tool) => tool.description?.includes("每轮合计最多输出 3 张图片"))).toBe(true);
    expect(tools.find((tool) => tool.name === "edit_image")?.description).toContain("用户消息中的 [图片：asset://<32 位十六进制 id>] 就是可编辑的当前频道图片");

    configured.dispose?.();
    expect(configured.disposeAgent).toHaveBeenCalledOnce();
  });

  it.each([undefined, "reference-model", "  reference-model  ", " "])("preserves shared credentials and model routing with editModel %s", async (editModel) => {
    const requests: Array<{ url: string; model: string; authorization: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (url, init) => {
        requests.push({ url: String(url), model: JSON.parse(String(init?.body)).model, authorization: new Headers(init?.headers).get("authorization") });
        return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }] }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const configured = runtime({
      apiKey: "test",
      baseURL: "https://fixture.invalid/v1",
      model: "text-model",
      ...(editModel === undefined ? {} : { editModel }),
      timeout: 7,
    });
    const plugin = configured.agent.use.mock.calls[0]?.[0] as RegisteredChannelPlugin;
    const channel = await plugin.setup({}, {}, { imageProjection: new EphemeralImageProjectionStore() });
    const tools = channel?.tools() ?? [];
    const generate = tools.find((tool) => tool.name === "generate_image")!;
    const edit = tools.find((tool) => tool.name === "edit_image")!;
    const context = (toolCallId: string) => ({ toolCallId, turnId: "routing", messages: [] }) as never;
    await expect(generate.execute({ subjectType: "generic", prompt: "a landscape" } as never, context("text"))).resolves.toMatchObject({
      ok: true,
      model: "text-model",
    });
    const referenceModel = editModel?.trim() || "text-model";
    await expect(
      generate.execute(
        { subjectType: "specific", prompt: "same subject", referenceUris: ["asset://0123456789abcdef0123456789abcdef"] } as never,
        context("reference"),
      ),
    ).resolves.toMatchObject({ ok: true, model: referenceModel });
    await expect(
      edit.execute({ uri: "asset://0123456789abcdef0123456789abcdef", prompt: "change background" } as never, context("edit")),
    ).resolves.toMatchObject({ ok: true, model: referenceModel });
    expect(requests).toEqual([
      { url: "https://fixture.invalid/v1/images/generations", model: "text-model", authorization: "Bearer test" },
      { url: "https://fixture.invalid/v1/images/edits", model: referenceModel, authorization: "Bearer test" },
      { url: "https://fixture.invalid/v1/images/edits", model: referenceModel, authorization: "Bearer test" },
    ]);
    channel?.onTurnFinish?.({}, { turnId: "routing" });
  });

  it("shares a three-output budget across generation and editing, then clears it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG_BYTES).toString("base64") }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const configured = runtime({ apiKey: "test", baseURL: "https://fixture.invalid/v1", model: "image-model" });
    const plugin = configured.agent.use.mock.calls[0]?.[0] as RegisteredChannelPlugin;
    const imageProjection = new EphemeralImageProjectionStore();
    const channelPlugin = await plugin.setup({}, {}, { imageProjection });
    const tools = channelPlugin?.tools() ?? [];
    const generate = tools.find((tool) => tool.name === "generate_image");
    const edit = tools.find((tool) => tool.name === "edit_image");
    const context = (toolCallId: string) => ({ toolCallId, turnId: "turn-1", abortSignal: undefined, messages: [] }) as never;

    await expect(generate?.execute({ subjectType: "generic", prompt: "one" } as never, context("one"))).resolves.toMatchObject({ ok: true });
    await expect(edit?.execute({ uri: "artifact://generate_image/source", prompt: "two" } as never, context("two"))).resolves.toMatchObject({ ok: true });
    await expect(generate?.execute({ subjectType: "generic", prompt: "three" } as never, context("three"))).resolves.toMatchObject({ ok: true });
    await expect(edit?.execute({ uri: "artifact://generate_image/source", prompt: "four" } as never, context("four"))).resolves.toMatchObject({
      ok: false,
      error: { code: "image_budget_exhausted" },
    });
    expect(fetch).toHaveBeenCalledTimes(3);

    channelPlugin?.onTurnFinish?.({}, { turnId: "turn-1" });
    await expect(edit?.execute({ uri: "artifact://generate_image/source", prompt: "after finish" } as never, context("five"))).resolves.toMatchObject({
      ok: true,
    });
    expect(fetch).toHaveBeenCalledTimes(4);
    imageProjection.clearAll();
  });
});
