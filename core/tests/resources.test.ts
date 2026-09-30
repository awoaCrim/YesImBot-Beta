import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { h } from "koishi";

import { createReadTool, createSendMessageTool, type ResourceReadResult } from "../src/agents/tools.js";
import { ChannelArtifactStore } from "../src/resources/artifact.js";
import { ChannelAssetStore } from "../src/resources/asset.js";
import { ChannelResources, detectImageMediaType, prepareOutputSegments, RESOURCE_MAX_BYTES, type ResourceReader } from "../src/resources/index.js";
import { persistElements } from "../src/resources/input.js";
import { PNG_BYTES } from "./helpers/index.js";

const roots: string[] = [];

async function tempRoot(prefix = "yesimbot-resource-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function reader(scheme: string, prompt: string, setup: ResourceReader["setup"]): ResourceReader {
  return { scheme, prompt, setup };
}

async function createResources(overrides: { readTimeoutMs?: number } = {}): Promise<ChannelResources> {
  return new ChannelResources(await tempRoot(), false, overrides.readTimeoutMs ?? 10_000);
}

type ReadTool = AgentTool<{ uri: string }, ResourceReadResult>;

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("shared resource image validation", () => {
  it("exports the sendable byte limit and detects supported image formats from magic bytes", () => {
    expect(RESOURCE_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(detectImageMediaType(PNG_BYTES)).toBe("image/png");
    expect(detectImageMediaType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(detectImageMediaType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
    expect(detectImageMediaType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
    expect(detectImageMediaType(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it("exposes the same validation contract on each channel resource owner", async () => {
    const resources = await createResources();
    expect(resources.maxBytes).toBe(RESOURCE_MAX_BYTES);
    expect(resources.detectImageMediaType(PNG_BYTES)).toBe("image/png");
  });
});

// ---------------------------------------------------------------------------
// session-live input resources
// ---------------------------------------------------------------------------

describe("session-live input resources", () => {
  it("persists an inbound image through the resolved ChannelResources owner", async () => {
    const http = Object.assign(
      vi.fn(async () => ({
        data: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
            controller.close();
          },
        }),
      })),
      { head: vi.fn(async () => ({ get: (name: string) => ({ "content-type": "image/png", "content-length": "4" })[name] ?? null })) },
    );
    const resources = { assets: { put: vi.fn(async () => "0123456789abcdef0123456789abcdef") } };

    const ctx = { http, logger: vi.fn(() => ({ debug: vi.fn() })) };
    const elements = await persistElements(ctx as never, [h("img", { src: "https://example.test/image.png" })], resources as never);

    expect(resources.assets.put).toHaveBeenCalledWith(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(elements).toEqual([h("img", { id: "0123456789abcdef0123456789abcdef" })]);
  });

  it("uses an inbound file name when persisting a text script", async () => {
    const script = new TextEncoder().encode("print('ok')\n");
    const http = Object.assign(
      vi.fn(async () => ({
        data: new ReadableStream({
          start(controller) {
            controller.enqueue(script);
            controller.close();
          },
        }),
      })),
      { head: vi.fn(async () => ({ get: (name: string) => ({ "content-type": "text/plain", "content-length": String(script.byteLength) })[name] ?? null })) },
    );
    const id = "abcdefabcdefabcdefabcdefabcdefab";
    const resources = { assets: { put: vi.fn(async () => id) } };
    const ctx = { http, logger: vi.fn(() => ({ debug: vi.fn() })) };

    const elements = await persistElements(ctx as never, [h("file", { src: "https://example.test/script.py", name: "script.py" })], resources as never);

    expect(resources.assets.put).toHaveBeenCalledWith(script);
    expect(elements).toEqual([h("file", { id, title: "script.py" })]);
  });

  it("persists a base64:// image element without downloading", async () => {
    const http = vi.fn();
    const resources = { assets: { put: vi.fn(async () => "0123456789abcdef0123456789abcdef") } };
    const ctx = { http, logger: vi.fn(() => ({ debug: vi.fn() })) };

    const elements = await persistElements(ctx as never, [h("img", { src: `base64://${Buffer.from(PNG_BYTES).toString("base64")}` })], resources as never);

    expect(resources.assets.put).toHaveBeenCalledWith(PNG_BYTES);
    expect(elements).toEqual([h("img", { id: "0123456789abcdef0123456789abcdef" })]);
    expect(http).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ChannelResources binary stores
// ---------------------------------------------------------------------------

describe("ChannelResources binary stores", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const id = createHash("sha256").update(PNG).digest("hex").slice(0, 32);

  it("keeps asset IDs and artifact URIs, metadata, and clear lifecycles distinct", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channel-resources-"));
    roots.push(root);
    const assets = new ChannelAssetStore(root);
    const artifacts = new ChannelArtifactStore(root);
    const source = PNG.slice();

    expect(await assets.put(source)).toBe(id);
    source[0] = 0;
    const uri = await artifacts.forTool("capture").put(PNG, { filename: "capture.png", mediaType: "image/png" });

    await expect(assets.get(id)).resolves.toEqual(PNG);
    await expect(artifacts.open(uri)).resolves.toEqual({ bytes: PNG, filename: "capture.png", mediaType: "image/png" });
    await assets.clear();
    await expect(assets.get(id)).rejects.toThrow();
    await expect(artifacts.open(uri)).resolves.toMatchObject({ bytes: PNG });
  });
});

// ---------------------------------------------------------------------------
// send_message tool
// ---------------------------------------------------------------------------

const PACING = { charactersPerSecond: 10_000, maxTotalDelayMs: 1 };

describe("send_message tool", () => {
  it("documents the tool-only delivery contract and ends the turn unless asked to continue", async () => {
    const resources = await createResources();
    const sendMessage = vi.fn(async () => ["message-1"]);
    const tool = createSendMessageTool({ bot: { sendMessage } as never, channelId: "room", resources, pacing: PACING, innerThought: true });

    expect(tool.description).not.toContain("唯一途径");
    expect(tool.description).toContain("你的普通文本输出不会被发送");
    expect(tool.description).toContain("其他实际提供的发送工具");
    expect(tool.description).toContain("必须检查 ok");
    expect(tool.description).toContain("inner_thought");
    expect(tool.description).toContain("不要使用 group: 前缀");
    expect(tool.description).toContain("同一次调用中的 messages 属于同一个回应单元");
    expect(tool.description).toContain("工具、搜索和图片结果只是材料");
    expect(tool.description).toContain("保持一致的说话身份、语域和情绪力度");
    expect(tool.description).not.toContain("不要用空行分段");
    expect(tool.description).toContain("解析失败的资源元素会被丢弃");
    expect(JSON.stringify(tool.inputSchema)).toContain("不要使用 group: 前缀");
    expect(JSON.stringify(tool.inputSchema)).toContain("语域、说话身份和情绪力度");
    expect(typeof tool.terminal).toBe("function");
    expect((tool.terminal as (input: unknown) => boolean)({ messages: ["hi"] })).toBe(true);
    expect((tool.terminal as (input: unknown) => boolean)({ messages: ["hi"], continue: true })).toBe(false);
  });

  it.each([
    [{ messages: [] }, "messages is empty"],
    [{ messages: [""] }, "messages must be non-empty strings"],
    [{ messages: ["valid", 1] }, "messages must be non-empty strings"],
    [{ messages: ["valid"], mode: "invalid" }, 'mode must be "element" or "raw"'],
  ])("rejects invalid input before delivery (%j)", async (input, message) => {
    const resources = await createResources();
    const sendMessage = vi.fn(async () => ["message-1"]);
    const tool = createSendMessageTool({ bot: { sendMessage } as never, channelId: "room", resources, pacing: PACING, innerThought: false });

    await expect(tool.execute(input as never, { toolCallId: "call-1", turnId: "turn-1", abortSignal: undefined } as never)).resolves.toEqual({
      ok: false,
      error: { name: "InvalidInput", message },
      sent: [],
      failedAt: 0,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("uses the current channel when an empty channel is supplied", async () => {
    const resources = await createResources();
    const sendMessage = vi.fn(async () => ["message-1"]);
    const tool = createSendMessageTool({ bot: { sendMessage } as never, channelId: "room", resources, pacing: PACING, innerThought: false });

    await expect(
      tool.execute({ messages: ["hello"], channel: "" } as never, { toolCallId: "call-1", turnId: "turn-1", abortSignal: undefined } as never),
    ).resolves.toMatchObject({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith("room", expect.any(Array));
  });

  it("omits the inner_thought field when the monologue protocol is disabled", async () => {
    const resources = await createResources();
    const tool = createSendMessageTool({
      bot: { sendMessage: vi.fn(async () => []) } as never,
      channelId: "room",
      resources,
      pacing: PACING,
      innerThought: false,
    });

    expect(tool.description).not.toContain("inner_thought");
    expect(JSON.stringify(tool.inputSchema)).not.toContain("inner_thought");
  });

  it("sends to the current channel by default, one platform message per list item", async () => {
    const resources = await createResources();
    const sent: unknown[][] = [];
    const sendMessage = vi.fn(async (channelId: string, elements: readonly unknown[]) => {
      sent.push([channelId, ...elements]);
      return [`message-${sent.length}`];
    });
    const tool = createSendMessageTool({ bot: { sendMessage } as never, channelId: "room", resources, pacing: PACING, innerThought: false });

    await expect(
      tool.execute({ messages: ["先说结论", "再说原因"] }, { toolCallId: "call-1", turnId: "turn-1", abortSignal: undefined } as never),
    ).resolves.toEqual({ ok: true, messageIds: ["message-1", "message-2"], count: 2 });
    expect(sent.map((entry) => entry[0])).toEqual(["room", "room"]);
  });

  it.each(["element", "raw"] as const)("does not treat blank lines as message boundaries in %s mode", async (mode) => {
    const resources = await createResources();
    const sendMessage = vi.fn(async () => ["message-1"]);
    const tool = createSendMessageTool({ bot: { sendMessage } as never, channelId: "room", resources, pacing: PACING, innerThought: false });

    await expect(
      tool.execute({ messages: ["第一段\n\n第二段"], mode }, { toolCallId: "call-1", turnId: "turn-1", abortSignal: undefined } as never),
    ).resolves.toEqual({ ok: true, messageIds: ["message-1"], count: 1 });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith("room", [h.text("第一段\n\n第二段")]);
  });

  it("keeps explicit message elements as delivery boundaries", async () => {
    const resources = await createResources();
    const sendMessage = vi.fn(async () => [`message-${sendMessage.mock.calls.length}`]);
    const tool = createSendMessageTool({ bot: { sendMessage } as never, channelId: "room", resources, pacing: PACING, innerThought: false });

    await expect(tool.execute({ messages: ["一<message/>二"] }, { toolCallId: "call-1", turnId: "turn-1", abortSignal: undefined } as never)).resolves.toEqual({
      ok: true,
      messageIds: ["message-1", "message-2"],
      count: 1,
    });
    expect(sendMessage.mock.calls.map((call) => call[1])).toEqual([[h.text("一")], [h.text("二")]]);
  });

  it("normalizes OneBot group-prefixed channel IDs before delivery", async () => {
    const resources = await createResources();
    const sendMessage = vi.fn(async () => ["message-1"]);
    const tool = createSendMessageTool({
      bot: { platform: "onebot", sendMessage } as never,
      channelId: "private:1049700117",
      resources,
      pacing: PACING,
      innerThought: false,
    });

    await expect(
      tool.execute({ messages: ["早报"], channel: "group:730867358" }, { toolCallId: "call-1", turnId: "turn-1", abortSignal: undefined } as never),
    ).resolves.toMatchObject({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith("730867358", expect.any(Array));
  });
  it("resolves resource URIs in element mode and reports each delivered id", async () => {
    const resources = await createResources();
    resources.use(reader("workspace", "workspace 文件引用", async () => ({ bytes: PNG_BYTES, mediaType: "image/png" })));
    const sent: unknown[][] = [];
    const sendMessage = vi.fn(async (_channelId: string, elements: readonly unknown[]) => {
      sent.push([...elements]);
      return [`message-${sent.length}`];
    });
    const tool = createSendMessageTool({ bot: { sendMessage } as never, channelId: "room", resources, pacing: PACING, innerThought: false });

    await expect(
      tool.execute({ messages: ["hello", '<img src="workspace:///chart.png"/>'], channel: "other-room" }, {
        toolCallId: "call-1",
        turnId: "turn-1",
        abortSignal: undefined,
      } as never),
    ).resolves.toEqual({ ok: true, messageIds: ["message-1", "message-2"], count: 2 });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sent[1]?.[0]).toMatchObject({ type: "img", attrs: { src: expect.stringContaining("data:image/png;base64,") } });
  });

  it("delivers raw mode literally without parsing elements", async () => {
    const resources = await createResources();
    const sent: unknown[][] = [];
    const sendMessage = vi.fn(async (_channelId: string, elements: readonly unknown[]) => {
      sent.push([...elements]);
      return ["message-1"];
    });
    const tool = createSendMessageTool({ bot: { sendMessage } as never, channelId: "room", resources, pacing: PACING, innerThought: false });

    await expect(
      tool.execute({ messages: ['当 x<10 且 y>5 时 <at id="1"/>'], mode: "raw" }, {
        toolCallId: "call-1",
        turnId: "turn-1",
        abortSignal: undefined,
      } as never),
    ).resolves.toMatchObject({ ok: true });
    expect(sent[0]).toEqual([h.text('当 x<10 且 y>5 时 <at id="1"/>')]);
  });

  it("stops at the first failure and reports what was already sent", async () => {
    const resources = await createResources();
    const failed: unknown[] = [];
    const sendMessage = vi.fn(async () => {
      if (sendMessage.mock.calls.length === 2) throw new Error("offline");
      return ["message-1"];
    });
    const tool = createSendMessageTool({
      bot: { sendMessage } as never,
      channelId: "room",
      resources,
      pacing: PACING,
      innerThought: false,
      onFailed: (notice) => failed.push(notice),
    });

    await expect(tool.execute({ messages: ["一", "二", "三"] }, { toolCallId: "call-1", turnId: "turn-1", abortSignal: undefined } as never)).resolves.toEqual({
      ok: false,
      error: { name: "Error", message: "offline" },
      sent: ["message-1"],
      failedAt: 1,
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(failed).toEqual([{ channelId: "room", turnId: "turn-1", failedAt: 1, total: 3, error: { name: "Error", message: "offline" } }]);
  });

  it("reports every delivered message to the owner", async () => {
    const resources = await createResources();
    const delivered: unknown[] = [];
    const tool = createSendMessageTool({
      bot: { sendMessage: vi.fn(async () => ["message-1"]) } as never,
      channelId: "room",
      resources,
      pacing: PACING,
      innerThought: false,
      onDelivered: (notice) => delivered.push(notice),
    });

    await tool.execute({ messages: ["hi"] }, { toolCallId: "call-1", turnId: "turn-1", abortSignal: undefined } as never);
    expect(delivered).toEqual([{ channelId: "room", messageId: "message-1", turnId: "turn-1", text: "hi" }]);
  });
});

// ---------------------------------------------------------------------------
// ChannelResources raw open
// ---------------------------------------------------------------------------

describe("ChannelResources raw open", () => {
  it("opens built-in assets and dispatches a registered reader", async () => {
    const resources = await createResources();
    const id = await resources.assets.put(new Uint8Array([1, 2, 3]));
    await expect(resources.open(`asset://${id}`)).resolves.toMatchObject({ bytes: new Uint8Array([1, 2, 3]) });
    const setup = vi.fn(async () => ({ bytes: new Uint8Array([4]), filename: "ok.txt" }));
    resources.use({ scheme: "test", prompt: "test reader", setup });
    await expect(resources.open("test://host/file")).resolves.toMatchObject({ filename: "ok.txt" });
    expect(resources.listReaders()).toHaveLength(1);
  });

  it("returns undefined for malformed and unavailable URIs", async () => {
    const resources = await createResources();
    await expect(resources.open("asset://short")).resolves.toBeUndefined();
    await expect(resources.open("missing://host/file")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// read tool resource errors
// ---------------------------------------------------------------------------

describe("read tool resource errors", () => {
  it("rejects registration of reserved schemes", async () => {
    const resources = await createResources();
    const open = async () => ({ bytes: PNG_BYTES });
    expect(() => resources.use(reader("asset", "x", open))).toThrow();
    expect(() => resources.use(reader("artifact", "x", open))).toThrow();
  });

  it("rejects duplicate scheme registrations", async () => {
    const resources = await createResources();
    const open = async () => ({ bytes: PNG_BYTES });
    resources.use(reader("skill", "first", open));
    expect(() => resources.use(reader("skill", "second", open))).toThrow();
  });

  it("rejects traversal attempts", async () => {
    const resources = await createResources();
    const tool = createReadTool(resources, false);
    await expect(tool.execute({ uri: "workspace:///../secret" }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({
      error: "invalid_resource_uri",
    });
  });

  it("returns unavailable for unregistered schemes", async () => {
    const resources = await createResources();
    const tool = createReadTool(resources, false);
    await expect(tool.execute({ uri: "skill://csv/SKILL.md" }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({
      error: "resource_unavailable",
    });
  });

  it("respects timeout configuration", async () => {
    const resources = await createResources({ readTimeoutMs: 1 });
    resources.use(
      reader("test", "test", async (_resources, _uri, { signal }) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve({ bytes: PNG_BYTES }), 100);
          signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(new Error("Aborted"));
          });
        });
      }),
    );
    const tool = createReadTool(resources, false);
    await expect(tool.execute({ uri: "test:///file" }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({ error: "timeout" });
  });

  it("enforces a hard deadline when an opener ignores abort", async () => {
    const resources = await createResources({ readTimeoutMs: 1 });
    resources.use(reader("slow", "slow", async () => Promise.withResolvers<{ bytes: Uint8Array }>().promise));
    const tool = createReadTool(resources, false);
    await expect(tool.execute({ uri: "slow:///file" }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({ error: "timeout" });
    await expect(resources.open("slow:///file")).resolves.toBeUndefined();
  });

  it("aborts an opener when the current turn is cancelled", async () => {
    const resources = await createResources();
    resources.use(reader("abort", "abort", async () => Promise.withResolvers<{ bytes: Uint8Array }>().promise));
    const tool = createReadTool(resources, false);
    const controller = new AbortController();
    const pending = tool.execute({ uri: "abort:///file" }, { toolCallId: "c", abortSignal: controller.signal } as never);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ error: expect.any(String) });
  });

  it("rejects unbounded and unsafe registered opener results", async () => {
    const resources = await createResources();
    resources.use(reader("unsafe", "unsafe", async () => ({ bytes: new Uint8Array([1]), filename: "../secret.txt" })));
    const tool = createReadTool(resources, false);
    await expect(tool.execute({ uri: "unsafe:///file" }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({
      error: "resource_read_failed",
    });

    const oversizedResources = await createResources();
    oversizedResources.use(reader("large", "large", async () => ({ bytes: new Uint8Array(5 * 1024 * 1024 + 1) })));
    const oversizedTool = createReadTool(oversizedResources, false);
    await expect(oversizedTool.execute({ uri: "large:///file" }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({
      error: "resource_too_large",
    });
  });

  it("rejects an empty path before dispatching a custom scheme", async () => {
    const resources = await createResources();
    const open = vi.fn(async () => ({ bytes: PNG_BYTES }));
    resources.use(reader("custom", "custom", open));
    const tool = createReadTool(resources, false);
    await expect(tool.execute({ uri: "custom:///" }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({
      error: "invalid_resource_uri",
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("marks long text reads with a bounded truncation marker", async () => {
    const resources = await createResources();
    resources.use(reader("text", "text", async () => ({ bytes: new TextEncoder().encode("x".repeat(30_001)) })));
    const tool = createReadTool(resources, false);
    const result = await tool.execute({ uri: "text:///file" }, { toolCallId: "c", abortSignal: undefined } as never);
    expect(result.text).toHaveLength(30_000);
    expect(result.text).toContain("内容已截断");
  });

  it("rejects authority, query, fragment, and encoded traversal", async () => {
    const resources = await createResources();
    const tool = createReadTool(resources, false);
    for (const uri of [
      "asset://a6e2b32e1d9d64b2e906ac5c3216d18f?x=1",
      "artifact://mcp/x#frag",
      "workspace://host/path",
      "workspace:///reports/%2e%2e/secret.txt",
      "asset://SHORT",
      "asset://a6e2b32e1d9d64b2e906ac5c3216d18f/extra",
    ]) {
      await expect(tool.execute({ uri }, { toolCallId: "c", abortSignal: undefined } as never)).resolves.toMatchObject({ error: "invalid_resource_uri" });
    }
  });
});

// ---------------------------------------------------------------------------
// prepareOutputSegments
// ---------------------------------------------------------------------------

describe("prepareOutputSegments", () => {
  async function resourcesWith(open: ResourceReader["setup"], registrations: Map<string, ResourceReader> = new Map()): Promise<ChannelResources> {
    const resources = await createResources();
    for (const [_scheme, r] of registrations) resources.use(r);
    if (!registrations.has("workspace")) {
      resources.use(reader("workspace", "workspace 文件引用", open));
    }
    return resources;
  }

  it("resolves a workspace image source to a data URL before delivery", async () => {
    const resources = await resourcesWith(async () => ({ bytes: PNG_BYTES, mediaType: "image/png", filename: "chart.png" }));

    const prepared = await prepareOutputSegments(
      [
        [
          { type: "text", attrs: { content: "chart:" }, children: [] },
          { type: "img", attrs: { src: "workspace:///images/chart.png" }, children: [] },
        ],
      ],
      resources,
    );

    const img = prepared[0]![1] as { type: string; attrs: { src: string } };
    expect(img.attrs.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(img.attrs.src).not.toContain("workspace://");
    expect(prepared[0]![0]).toMatchObject({ type: "text" });
  });

  it("resolves an artifact image through the same reader path", async () => {
    const resources = await createResources();
    const uri = await resources.artifacts.forTool("mcp_screenshot").put(PNG_BYTES, { mediaType: "image/png", filename: "screen.png" });

    const prepared = await prepareOutputSegments([[{ type: "img", attrs: { src: uri }, children: [] }]], resources);

    const img = prepared[0]![0] as { type: string; attrs: { src: string } };
    expect(img.attrs.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(img.attrs.src).not.toContain("artifact://");
  });

  it("omits an unavailable resource and preserves sibling content", async () => {
    const resources = await resourcesWith(async () => undefined);

    const prepared = await prepareOutputSegments(
      [
        [
          { type: "text", attrs: { content: "keep" }, children: [] },
          { type: "img", attrs: { src: "artifact://mcp_screenshot/019d3b7e-1bd0-7e4f-9c5d-5bf3fd41f1d4" }, children: [] },
        ],
      ],
      resources,
    );

    expect(prepared[0]).toHaveLength(1);
    expect(prepared[0]![0]).toMatchObject({ type: "text", attrs: { content: "keep" } });
  });

  it("leaves unrecognized elements and non-resource sources untouched", async () => {
    const resources = await resourcesWith(async () => undefined);

    const prepared = await prepareOutputSegments(
      [
        [
          { type: "at", attrs: { id: "u1" }, children: [] },
          { type: "img", attrs: { src: "https://example.test/x.png" }, children: [] },
        ],
      ],
      resources,
    );

    expect(prepared[0]).toHaveLength(2);
    expect(prepared[0]![0]).toMatchObject({ type: "at" });
    expect(prepared[0]![1]).toMatchObject({ attrs: { src: "https://example.test/x.png" } });
  });

  it("requires a complete asset ID for output resolution", async () => {
    const resources = await createResources();
    const id = await resources.assets.put(PNG_BYTES);

    const full = await prepareOutputSegments([[{ type: "img", attrs: { src: `asset://${id}` }, children: [] }]], resources);
    expect(full[0]).toHaveLength(1);
    expect((full[0]![0] as { attrs: { src: string } }).attrs.src).toContain("data:image/png;base64,");

    const prefix = await prepareOutputSegments([[{ type: "img", attrs: { src: `asset://${id.slice(0, 7)}` }, children: [] }]], resources);
    expect(prefix).toHaveLength(0);
  });

  it("drops a segment that becomes empty after resource omission", async () => {
    const resources = await resourcesWith(async () => undefined);

    const prepared = await prepareOutputSegments(
      [[{ type: "img", attrs: { src: "artifact://missing/019d3b7e-1bd0-7e4f-9c5d-5bf3fd41f1d4" }, children: [] }]],
      resources,
    );

    expect(prepared).toHaveLength(0);
  });

  it("materializes ordinary files with a generic MIME fallback", async () => {
    const resources = await resourcesWith(async () => ({ bytes: new Uint8Array([1, 2, 3]), filename: "report.bin" }));
    const prepared = await prepareOutputSegments([[{ type: "file", attrs: { src: "workspace:///reports/report.bin" }, children: [] }]], resources);
    expect((prepared[0]![0] as { attrs: { src: string } }).attrs.src).toContain("data:application/octet-stream;base64,");
  });

  it("leaves audio and video output untouched", async () => {
    const open = vi.fn(async () => ({ bytes: PNG_BYTES, mediaType: "image/png" }));
    const resources = await resourcesWith(open);
    const segments = [
      [
        { type: "audio", attrs: { src: "workspace:///sound.mp3" }, children: [] },
        { type: "video", attrs: { src: "workspace:///movie.mp4" }, children: [] },
      ],
    ];
    const prepared = await prepareOutputSegments(segments, resources);
    expect(prepared).toEqual(segments);
    expect(open).not.toHaveBeenCalled();
  });

  it("does not trust an image MIME hint for arbitrary output bytes", async () => {
    const resources = await resourcesWith(async () => ({ bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" }));
    const prepared = await prepareOutputSegments([[{ type: "img", attrs: { src: "workspace:///fake.png" }, children: [] }]], resources);
    expect(prepared).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// read tool model projection
// ---------------------------------------------------------------------------

describe("read tool model projection", () => {
  async function createTool(
    overrides: { mode?: "native" | "vision" | "unavailable"; imageInput?: boolean; visionModel?: unknown } = {},
  ): Promise<{ tool: ReadTool; resources: ChannelResources }> {
    const resources = await createResources();
    return {
      tool: createReadTool(new ChannelResources(resources.path, overrides.imageInput ?? false), {
        mode: overrides.mode ?? "unavailable",
        visionModel: overrides.visionModel as never,
      }),
      resources,
    };
  }

  async function readAndProject(tool: ReadTool, uri: string, toolCallId = "call-1") {
    const result = await tool.execute({ uri }, { toolCallId, turnId: "turn-1", abortSignal: undefined } as never);
    const output = await tool.toModelOutput!({ toolCallId, input: { uri }, output: result });
    return { result, output };
  }

  it("projects native image bytes repeatedly during the bounded live-turn window", async () => {
    const { tool, resources } = await createTool({ mode: "native", imageInput: true });
    const id = await resources.assets.put(PNG_BYTES);
    const { result, output } = await readAndProject(tool, `asset://${id}`);

    expect(result).toMatchObject({ uri: `asset://${id}`, mediaType: "image/png", imageMode: "native" });
    for (const projected of [
      output,
      await tool.toModelOutput!({ toolCallId: "call-1", input: { uri: `asset://${id}` }, output: result }),
      await tool.toModelOutput!({ toolCallId: "call-1", input: { uri: `asset://${id}` }, output: result }),
    ]) {
      if (projected.type !== "content") throw new Error("expected multimodal output");
      expect(projected.value[0]).toMatchObject({ type: "text" });
      const image = projected.value[1];
      if (!image || image.type !== "image-data") throw new Error("expected image-data part");
      expect(image.mediaType).toBe("image/png");
      expect(Buffer.from(image.data, "base64")).toEqual(Buffer.from(PNG_BYTES));
    }
  });

  it("expires pending native images after the bounded live-turn TTL", async () => {
    vi.useFakeTimers();
    const { tool, resources } = await createTool({ mode: "native", imageInput: true });
    const id = await resources.assets.put(PNG_BYTES);
    const uri = `asset://${id}`;
    const result = await tool.execute({ uri }, { toolCallId: "ttl-call", turnId: "turn-1", abortSignal: undefined } as never);

    await vi.advanceTimersByTimeAsync(60_001);

    const projected = await tool.toModelOutput!({ toolCallId: "ttl-call", input: { uri }, output: result });
    expect(projected.type).toBe("json");
    expect(JSON.stringify(projected)).not.toContain(Buffer.from(PNG_BYTES).toString("base64"));
  });

  it("clears pending native images on abort", async () => {
    const { tool, resources } = await createTool({ mode: "native", imageInput: true });
    const id = await resources.assets.put(PNG_BYTES);
    const uri = `asset://${id}`;
    const controller = new AbortController();
    const result = await tool.execute({ uri }, { toolCallId: "abort-call", turnId: "turn-1", abortSignal: controller.signal } as never);

    controller.abort();

    const projected = await tool.toModelOutput!({ toolCallId: "abort-call", input: { uri }, output: result });
    expect(projected.type).toBe("json");
  });

  it("clears stale bytes when a reused tool call ID fails", async () => {
    const { tool, resources } = await createTool({ mode: "native", imageInput: true });
    const id = await resources.assets.put(PNG_BYTES);
    const uri = `asset://${id}`;
    await tool.execute({ uri }, { toolCallId: "reused-call", turnId: "turn-1", abortSignal: undefined } as never);
    const failed = await tool.execute({ uri: `asset://${"a".repeat(32)}` }, { toolCallId: "reused-call", turnId: "turn-1", abortSignal: undefined } as never);

    const projected = await tool.toModelOutput!({ toolCallId: "reused-call", input: { uri }, output: failed });
    expect(projected.type).toBe("json");
    expect(JSON.stringify(projected)).not.toContain(Buffer.from(PNG_BYTES).toString("base64"));
  });

  it("evicts the oldest pending native image when capacity is reached", async () => {
    const { tool, resources } = await createTool({ mode: "native", imageInput: true });
    const id = await resources.assets.put(PNG_BYTES);
    const uri = `asset://${id}`;
    const results = [];
    for (let index = 0; index < 17; index += 1) {
      results.push(await tool.execute({ uri }, { toolCallId: `capacity-${index}`, turnId: "turn-1", abortSignal: undefined } as never));
    }

    expect((await tool.toModelOutput!({ toolCallId: "capacity-0", input: { uri }, output: results[0] })).type).toBe("json");
    expect((await tool.toModelOutput!({ toolCallId: "capacity-16", input: { uri }, output: results[16] })).type).toBe("content");
  });

  it("returns an explicit unavailable result when no image route exists", async () => {
    const { tool, resources } = await createTool({ mode: "unavailable", imageInput: true });
    const id = await resources.assets.put(PNG_BYTES);
    const { result, output } = await readAndProject(tool, `asset://${id}`);

    expect(result).toMatchObject({ imageMode: "unavailable", error: "image_input_unavailable" });
    expect(output.type).toBe("json");
  });

  it("does not trust an image MIME hint for arbitrary bytes", async () => {
    const resources = await createResources();
    resources.use(reader("fake", "fake", async () => ({ bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" })));
    const tool = createReadTool(resources, { mode: "native" });
    const { result, output } = await readAndProject(tool, "fake:///image");

    expect(result).toMatchObject({ error: "invalid_image_data" });
    expect(output.type).toBe("json");
  });

  it("keeps a JSON result when the read fails", async () => {
    const { tool } = await createTool({ mode: "native", imageInput: true });
    const { result, output } = await readAndProject(tool, `asset://${"a".repeat(32)}`);

    expect(result).toMatchObject({ error: "resource_not_found" });
    expect(output.type).toBe("json");
  });

  it("describes the selected image route", async () => {
    const { tool: native } = await createTool({ mode: "native", imageInput: true });
    expect(native.description).toContain("图片字节将随结果返回");

    const { tool: vision } = await createTool({ mode: "vision", imageInput: false, visionModel: {} });
    expect(vision.description).toContain("自动调用视觉模型");

    const { tool: blind } = await createTool({ mode: "unavailable", imageInput: false });
    expect(blind.description).toContain("无法查看图片内容");
  });

  it("returns artifact image bytes through the native path", async () => {
    const { tool, resources } = await createTool({ mode: "native", imageInput: true });
    const uri = await resources.artifacts.forTool("mcp_test").put(PNG_BYTES, { mediaType: "image/png" });

    expect((await readAndProject(tool, uri)).output.type).toBe("content");
  });
});
