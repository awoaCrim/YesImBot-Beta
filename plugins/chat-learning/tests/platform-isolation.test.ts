import { expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import ChatLearningPlugin from "../src/index.js";

it("does not inject cross-chat examples or style banks into a public Xiaoheihe account", async () => {
  const command = { option: vi.fn().mockReturnThis(), action: vi.fn().mockReturnThis(), dispose: vi.fn() };
  const ctx = {
    on: vi.fn(),
    command: vi.fn(() => command),
    logger: () => ({ debug: vi.fn(), warn: vi.fn() }),
    yesimbot: {
      config: {},
      agent: { use: vi.fn(() => vi.fn()) },
      resource: {
        get: vi.fn(async () => {
          throw new Error("private_storage_accessed");
        }),
      },
    },
  };
  const plugin = new ChatLearningPlugin(ctx as never, { observeAllChannels: false } as never);
  await plugin.start();
  try {
    const factory = ctx.yesimbot.agent.use.mock.calls[0][0];
    const result = await factory.setup({ type: "guild", platform: "xiaoheihe", channelId: "account:bot", guildId: "account:bot" }, { selfId: "bot" });
    expect(result).toBeNull();
    expect(ctx.yesimbot.resource.get).not.toHaveBeenCalled();
  } finally {
    await plugin.stop();
  }
});
