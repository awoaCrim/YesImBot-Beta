import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@koishijs/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../src/client.js", () => ({ connectXiaoheihe: mocks.connect }));
vi.mock("koishi", async () => import("@koishijs/core"));

import { Config, XiaoheiheAdapter, XiaoheiheBot } from "../src/index.js";
import { AccountStore } from "../src/store.js";
import type { XiaoheiheApi } from "../src/types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xhh-lifecycle-"));
  const api: XiaoheiheApi = {
    login: vi.fn(async () => ({ userId: "bot" })),
    profile: async () => ({ userId: "bot", posts: [] }),
    feed: async () => [],
    search: async () => [],
    post: vi.fn(),
    publish: vi.fn(),
    comment: vi.fn(),
    close: vi.fn(async () => {}),
  };
  mocks.connect.mockResolvedValue(api);
  const dispose = vi.fn();
  const logger = { info: vi.fn() };
  const app = { baseDir: root, logger: () => logger, yesimbot: { agent: { use: vi.fn(() => dispose) }, messenger: { post: vi.fn(async () => {}) } } };
  const adapter = Object.create(XiaoheiheAdapter.prototype) as XiaoheiheAdapter;
  Object.defineProperty(adapter, "ctx", { value: app });
  const bot = {
    selfId: "bot",
    platform: "xiaoheihe",
    config: Config({ selfId: "bot", mcp: { type: "stdio", command: "stub" } }),
    online: vi.fn(),
    offline: vi.fn(),
  } as unknown as XiaoheiheBot;
  cleanup.push(async () => {
    await adapter.disconnect(bot);
    await rm(root, { recursive: true, force: true });
  });
  return { root, app, adapter, bot, api, dispose, logger };
}

describe("adapter lifecycle", () => {
  it("registers an actual Satori Bot under its own platform and account", async () => {
    const ctx = new Context();
    const bot = new XiaoheiheBot(ctx as never, Config({ selfId: "bot", mcp: { type: "stdio", command: "stub" } }));
    try {
      expect(bot.platform).toBe("xiaoheihe");
      expect(bot.selfId).toBe("bot");
      expect(ctx.bots.find((candidate) => candidate.platform === "xiaoheihe" && candidate.selfId === "bot")).toBeDefined();
      await expect(bot.sendPrivateMessage()).rejects.toThrow("xiaoheihe_private_messages_unsupported");
    } finally {
      await ctx.stop();
    }
  });

  it("registers scoped tools before starting activity and releases the connection and state lock", async () => {
    const { root, app, adapter, bot, api, dispose } = await fixture();
    await adapter.connect(bot);
    await bot.account!.tick();
    expect(bot.online).toHaveBeenCalledOnce();
    expect(app.yesimbot.agent.use).toHaveBeenCalledOnce();
    expect(app.yesimbot.messenger.post).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "xiaoheihe", selfId: "bot", eventType: "xiaoheihe.browse" }),
      expect.objectContaining({ historyMode: "conversation", delivery: "channel" }),
    );
    const factory = app.yesimbot.agent.use.mock.calls[0][0];
    const scope = { type: "guild", platform: "xiaoheihe", channelId: "account:bot", guildId: "account:bot" };
    expect(factory.setup(scope, { selfId: "bot", platform: "xiaoheihe" })).not.toBeNull();
    expect(factory.setup(scope, { selfId: "other", platform: "xiaoheihe" })).toBeNull();
    await adapter.disconnect(bot);
    expect(dispose).toHaveBeenCalledOnce();
    expect(api.close).toHaveBeenCalledOnce();
    const reopened = await AccountStore.open(join(root, "data", "yesimbot", "xiaoheihe", "bot"), "bot");
    await reopened.close();
  });

  it("connects a deployment-paused account without autonomous events or publications", async () => {
    const { root, app, adapter, bot, api, logger } = await fixture();
    const store = await AccountStore.open(join(root, "data", "yesimbot", "xiaoheihe", "bot"), "bot");
    await store.update((state) => {
      state.paused = "deployment_pending_activation";
    });
    await store.close();
    await adapter.connect(bot);
    await bot.account!.tick();
    expect(bot.online).toHaveBeenCalledOnce();
    expect(app.yesimbot.messenger.post).not.toHaveBeenCalled();
    expect(api.publish).not.toHaveBeenCalled();
    expect(api.comment).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("xiaoheihe.connected paused=%s", true);
    expect(bot.account!.store.snapshot()).toMatchObject({ paused: "deployment_pending_activation", actions: [], lastBrowseAt: 0 });
  });

  it("rejects an unexpected logged-in account without registering tools or publishing", async () => {
    const { app, adapter, bot, api } = await fixture();
    vi.mocked(api.login).mockResolvedValue({ userId: "different" });
    await expect(adapter.connect(bot)).rejects.toThrow("xiaoheihe_connection_failed");
    expect(app.yesimbot.agent.use).not.toHaveBeenCalled();
    expect(app.yesimbot.messenger.post).not.toHaveBeenCalled();
    expect(bot.online).not.toHaveBeenCalled();
    expect(api.publish).not.toHaveBeenCalled();
    expect(api.close).toHaveBeenCalledOnce();
  });
});
