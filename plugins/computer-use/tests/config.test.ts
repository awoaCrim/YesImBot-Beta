import { EphemeralImageProjectionStore, type AgentPlugin } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { Config, apply } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

describe("computer-use configuration", () => {
  it("keeps the fixed guest MCP endpoint and timeout without a step budget", () => {
    const configured = Config({ apiKey: "secret", model: "vision-model" } as never);
    expect(configured).toMatchObject({
      enabled: true,
      mcpEndpoint: "http://172.20.0.1:18200/sse",
      timeout: 180,
      displayWidth: 1280,
      displayHeight: 800,
    });
    expect(configured).not.toHaveProperty("maxSteps");
  });

  it("registers one delegated tool only for an allowed scope", async () => {
    const use = vi.fn(() => vi.fn());
    const ctx = { yesimbot: { agent: { use } }, on: vi.fn(), logger: () => ({ info: vi.fn() }) };
    const config = Config({ apiKey: "secret", model: "computer-model" } as never);
    apply(ctx as never, config as never);
    const plugin = use.mock.calls[0]?.[0] as {
      setup: (scope: unknown, bot: unknown, runtime: unknown) => Promise<AgentPlugin>;
    };

    const allowed = await plugin.setup(
      { type: "direct", platform: "onebot", channelId: "1049700117", userId: "1049700117", selfId: "bot" },
      {},
      { imageProjection: new EphemeralImageProjectionStore() },
    );
    const denied = await plugin.setup({ type: "guild", platform: "discord", channelId: "room", guildId: "room" }, {}, {});

    const allowedTools = Array.isArray(allowed.tools) ? allowed.tools : [];
    const deniedTools = Array.isArray(denied.tools) ? denied.tools : [];
    expect(allowedTools).toHaveLength(1);
    expect(allowedTools[0]?.name).toBe("computer_use");
    expect(deniedTools).toEqual([]);
    expect(ctx.on).toHaveBeenCalledWith("dispose", expect.any(Function));
  });

  it("admits a user rule in any group but filters the delegated tool by current sender", async () => {
    const use = vi.fn(() => vi.fn());
    const info = vi.fn();
    const ctx = { yesimbot: { agent: { use } }, on: vi.fn(), logger: () => ({ info }) };
    const config = Config({ apiKey: "secret", model: "computer-model", allowedScopes: [{ platform: "onebot", channelId: "*", userId: "100" }] } as never);
    apply(ctx as never, config as never);
    const plugin = use.mock.calls[0]?.[0] as {
      setup: (scope: unknown, bot: unknown, runtime: unknown) => Promise<AgentPlugin>;
    };
    const runtimePlugin = await plugin.setup(
      { type: "guild", platform: "onebot", channelId: "group", guildId: "group" },
      { selfId: "bot" },
      { imageProjection: new EphemeralImageProjectionStore() },
    );
    const tools = runtimePlugin && Array.isArray(runtimePlugin.tools) ? runtimePlugin.tools : [];
    const message = (userId: string) => ({ id: "input-id", role: "custom", type: "yesimbot.message", data: { user: { id: userId } } });

    expect((await runtimePlugin?.filterTools?.(tools, { messages: [message("100")] } as never))?.map((tool) => tool.name)).toEqual(["computer_use"]);
    expect(await runtimePlugin?.filterTools?.(tools, { messages: [message("101")] } as never)).toEqual([]);
    expect(await runtimePlugin?.beforeToolCall?.({ toolCallId: "call", toolName: "computer_use", args: {} }, { messages: [message("101")] } as never)).toEqual({
      type: "block",
      reason: "当前消息发送者不在原生桌面工具白名单中",
    });
    expect(info).toHaveBeenCalledWith(
      "tool.access",
      expect.objectContaining({ phase: "execute", actorIds: ["101"], inputIds: ["input-id"], reason: "actor-denied" }),
    );
  });
});
