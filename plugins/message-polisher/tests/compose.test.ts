import type { PolisherRequest } from "koishi-plugin-yesimbot";
import { afterEach, describe, expect, it, vi } from "vitest";
const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), generateText }));
vi.mock("koishi", async () => import("@koishijs/core"));
import MessagePolisherPlugin, { buildSystemPrompt, buildUserPrompt, Config, parsePolishedMessages } from "../src/index.js";
const channel = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
const request: PolisherRequest = {
  mode: "compose",
  messages: [],
  facts: ["已确认订单 12 件"],
  intent: "告知订单完成",
  verbatim: ["npm run build"],
  turnContext: [{ kind: "user", content: "当前问题" }],
  profile: { persona: "完整主身份", characterDefinition: "完整角色卡", roleInstructions: "完整交流示例" },
};
function plugin(mode: "compose" | "rewrite" = "compose") {
  return new MessagePolisherPlugin(
    { on: vi.fn(), logger: () => ({ warn: vi.fn() }), yesimbot: { model: { resolveChatModel: () => ({ model: {} }) } } } as never,
    { model: "mock:compose", mode, temperature: 0.5, timeoutMs: 1000 },
  );
}
afterEach(() => {
  generateText.mockReset();
  vi.restoreAllMocks();
});
describe("official composer", () => {
  it("keeps rewrite as the existing default", () => {
    expect(Config({} as never)).toMatchObject({ mode: "rewrite" });
  });
  it("receives complete role materials and facts/intent without any draft", async () => {
    generateText.mockResolvedValue({ text: '{"messages":["确认啦。","订单 12 件已经完成。","npm run build"]}', finishReason: "stop" });
    expect(await plugin().polish(request, channel)).toHaveLength(3);
    const input = generateText.mock.calls[0]![0];
    expect(input).toMatchObject({ maxRetries: 0, maxOutputTokens: 4096 });
    expect(input.system).toContain("完整主身份");
    expect(input.system).toContain("完整角色卡");
    expect(input.system).toContain("完整交流示例");
    expect(input.system).toContain("自主构思");
    expect(input.system).not.toContain("保持消息条数不变");
    expect(input.prompt).toContain("告知订单完成");
    expect(input.prompt).toContain("npm run build");
    expect(input.prompt).not.toContain("待改写草稿");
    expect(buildUserPrompt({ ...request, facts: [] })).toContain("无事实信息");
    expect(buildSystemPrompt({ ...request.profile, persona: "" }, "compose")).toContain("角色卡单独定义当前身份");
  });
  it.each([
    { ...request, intent: "" },
    { ...request, messages: ["草稿"] },
    { ...request, mode: "rewrite" as const },
  ])("rejects invalid input/mode without generation", async (data) => {
    expect(await plugin().polish(data, channel)).toBeUndefined();
    expect(generateText).not.toHaveBeenCalled();
  });
  it("does not route compose through a rewrite capability", async () => {
    expect(await plugin("rewrite").polish(request, channel)).toBeUndefined();
    expect(generateText).not.toHaveBeenCalled();
  });
  it.each(["length", "content-filter", "error"])("rejects incomplete finish %s with no retries", async (finishReason) => {
    generateText.mockResolvedValue({ text: '{"messages":["不完整"]}', finishReason });
    expect(await plugin().polish(request, channel)).toBeUndefined();
    expect(generateText).toHaveBeenCalledOnce();
  });
  it("enforces timeout even if generation ignores cancellation", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    generateText.mockImplementation(() => new Promise(() => {}));
    const pending = plugin().polish(request, channel);
    deadline.abort();
    expect(await pending).toBeUndefined();
    expect(generateText).toHaveBeenCalledOnce();
  });
  it("bounds variable messages while retaining strict JSON", () => {
    expect(parsePolishedMessages('{"messages":["一","二","三"]}')).toEqual(["一", "二", "三"]);
    for (const candidate of [[], Array(13).fill("内容"), [""], [42], ["x".repeat(32768)]])
      expect(parsePolishedMessages(JSON.stringify({ messages: candidate }))).toBeUndefined();
    expect(parsePolishedMessages('{"messages":["一"],"channel":"else"}')).toBeUndefined();
  });
});
