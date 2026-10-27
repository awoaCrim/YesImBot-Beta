import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AccountStore, dayKey } from "../src/store.js";
const directories: string[] = [];
const stores: AccountStore[] = [];
async function open() {
  const dir = await mkdtemp(join(tmpdir(), "xhh-state-"));
  directories.push(dir);
  const store = await AccountStore.open(dir, "account");
  stores.push(store);
  return { store, dir };
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe("account state", () => {
  it("reads legacy state and persists only the latest 300 bounded activity records", async () => {
    const { store, dir } = await open();
    const legacy = store.snapshot();
    await store.close();
    delete (legacy as Partial<typeof legacy>).activities;
    await writeFile(join(dir, "state.json"), JSON.stringify(legacy));
    const reopened = await AccountStore.open(dir, "account");
    stores.push(reopened);
    expect(reopened.snapshot().activities).toEqual([]);
    await reopened.update((state) => {
      state.activities = Array.from({ length: 305 }, (_, index) => ({
        id: String(index),
        at: index,
        kind: "browse",
        outcome: "ok",
        source: "community:AI",
        count: 5,
      }));
    });
    await reopened.recordActivity({ kind: "read_post", outcome: "ok", title: "x".repeat(500), body: "do-not-store" } as never, 400);
    const data = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    expect(data.activities).toHaveLength(300);
    expect(data.activities[0].id).toBe("6");
    expect(data.activities.at(-1).title).toHaveLength(200);
    expect(data.activities.at(-1)).not.toHaveProperty("body");
    expect(data.actions).toEqual([]);
  });
  it("uses a Shanghai calendar day", () => {
    expect(dayKey(Date.parse("2026-10-26T15:59:59Z"))).toBe("2026-10-26");
    expect(dayKey(Date.parse("2026-10-26T16:00:00Z"))).toBe("2026-10-27");
  });
  it("persists owner-only state and refuses a second owner", async () => {
    const { store, dir } = await open();
    await store.update((s) => {
      s.paused = "operator";
    });
    expect((await stat(join(dir, "state.json"))).mode & 0o777).toBe(0o600);
    await expect(AccountStore.open(dir, "account")).rejects.toThrow();
    await store.close();
    const other = await AccountStore.open(dir, "account");
    stores.push(other);
    expect(other.snapshot().paused).toBe("operator");
  });
  it("serializes concurrent quota reservations and does not refund uncertain sends", async () => {
    const { store } = await open();
    const now = Date.parse("2026-10-26T10:00:00Z");
    const results = await Promise.allSettled([store.reserve("a", "post", 1, now), store.reserve("b", "post", 1, now)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(store.reserve("c", "post", 1, now)).rejects.toThrow("daily_limit");
    await expect(store.reserve("a", "post", 1, now + 86400000)).rejects.toThrow("duplicate_action");
    await store.reserve("d", "post", 1, now + 86400000);
  });
  it("zero disables writes; interrupted sends pause on restart", async () => {
    const { store, dir } = await open();
    await expect(store.reserve("no", "interaction", 0, Date.now())).rejects.toThrow("daily_limit");
    await store.reserve("maybe", "interaction", 10, Date.now());
    await store.close();
    const other = await AccountStore.open(dir, "account");
    stores.push(other);
    expect(other.snapshot().paused).toBe("uncertain_delivery");
    expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8")).actions[0].status).toBe("uncertain");
  });
});
