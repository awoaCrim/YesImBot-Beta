import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const registrations = vi.hoisted(() => [] as { key: string; options: unknown }[]);
vi.mock("@koishijs/console", () => ({
  DataService: class {
    constructor(_ctx: unknown, key: string, options: unknown) {
      registrations.push({ key, options });
    }
  },
}));
vi.mock("@koishijs/loader", () => ({}));
vi.mock("koishi", async () => import("@koishijs/core"));

import { ConversationsProvider } from "../src/conversations.js";
import { buildXiaoheihePayload, XiaoheiheProvider } from "../src/xiaoheihe.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  registrations.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xhh-panel-"));
  roots.push(root);
  const dir = join(root, "data/yesimbot/xiaoheihe/account");
  await mkdir(dir, { recursive: true });
  const state = {
    version: 1,
    accountId: "account",
    paused: null,
    actions: [],
    watched: {},
    pendingVisits: [],
    lastBrowseAt: 100,
    activities: [{ id: "browse-1", at: 100, kind: "browse", outcome: "ok", source: "community:AI", count: 5, token: "must-not-leak" }],
  };
  await writeFile(join(dir, "state.json"), JSON.stringify(state));
  const ctx = {
    baseDir: root,
    bots: [],
    loader: {
      config: {
        plugins: {
          "group:yesimbot": {
            yesimbot: { basePath: "data/yesimbot" },
            "yesimbot-xiaoheihe:test": {
              selfId: "account",
              dailyPostLimit: 0,
              dailyInteractionLimit: 0,
              browseCommunities: ["AI", "盒友杂谈"],
              browseTopics: ["mygo!!!"],
              mcp: { token: "must-not-leak" },
            },
          },
        },
      },
    },
  };
  return { root, dir, state, ctx };
}

describe("Xiaoheihe activity console", () => {
  it("protects activity, conversation index, and detail with administrator authority", () => {
    const listener = vi.fn();
    const ctx = { on: vi.fn(), console: { addListener: listener } } as never;
    new XiaoheiheProvider(ctx);
    new ConversationsProvider(ctx);
    expect(registrations).toEqual([
      { key: "yesimbotXiaoheihe", options: { authority: 4 } },
      { key: "yesimbotConversations", options: { authority: 4 } },
    ]);
    expect(listener).toHaveBeenCalledWith("yesimbot/conversation", expect.any(Function), { authority: 4 });
  });

  it("returns safe activity/configuration and only this account's Xiaoheihe conversations", async () => {
    const { root, ctx } = await fixture();
    for (const [key, platform, selfId, channelId] of [
      ["own", "xiaoheihe", "account", "account:account"],
      ["other", "xiaoheihe", "other", "account:other"],
      ["qq", "onebot", "account", "private"],
    ]) {
      const dir = join(root, "data/yesimbot/channels", key);
      await mkdir(join(dir, "sessions"), { recursive: true });
      await writeFile(join(dir, "channel.json"), JSON.stringify({ type: "guild", platform, selfId, channelId, createdAt: "2026-10-27T00:00:00Z" }));
    }
    const result = await buildXiaoheihePayload(ctx as never);
    expect(result.status).toBe("ready");
    expect(result.accounts[0]).toMatchObject({
      stateStatus: "ready",
      activityStatus: "ready",
      lastBrowseAt: 100,
      config: { readOnly: true, browseCommunities: ["AI", "盒友杂谈"], candidateTopics: ["mygo!!!"] },
    });
    expect(result.activities[0]).toMatchObject({ accountId: "account", source: "community:AI", count: 5 });
    expect(result.conversations?.channels.map((channel) => channel.key)).toEqual(["own"]);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).not.toContain("mcp");
  });

  it("marks legacy and damaged activity states instead of inventing browse history", async () => {
    const { dir, state, ctx } = await fixture();
    const legacy = { ...state };
    delete (legacy as Partial<typeof state>).activities;
    await writeFile(join(dir, "state.json"), JSON.stringify(legacy));
    expect((await buildXiaoheihePayload(ctx as never)).accounts[0]?.activityStatus).toBe("legacy");
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({ ...state, activities: [{ id: "bad" }, { ...state.activities[0], errorCode: "SECRET_RAW_ERROR" }] }),
    );
    const result = await buildXiaoheihePayload(ctx as never);
    expect(result.status).toBe("partial");
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]?.errorCode).toBe("unknown_error");
    expect(JSON.stringify(result)).not.toContain("SECRET_RAW_ERROR");
  });

  it("refuses symlink files, oversized files, malformed JSON, and mismatched accounts", async () => {
    const { root, dir, state, ctx } = await fixture();
    const external = join(root, "external-state.json");
    await writeFile(external, JSON.stringify(state));
    await rm(join(dir, "state.json"));
    await symlink(external, join(dir, "state.json"));
    expect((await buildXiaoheihePayload(ctx as never)).accounts[0]?.stateStatus).toBe("unsafe");
    await rm(join(dir, "state.json"));
    for (const [content, expected] of [
      ["x".repeat(2 * 1024 * 1024 + 1), "too_large"],
      ["{invalid", "invalid"],
      [JSON.stringify({ ...state, accountId: "other" }), "invalid"],
    ]) {
      await writeFile(join(dir, "state.json"), content);
      expect((await buildXiaoheihePayload(ctx as never)).accounts[0]?.stateStatus).toBe(expected);
    }
    expect(await readFile(external, "utf8")).toBe(JSON.stringify(state));
  });

  it("counts pending and uncertain attempts on the Shanghai calendar day", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-27T16:01:00Z"));
    const { dir, state, ctx } = await fixture();
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({
        ...state,
        actions: [
          { key: "p", kind: "post", day: "2026-10-28", at: 100, target: "account:account", status: "pending" },
          { key: "i", kind: "interaction", day: "2026-10-28", at: 100, target: "post:account:p", status: "uncertain" },
          { key: "old", kind: "post", day: "2026-10-27", at: 100, target: "account:account", status: "sent" },
        ],
      }),
    );
    expect((await buildXiaoheihePayload(ctx as never)).accounts[0]?.quota).toMatchObject({
      day: "2026-10-28",
      postsUsed: 1,
      interactionsUsed: 1,
      pending: 1,
      uncertain: 1,
    });
  });
});
