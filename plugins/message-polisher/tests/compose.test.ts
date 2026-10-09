import type { ReplyLayoutComposeRequest } from "koishi-plugin-yesimbot";
import { afterEach, describe, expect, it, vi } from "vitest";
const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), generateText }));
vi.mock("koishi", async () => import("@koishijs/core"));
import MessagePolisherPlugin, { buildLayoutSystemPrompt, parseReplyLayout } from "../src/index.js";
const channel = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
const request: ReplyLayoutComposeRequest = {
  mode: "reply-layout",
  stage: 1,
  facts: ["确认订单 12 件"],
  intent: "告知完成",
  verbatim: ["npm run build"],
  turnContext: [{ kind: "user", content: "当前问题" }],
  profile: { persona: "完整主身份", characterDefinition: "完整角色卡", roleInstructions: "完整交流示例" },
  sticker: { status: "eligible", catalog: [{ category: "reaction", count: 1 }], previewAvailable: true },
};
const textLayout = '{"kind":"layout","parts":[{"kind":"text","text":"订单 12 件确认啦，npm run build"}]}';
function plugin(image = false) {
  return new MessagePolisherPlugin(
    {
      on: vi.fn(),
      logger: () => ({ warn: vi.fn() }),
      yesimbot: { model: { resolveChatModel: () => ({ model: {}, entry: { modalities: { input: image ? ["text", "image"] : ["text"] } } }) } },
    } as never,
    { model: "mock:composer", mode: "rewrite", temperature: 0.5, timeoutMs: 1000 },
  );
}
afterEach(() => {
  generateText.mockReset();
  vi.restoreAllMocks();
});

describe("full-layout composer", () => {
  it("receives complete live identity and outward data, not a main-authored draft", async () => {
    generateText.mockResolvedValue({ text: textLayout, finishReason: "stop" });
    expect(await plugin().replyLayout.compose(request, channel)).toMatchObject({ kind: "layout" });
    const input = generateText.mock.calls[0]![0];
    expect(input.system).toContain("完整主身份");
    expect(input.system).toContain("完整角色卡");
    expect(input.system).toContain("完整交流示例");
    expect(input.system).not.toContain("保持消息条数不变");
    expect(input.messages[0].content).toContain("告知完成");
    expect(input.messages[0].content).toContain("npm run build");
    expect(buildLayoutSystemPrompt({ ...request.profile, persona: "" })).toContain("角色卡单独定义当前身份");
  });
  it("first pass may ask once for an exact existing category; no second pass or consumed request", () => {
    const preview = '{"kind":"preview","selector":{"category":"reaction"}}';
    expect(parseReplyLayout(preview, request)).toEqual({ kind: "preview", selector: { category: "reaction" } });
    for (const changed of [
      { ...request, stage: 2 as const },
      { ...request, sticker: { ...request.sticker, status: "consumed" as const } },
      { ...request, sticker: { ...request.sticker, previewAvailable: false } },
    ])
      expect(parseReplyLayout(preview, changed)).toBeUndefined();
    expect(parseReplyLayout('{"kind":"preview","selector":{"category":"guess"}}', request)).toBeUndefined();
  });
  it("authorized native frames are multimodal user input, never serialized frame bytes or tool results", async () => {
    const image = new Uint8Array([1, 2, 3]);
    generateText.mockResolvedValue({ text: textLayout, finishReason: "stop" });
    const viewed = {
      ...request,
      sticker: {
        ...request.sticker,
        imageInput: true,
        view: {
          stickerId: "s",
          contentHash: "a".repeat(64),
          mediaType: "image/png",
          mode: "native" as const,
          frames: [{ bytes: image, mediaType: "image/png", label: "actual frame 1" }],
        },
      },
    };
    expect(await plugin(true).replyLayout.compose(viewed, channel)).toBeDefined();
    const input = generateText.mock.calls[0]![0];
    expect(input.messages).toEqual([
      {
        role: "user",
        content: [expect.objectContaining({ type: "text" }), { type: "text", text: "actual frame 1" }, { type: "image", image, mediaType: "image/png" }],
      },
    ]);
    expect(input.messages[0].content[0].text).not.toMatch(/"bytes"|"0":1/);
    generateText.mockClear();
    expect(await plugin(false).replyLayout.compose(viewed, channel)).toBeUndefined();
    expect(generateText).not.toHaveBeenCalled();
  });
  it.each(["length", "content-filter", "error", undefined])("non-stop finish %s is not accepted or retried", async (finishReason) => {
    generateText.mockResolvedValue({ text: textLayout, finishReason });
    expect(await plugin().replyLayout.compose(request, channel)).toBeUndefined();
    expect(generateText).toHaveBeenCalledOnce();
  });
  it("bounds a generation that ignores cancellation, with no retry", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    generateText.mockImplementation(() => new Promise(() => {}));
    const pending = plugin().replyLayout.compose(request, channel);
    deadline.abort();
    expect(await pending).toBeUndefined();
    expect(generateText).toHaveBeenCalledOnce();
  });
  it("strict layout bounds reject unknown parts, extra controls and overlong output", () => {
    for (const parts of [
      [],
      Array(13).fill({ kind: "text", text: "x" }),
      [{ kind: "unknown", text: "x" }],
      [{ kind: "text", text: "x", continue: true }],
      [{ kind: "text", text: "x".repeat(32768) }],
    ])
      expect(parseReplyLayout(JSON.stringify({ kind: "layout", parts }), request)).toBeUndefined();
  });
});
