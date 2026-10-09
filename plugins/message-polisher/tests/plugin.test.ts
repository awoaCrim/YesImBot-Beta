import { afterEach, describe, expect, it, vi } from "vitest";
const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), generateText }));
vi.mock("koishi", async () => import("@koishijs/core"));
import type { PolisherRequest, ReplyLayoutComposeRequest } from "koishi-plugin-yesimbot";

import MessagePolisherPlugin, { buildSystemPrompt, buildUserPrompt, Config, parsePolishedMessages } from "../src/index.js";
const scope = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
const legacy: PolisherRequest = {
  facts: ["工具确认：12"],
  messages: ["原稿 @bob 12 asset://abc", "第二条"],
  profile: { persona: "当前 PERSONA", roleInstructions: "角色卡指令", characterDefinition: "角色卡定义" },
  turnContext: [
    { kind: "user", content: "当前用户问题：天气怎么样？[图片]" },
    { kind: "tool-result", toolName: "web_search", content: "天气预报" },
  ],
};
const request: ReplyLayoutComposeRequest = {
  mode: "reply-layout",
  stage: 1,
  facts: legacy.facts,
  intent: "回答查询",
  verbatim: [],
  profile: legacy.profile,
  turnContext: legacy.turnContext,
  sticker: { status: "unavailable", catalog: [] },
};
function setup(model: unknown = { id: "polisher" }, modelId = "test:polisher", mode?: "rewrite" | "compose") {
  const dispose = vi.fn();
  const use = vi.fn(() => dispose);
  const resolveChatModel = vi.fn(() => {
    if (!model) throw new Error("unavailable");
    return { model, entry: { modalities: { input: ["text", "image"] } } };
  });
  const resolveAuxiliaryModel = vi.fn(() => {
    throw new Error("auxiliary must not be used");
  });
  const ctx = { logger: () => ({ warn: vi.fn() }), on: vi.fn(), yesimbot: { polisher: { use }, model: { resolveChatModel, resolveAuxiliaryModel } } } as never;
  return {
    plugin: new MessagePolisherPlugin(ctx, { model: modelId, mode, temperature: 0.4, timeoutMs: 1000 }),
    use,
    dispose,
    resolveChatModel,
    resolveAuxiliaryModel,
  };
}
afterEach(() => {
  generateText.mockReset();
  vi.restoreAllMocks();
});

describe("official full-layout registration", () => {
  it("empty model does not register; nonempty unavailable model still owns B", () => {
    expect(Config({} as never)).toMatchObject({ model: "", mode: "rewrite", temperature: 0.5, timeoutMs: 8000 });
    const configured = setup(null);
    configured.plugin.start();
    expect(configured.use).toHaveBeenCalledWith(configured.plugin);
    expect(configured.plugin.replyLayout.version).toBe(1);
    configured.plugin.stop();
    expect(configured.dispose).toHaveBeenCalledOnce();
    const empty = setup(undefined, "");
    empty.plugin.start();
    expect(empty.use).not.toHaveBeenCalled();
  });
  it.each([undefined, "rewrite", "compose"] as const)("old config %s is full B without a draft", async (mode) => {
    const f = setup(undefined, "test:polisher", mode);
    expect(f.plugin.mode).toBe("compose");
    generateText.mockResolvedValue({ text: '{"kind":"layout","parts":[{"kind":"text","text":"结果 12"}]}', finishReason: "stop" });
    expect(await f.plugin.replyLayout.compose(request, scope)).toMatchObject({ kind: "layout", parts: [{ text: "结果 12" }] });
    expect(f.resolveChatModel).toHaveBeenCalledWith("test:polisher", scope);
    expect(f.resolveAuxiliaryModel).not.toHaveBeenCalled();
    const input = generateText.mock.calls[0]![0];
    expect(input).toMatchObject({ model: { id: "polisher" }, maxRetries: 0, maxOutputTokens: 4096, temperature: 0.4 });
    expect(input.system).toContain("当前 PERSONA");
    expect(input.system).toContain("角色卡定义");
    expect(input.system).toContain("角色卡指令");
    expect(input.messages[0].content).toContain("工具确认：12");
    expect(input.messages[0].content).toContain("web_search");
    expect(JSON.stringify(input)).not.toContain("原稿 @bob");
    expect(JSON.stringify(input.messages)).not.toContain("inner_thought");
  });
  it("direct legacy rewrite cannot restore an official draft lane", async () => {
    expect(await setup().plugin.polish(legacy, scope)).toBeUndefined();
    expect(generateText).not.toHaveBeenCalled();
  });
  it("unavailable dedicated model fails closed, not through auxiliary or main", async () => {
    const f = setup(null);
    expect(await f.plugin.replyLayout.compose(request, scope)).toBeUndefined();
    expect(generateText).not.toHaveBeenCalled();
    expect(f.resolveAuxiliaryModel).not.toHaveBeenCalled();
  });
  it.each([
    "",
    "garbage",
    '{"messages":["old shape"]}',
    '{"kind":"layout","parts":[]}',
    '```json\n{"kind":"layout","parts":[{"kind":"text","text":"a"}]}\n```',
    '{"kind":"layout","parts":[{"kind":"text","text":"a"}],"channel":"other"}',
    '{"kind":"layout","parts":[{"kind":"sticker","sticker_id":"unviewed"}]}',
  ])("malformed expression %j returns no layout or fallback", async (text) => {
    generateText.mockResolvedValue({ text, finishReason: "stop" });
    expect(await setup().plugin.replyLayout.compose(request, scope)).toBeUndefined();
    expect(generateText).toHaveBeenCalledOnce();
  });
  it("provider exception produces no layout", async () => {
    generateText.mockRejectedValue(new Error("offline"));
    expect(await setup().plugin.replyLayout.compose(request, scope)).toBeUndefined();
  });
});

describe("pure legacy utilities remain available without selecting a runtime lane", () => {
  it("keeps legacy prompt helpers and exact-length parser callable", () => {
    expect(buildSystemPrompt(legacy.profile)).toContain("角色卡定义");
    expect(buildUserPrompt(legacy)).toContain("原稿 @bob");
    expect(parsePolishedMessages('{"messages":["a","b"]}', 2)).toEqual(["a", "b"]);
    expect(parsePolishedMessages('{"messages":["a"]}', 2)).toBeUndefined();
    expect(parsePolishedMessages('{"messages":["a","b"],"continue":true}', 2)).toBeUndefined();
  });
});
