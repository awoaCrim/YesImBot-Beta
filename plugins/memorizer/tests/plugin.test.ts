import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", () => {
  const schema = new Proxy({}, { get: () => () => schema });
  return { Schema: schema };
});

import MemoryAgentPlugin from "../src/index.js";

const context = {
  baseDir: "/tmp",
  logger: () => ({ warn: vi.fn(), success: vi.fn(), info: vi.fn() }),
  yesimbot: {
    model: {
      resolveChatModel: vi.fn(() => ({ model: {} })),
      resolveAuxiliaryModel: vi.fn(() => ({ model: {} })),
    },
    agent: { use: vi.fn(() => vi.fn()) },
    conversation: { read: vi.fn() },
  },
  on: vi.fn(),
};

describe("MemoryAgentPlugin", () => {
  it("registers lifecycle handlers, memory table, and only public channel tools", async () => {
    const on = vi.fn();
    const agentUse = vi.fn(() => vi.fn());
    const ctx = {
      ...context,
      on,
      yesimbot: { ...context.yesimbot, agent: { use: agentUse } },
      model: { extend: vi.fn(), get: vi.fn(async () => []), set: vi.fn(), remove: vi.fn() },
    };
    const plugin = new MemoryAgentPlugin(ctx as never, { model: "test:model" });
    expect(on).toHaveBeenCalledWith("ready", expect.any(Function));
    expect(on).toHaveBeenCalledWith("dispose", expect.any(Function));
    await plugin.start();
    const factory = agentUse.mock.calls[0]![0];
    const channelPlugin = factory.setup({ type: "guild", platform: "test", channelId: "room", guildId: "room" }, { selfId: "bot" }) as {
      name: string;
      appendSystemPrompt: () => string;
      tools: () => Array<{ name: string; description?: string }>;
    };
    expect(channelPlugin).toMatchObject({ name: "memory-agent" });
    expect(channelPlugin.appendSystemPrompt()).toContain("recall、remember、search 三个记忆工具");
    expect(channelPlugin.appendSystemPrompt()).toContain("普通事实先用它，必要时再启用语义召回");
    expect(channelPlugin.appendSystemPrompt()).not.toContain("query 用关键名词");

    const tools = channelPlugin.tools();
    expect(tools.map((tool) => tool.name)).toEqual(["remember", "recall", "search"]);
    expect(tools.map((tool) => tool.description).join("\n")).toContain("query、tags、types、scope、limit");
    expect(tools.map((tool) => tool.description).join("\n")).toContain("sources 必须是相关 messageId");
    await plugin.stop();
  });
});
