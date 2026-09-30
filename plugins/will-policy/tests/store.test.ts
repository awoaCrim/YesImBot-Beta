import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDurableWillingnessStore, type WillingnessStoreFileOps } from "../src/store.js";

const roots: string[] = [];
const logger = { warn: vi.fn() };

async function fixture(name = "state") {
  const root = await mkdtemp(join(tmpdir(), `yesimbot-willingness-${name}-`));
  roots.push(root);
  return { root, path: join(root, "willingness.json") };
}

afterEach(async () => {
  logger.warn.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable willingness store", () => {
  it("creates a versioned selfId-namespaced file and reloads isolated authors", async () => {
    const { path } = await fixture();
    const store = createDurableWillingnessStore(path, logger);
    await store.init();
    await store.mutateBot("bot-a", (bot) => {
      bot.authors.alice = { confirmedScore: 42, lastMessageAt: 100, lastDecayAt: 100 };
    });
    await store.mutateBot("bot-b", (bot) => {
      bot.authors.alice = { confirmedScore: 7, lastMessageAt: 200, lastDecayAt: 200 };
    });

    const file = JSON.parse(await readFile(path, "utf8")) as { version: number; bots: Record<string, unknown> };
    expect(file.version).toBe(1);
    expect(Object.keys(file.bots).sort()).toEqual(["bot-a", "bot-b"]);

    const reloaded = createDurableWillingnessStore(path, logger);
    await reloaded.init();
    expect(reloaded.readBot("bot-a").authors.alice?.confirmedScore).toBe(42);
    expect(reloaded.readBot("bot-b").authors.alice?.confirmedScore).toBe(7);
  });

  it("publishes through an exclusive temp file and leaves the previous snapshot intact when rename fails", async () => {
    const { path } = await fixture("atomic");
    const initial = createDurableWillingnessStore(path, logger);
    await initial.mutateBot("bot", (bot) => {
      bot.authors.alice = { confirmedScore: 10, lastMessageAt: 1, lastDecayAt: 1 };
    });
    const previous = await readFile(path, "utf8");
    const writePaths: string[] = [];
    const ops: WillingnessStoreFileOps = {
      mkdir: (target) => mkdir(target, { recursive: true }),
      readFile: (target) => readFile(target, "utf8"),
      rename: async () => {
        throw new Error("rename failed");
      },
      rm: (target) => rm(target, { force: true }),
      writeFile: async (target, content) => {
        writePaths.push(target);
        await writeFile(target, content, { encoding: "utf8", flag: "wx" });
      },
    };
    const failing = createDurableWillingnessStore(path, logger, ops);
    await failing.init();

    await expect(
      failing.mutateBot("bot", (bot) => {
        bot.authors.alice!.confirmedScore = 99;
      }),
    ).rejects.toThrow("rename failed");

    expect(failing.readBot("bot").authors.alice?.confirmedScore).toBe(10);
    expect(await readFile(path, "utf8")).toBe(previous);
    expect(writePaths).toHaveLength(1);
    await expect(readFile(writePaths[0]!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["truncated JSON", '{"version":'],
    ["unknown version", JSON.stringify({ version: 2, updatedAt: 0, bots: {} })],
    [
      "inconsistent author timestamps",
      JSON.stringify({
        version: 1,
        updatedAt: 0,
        bots: { bot: { authors: { alice: { confirmedScore: 100, lastMessageAt: 1, lastDecayAt: null } }, reservations: {} } },
      }),
    ],
    [
      "prototype-chain reservation ownership",
      JSON.stringify({
        version: 1,
        updatedAt: 0,
        bots: {
          bot: {
            authors: {},
            reservations: { reservation: { id: "reservation", authorId: "toString", amount: 1, createdAt: 1, sourceEventIds: ["m"] } },
          },
        },
      }),
    ],
    [
      "invalid reservation ownership",
      JSON.stringify({
        version: 1,
        updatedAt: 0,
        bots: {
          bot: { authors: {}, reservations: { reservation: { id: "reservation", authorId: "missing", amount: 1, createdAt: 0, sourceEventIds: ["e"] } } },
        },
      }),
    ],
  ])("fails closed for %s and replaces it with controlled state on the next mutation", async (_label, content) => {
    const { root, path } = await fixture("corrupt");
    await mkdir(root, { recursive: true });
    await writeFile(path, content);
    const store = createDurableWillingnessStore(path, logger);

    await expect(store.init()).resolves.toBeUndefined();
    expect(store.readBot("bot").authors).toEqual({});
    expect(logger.warn).toHaveBeenCalledOnce();

    await store.mutateBot("bot", (bot) => {
      bot.authors.alice = { confirmedScore: 1, lastMessageAt: 1, lastDecayAt: 1 };
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1, bots: { bot: { authors: { alice: { confirmedScore: 1 } } } } });
  });
});
