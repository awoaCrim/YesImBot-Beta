import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Account } from "../src/account.js";
import { AccountStore } from "../src/store.js";
import type { Config, PostDetail, XiaoheiheApi } from "../src/types.js";

const config: Config = {
  selfId: "bot",
  mcp: { type: "stdio", command: "unused" },
  dailyPostLimit: 1,
  dailyInteractionLimit: 10,
  pollIntervalMinutes: 30,
  feedLimit: 10,
  maxWatchedPosts: 50,
  communities: [],
  browseCommunities: [],
  browseTopics: [],
};
const resources: { account: Account; dir: string }[] = [];
const detail: PostDetail = {
  id: "p",
  authorId: "other",
  title: "A post",
  text: "body",
  comments: [{ id: "c", authorId: "other", text: "question", rootId: "c" }],
};
async function fixture(patch: Partial<Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "xhh-account-"));
  const store = await AccountStore.open(dir, "bot");
  const api = {
    login: vi.fn(async () => ({ userId: "bot" })),
    profile: vi.fn(async () => ({ userId: "bot", posts: [] })),
    feed: vi.fn(async () => [detail]),
    search: vi.fn(async () => [detail]),
    post: vi.fn(async () => structuredClone(detail)),
    publish: vi.fn(async () => ({ accepted: true, verified: true, id: "new" })),
    comment: vi.fn(async () => ({ accepted: true, verified: true, id: "sent" })),
    close: vi.fn(async () => {}),
  } satisfies XiaoheiheApi;
  const post = vi.fn(async () => {});
  const account = new Account({ ...config, ...patch }, api, store, post, () => Date.parse("2026-10-26T10:00:00Z"));
  resources.push({ account, dir });
  return { account, store, api, post };
}
afterEach(async () => {
  for (const { account, dir } of resources.splice(0)) {
    await account.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
describe("autonomous account boundary", () => {
  it("rechecks pause after quota persistence and before calling the upstream writer", async () => {
    const { account, store, api } = await fixture();
    const reserve = store.reserve.bind(store);
    vi.spyOn(store, "reserve").mockImplementationOnce(async (...args) => {
      await reserve(...args);
      await account.pause();
    });
    await expect(account.send("account:bot", "Title\nBody")).rejects.toThrow("account_paused");
    expect(api.publish).not.toHaveBeenCalled();
  });

  it("preserves daily counters across pause and resume", async () => {
    const { account, api } = await fixture();
    await account.send("account:bot", "Title\nBody");
    await account.pause();
    await account.resume();
    await expect(account.send("account:bot", "Another\nBody")).rejects.toThrow("daily_limit");
    expect(api.publish).toHaveBeenCalledOnce();
  });
  it("sends only verified publications and enforces separate quotas", async () => {
    const { account, api } = await fixture({ dailyInteractionLimit: 1 });
    expect(await account.send("account:bot", "Title\nBody")).toEqual(["new"]);
    await expect(account.send("account:bot", "Other\nPost")).rejects.toThrow("daily_limit");
    await account.readPost("p");
    expect(await account.send("post:bot:p", "comment")).toEqual(["sent"]);
    await expect(account.send("post:bot:p", "second")).rejects.toThrow("daily_limit");
    expect(api.publish).toHaveBeenCalledTimes(1);
    expect(api.comment).toHaveBeenCalledTimes(1);
  });
  it("validates the exact observed reply target and prevents duplicate replies", async () => {
    const { account, api } = await fixture();
    await account.readPost("p");
    await expect(account.send("post:bot:p", "reply", "missing")).rejects.toThrow("unknown_reply_target");
    await account.send("post:bot:p", "answer", "c");
    expect(api.comment).toHaveBeenCalledWith("p", "answer", "question");
    await expect(account.send("post:bot:p", "different answer", "c")).rejects.toThrow("duplicate_action");
    expect(api.comment).toHaveBeenCalledTimes(1);
  });
  it("stops on uncertain delivery and does not retry or invent message IDs", async () => {
    const { account, store, api } = await fixture();
    api.publish.mockResolvedValue({ accepted: true, verified: false, id: "new" });
    await expect(account.send("account:bot", "Title\nBody")).rejects.toThrow("uncertain_delivery");
    expect(store.snapshot().paused).toBe("uncertain_delivery");
    expect(store.snapshot().actions[0].status).toBe("uncertain");
    await expect(account.send("account:bot", "Other\nText")).rejects.toThrow("account_paused");
    expect(api.publish).toHaveBeenCalledTimes(1);
  });
  it("rejects account changes, unread targets, and paused writes", async () => {
    const { account, api } = await fixture();
    await expect(account.send("post:other:p", "text")).rejects.toThrow();
    await expect(account.send("post:bot:p", "text")).rejects.toThrow("read_post_first");
    api.login.mockResolvedValue({ userId: "someone-else" });
    await expect(account.send("account:bot", "Title\nBody")).rejects.toThrow("account_identity_mismatch");
    expect(api.publish).not.toHaveBeenCalled();
  });
  it("runs a bounded browse event once, persists progress, and does not replay old comments", async () => {
    const { account, post, store, api } = await fixture();
    await account.readPost("p");
    await account.visitPost("p");
    await account.tick();
    expect(post.mock.calls.map(([e]) => e.eventType)).toEqual(["xiaoheihe.browse", "xiaoheihe.thread"]);
    expect(store.snapshot().pendingVisits).toEqual([]);
    await account.tick();
    expect(post).toHaveBeenCalledTimes(2);
    expect(api.comment).not.toHaveBeenCalled();
  });
  it("only dispatches new replies on watched own threads", async () => {
    const { account, post, api } = await fixture();
    api.post.mockResolvedValue({ ...detail, authorId: "bot" });
    await account.readPost("p");
    await account.visitPost("p");
    await account.tick();
    post.mockClear();
    api.post.mockResolvedValue({
      ...detail,
      authorId: "bot",
      comments: [...detail.comments, { id: "new-c", authorId: "person", text: "new question", rootId: "new-c" }],
    });
    await account.pollWatched();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toMatchObject({ eventType: "xiaoheihe.thread", channel: { id: "post:bot:p" } });
    await account.pollWatched();
    expect(post).toHaveBeenCalledTimes(1);
  });
  it("zero quotas still permit browsing but never publish", async () => {
    const { account, api, post } = await fixture({ dailyPostLimit: 0, dailyInteractionLimit: 0 });
    await account.tick();
    expect(post).toHaveBeenCalled();
    await expect(account.send("account:bot", "Title\nBody")).rejects.toThrow("read_only");
    expect(account.status().activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "browse", outcome: "ok", count: 1 }),
        expect.objectContaining({ kind: "send", outcome: "blocked" }),
      ]),
    );
    expect(account.store.snapshot().actions).toEqual([]);
    expect(api.publish).not.toHaveBeenCalled();
  });
});
