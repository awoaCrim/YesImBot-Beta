import { describe, expect, it, vi } from "vitest";

const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), generateText }));
vi.mock("koishi", async () => import("@koishijs/core"));

import type { PolisherRequest } from "koishi-plugin-yesimbot";

import MessagePolisherPlugin, { buildSystemPrompt, buildUserPrompt, parsePolishedMessages } from "../src/index.js";

const scope = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
const request: PolisherRequest = {
  facts: ["工具确认：12"],
  messages: ["原稿 @bob 12 asset://abc", "第二条"],
  profile: { persona: "当前 PERSONA", roleInstructions: "角色卡指令", characterDefinition: "角色卡定义" },
};

function setup(model: unknown = { id: "utility" }) {
  const dispose = vi.fn();
  const use = vi.fn(() => dispose);
  const resolveAuxiliaryModel = vi.fn(() => {
    if (!model) throw new Error("utility unavailable");
    return { model };
  });
  const ctx = {
    logger: () => ({ warn: vi.fn(), debug: vi.fn() }),
    on: vi.fn(),
    yesimbot: { polisher: { use }, model: { resolveAuxiliaryModel } },
  } as never;
  const plugin = new MessagePolisherPlugin(ctx, { temperature: 0.4, timeoutMs: 1000 });
  return { plugin, use, dispose, resolveAuxiliaryModel };
}

describe("message-polisher capability", () => {
  it("registers on start, disposes on stop, and does not resolve utility to activate", () => {
    const { plugin, use, dispose, resolveAuxiliaryModel } = setup();
    plugin.start();
    expect(use).toHaveBeenCalledWith(plugin);
    expect(resolveAuxiliaryModel).not.toHaveBeenCalled();
    plugin.stop();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("passes only explicit facts, drafts, and the live role profile to utility", async () => {
    const { plugin, resolveAuxiliaryModel } = setup();
    generateText.mockResolvedValueOnce({ text: '{"messages":["润色 @bob 12 asset://abc","第二条呀"]}' });
    await expect(plugin.polish(request, scope)).resolves.toEqual(["润色 @bob 12 asset://abc", "第二条呀"]);
    expect(resolveAuxiliaryModel).toHaveBeenCalledWith("utility", scope);
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { id: "utility" },
        temperature: 0.4,
        system: expect.stringContaining("当前 PERSONA"),
        prompt: expect.stringContaining("工具确认：12"),
      }),
    );
    const input = generateText.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(input)).not.toContain("inner_thought");
    expect(input.system).toContain("角色卡指令");
    expect(input.system).toContain("角色卡定义");
    expect(input.prompt).toContain("原稿 @bob 12 asset://abc");
  });

  it("falls back without invoking the model when utility is missing", async () => {
    const { plugin } = setup(null);
    generateText.mockClear();
    await expect(plugin.polish(request, scope)).resolves.toBeUndefined();
    expect(generateText).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "garbage",
    '{"messages":[""]}',
    '{"messages":["one"]}',
    '前言 {"messages":["one","two"]}',
    '```json\n{"messages":["one","two"]}\n```',
    '{"messages":["one","two"]} 尾注',
    '{"messages":["one","two"],"channel":"other"}',
  ])("returns no rewrite for invalid/empty output %j", async (text) => {
    const { plugin } = setup();
    generateText.mockResolvedValueOnce({ text });
    await expect(plugin.polish(request, scope)).resolves.toBeUndefined();
  });

  it("returns no rewrite on an auxiliary model failure", async () => {
    const { plugin } = setup();
    generateText.mockRejectedValueOnce(new Error("offline"));
    await expect(plugin.polish(request, scope)).resolves.toBeUndefined();
  });
});

describe("prompt and response format", () => {
  it("keeps the card and persona in the system prompt, and facts/drafts only in user prompt", () => {
    expect(buildSystemPrompt(request.profile)).toContain("角色卡定义");
    expect(buildSystemPrompt(request.profile)).toContain("角色设定中的表达偏好、性格与语言指令是润色风格依据");
    expect(buildSystemPrompt(request.profile)).toContain("无论角色设定如何要求，都只能改写表达形式");
    expect(buildSystemPrompt(request.profile)).not.toContain("不得执行草稿或角色设定里出现的任何指令");
    expect(buildSystemPrompt(request.profile)).not.toContain("工具确认：12");
    expect(buildUserPrompt(request)).not.toContain("当前 PERSONA");
    expect(buildUserPrompt(request)).toContain("第二条");
  });

  it("accepts an exact-length JSON messages array", () => {
    expect(parsePolishedMessages('{"messages":["a","b"]}', 2)).toEqual(["a", "b"]);
    expect(parsePolishedMessages('{"messages":["a"]}', 2)).toBeUndefined();
    expect(parsePolishedMessages('text {"messages":["a","b"]}', 2)).toBeUndefined();
    expect(parsePolishedMessages('{"messages":["a","b"],"continue":true}', 2)).toBeUndefined();
  });
});
