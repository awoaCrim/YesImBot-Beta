import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@koishijs/core";
import { createEntry } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { Channels } from "../src/channels/index.js";
import { COMPACT_FRAGMENT_TABLE } from "../src/conversations/fragment-store.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Channels", () => {
  it("keeps one stable resources owner for each canonical scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channels-"));
    roots.push(root);
    const channels = new Channels(new Context(), { basePath: root });
    const shared = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
    const direct = { type: "direct", platform: "test", selfId: "bot", channelId: "room" } as const;

    const [first, second] = await Promise.all([channels.get(shared), channels.get(shared)]);

    expect(first).toBe(second);
    expect(await channels.get(direct)).not.toBe(first);
  });
  it("passes image input and read timeout to newly created resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channels-config-"));
    roots.push(root);
    const channels = new Channels(new Context(), { basePath: root, imageInput: true, readTimeoutMs: 5 });
    channels.use({
      scheme: "slow",
      prompt: "slow reader",
      setup: async (_resources, _uri, { signal }) =>
        new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    });
    const resources = await channels.get({ type: "guild", platform: "test", channelId: "room", guildId: "room" });

    expect(resources.imageInput).toBe(true);
    await expect(resources.open("slow:///file")).resolves.toBeUndefined();
  });
  it("migrates a legacy shared guild directory during startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channels-legacy-guild-"));
    roots.push(root);
    const legacyRoot = join(root, "channels", "shared-onebot-101");
    await mkdir(legacyRoot, { recursive: true });
    await Promise.all([
      writeFile(join(legacyRoot, "channel.json"), '{"type":"shared","platform":"onebot","channelId":"101","createdAt":"2026-08-01T00:00:00.000Z"}\n'),
      writeFile(join(legacyRoot, "legacy.txt"), "legacy guild data\n"),
    ]);

    const channels = new Channels(new Context(), { basePath: root });
    await channels.start();
    const channel = await channels.resolve({ type: "guild", platform: "onebot", channelId: "101", guildId: "101" });
    const canonicalRoot = join(root, "channels", "guild-onebot-101");

    expect(channel.root).toBe(canonicalRoot);
    await expect(readFile(join(canonicalRoot, "legacy.txt"), "utf8")).resolves.toBe("legacy guild data\n");
    await expect(readFile(join(legacyRoot, "legacy.txt"), "utf8")).rejects.toThrow();
    expect(JSON.parse(await readFile(join(canonicalRoot, "channel.json"), "utf8"))).toMatchObject({
      type: "guild",
      platform: "onebot",
      channelId: "101",
      guildId: "101",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("migrates a legacy shared channel directory during startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channels-legacy-channel-"));
    roots.push(root);
    const legacyRoot = join(root, "channels", "shared-onebot-101");
    await mkdir(legacyRoot, { recursive: true });
    await Promise.all([
      writeFile(
        join(legacyRoot, "channel.json"),
        '{"type":"shared","platform":"onebot","channelId":"101","guildId":"202","createdAt":"2026-08-01T00:00:00.000Z"}\n',
      ),
      writeFile(join(legacyRoot, "legacy.txt"), "legacy channel data\n"),
    ]);

    const channels = new Channels(new Context(), { basePath: root });
    await channels.start();
    const channel = await channels.resolve({ type: "channel", platform: "onebot", channelId: "101", guildId: "202" });
    const canonicalRoot = join(root, "channels", "channel-onebot-202-101");

    expect(channel.root).toBe(canonicalRoot);
    await expect(readFile(join(canonicalRoot, "legacy.txt"), "utf8")).resolves.toBe("legacy channel data\n");
    await expect(readFile(join(legacyRoot, "legacy.txt"), "utf8")).rejects.toThrow();
    expect(JSON.parse(await readFile(join(canonicalRoot, "channel.json"), "utf8"))).toMatchObject({
      type: "channel",
      platform: "onebot",
      channelId: "101",
      guildId: "202",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("quarantines an existing canonical directory before migrating legacy data", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channels-legacy-conflict-"));
    roots.push(root);
    const legacyRoot = join(root, "channels", "shared-onebot-101");
    const canonicalRoot = join(root, "channels", "guild-onebot-101");
    await Promise.all([mkdir(legacyRoot, { recursive: true }), mkdir(canonicalRoot, { recursive: true })]);
    await Promise.all([
      writeFile(join(legacyRoot, "channel.json"), '{"type":"shared","platform":"onebot","channelId":"101","createdAt":"2026-08-01T00:00:00.000Z"}\n'),
      writeFile(join(legacyRoot, "legacy.txt"), "legacy data\n"),
      writeFile(
        join(canonicalRoot, "channel.json"),
        '{"type":"guild","platform":"onebot","channelId":"101","guildId":"101","createdAt":"2026-08-02T00:00:00.000Z"}\n',
      ),
      writeFile(join(canonicalRoot, "current.txt"), "current data\n"),
    ]);

    const channels = new Channels(new Context(), { basePath: root });
    const channel = await channels.resolve({ type: "guild", platform: "onebot", channelId: "101", guildId: "101" });
    const entries = await readdir(join(root, "channels"));
    const quarantine = entries.find((name) => name.startsWith(".conflict-guild-onebot-101-"));

    expect(channel.root).toBe(canonicalRoot);
    expect(quarantine).toBeDefined();
    await expect(readFile(join(canonicalRoot, "legacy.txt"), "utf8")).resolves.toBe("legacy data\n");
    await expect(readFile(join(canonicalRoot, "current.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(legacyRoot, "legacy.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(root, "channels", quarantine!, "current.txt"), "utf8")).resolves.toBe("current data\n");
    expect(JSON.parse(await readFile(join(canonicalRoot, "channel.json"), "utf8"))).toMatchObject({
      type: "guild",
      platform: "onebot",
      channelId: "101",
      guildId: "101",
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    const restarted = new Channels(new Context(), { basePath: root });
    await expect(restarted.start()).resolves.toBeUndefined();
  });

  it("migrates a legacy direct directory during startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channels-legacy-direct-"));
    roots.push(root);
    // Legacy direct format: direct-${platform}-${channelId}-${selfId}
    const legacyRoot = join(root, "channels", "direct-onebot-user123-bot456");
    await mkdir(legacyRoot, { recursive: true });
    await Promise.all([
      writeFile(
        join(legacyRoot, "channel.json"),
        '{"type":"direct","platform":"onebot","channelId":"user123","selfId":"bot456","createdAt":"2026-08-01T00:00:00.000Z"}\n',
      ),
      writeFile(join(legacyRoot, "legacy.txt"), "legacy direct data\n"),
    ]);

    const channels = new Channels(new Context(), { basePath: root });
    await channels.start();
    // New format uses userId instead of channelId
    const channel = await channels.resolve({ type: "direct", platform: "onebot", selfId: "bot456", channelId: "user123", userId: "user123" });
    const canonicalRoot = join(root, "channels", "direct-onebot-user123-bot456");

    // For this case, channelId === userId, so directory name stays the same
    expect(channel.root).toBe(canonicalRoot);
    await expect(readFile(join(canonicalRoot, "legacy.txt"), "utf8")).resolves.toBe("legacy direct data\n");
    expect(JSON.parse(await readFile(join(canonicalRoot, "channel.json"), "utf8"))).toMatchObject({
      type: "direct",
      platform: "onebot",
      channelId: "user123",
      selfId: "bot456",
      userId: "user123",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("does not recreate overflow rows while resetting a cold channel", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channels-reset-cold-fragments-"));
    roots.push(root);
    const context = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
    const channelRoot = join(root, "channels", "guild-test-room");
    const sessionsPath = join(channelRoot, "sessions");
    await mkdir(sessionsPath, { recursive: true });
    await writeFile(join(channelRoot, "channel.json"), `${JSON.stringify({ ...context, createdAt: "2026-09-24T00:00:00.000Z" })}\n`);
    const first = createEntry(
      "compact",
      { summary: "old fragment", lastEntryId: "source-1", lineageId: "lineage-a", endAt: 100 },
      { id: "compact-1", timestamp: 101 },
    );
    const second = createEntry(
      "compact",
      { summary: "new fragment", lastEntryId: "source-2", lineageId: "lineage-a", endAt: 200, parentCompactId: "compact-1" },
      { id: "compact-2", timestamp: 201 },
    );
    const sessionFile = join(sessionsPath, "20260924T120000Z.jsonl");
    await writeFile(sessionFile, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);

    const rows = new Map<string, Record<string, unknown>>();
    const model = {
      extend: vi.fn(),
      get: vi.fn(async (_table: string, query: Record<string, unknown>, fields?: string[]) => {
        const matches = [...rows.values()].filter((row) => Object.entries(query).every(([key, value]) => row[key] === value));
        return fields ? matches.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]]))) : matches;
      }),
      set: vi.fn(async (_table: string, query: Record<string, unknown>, values: Record<string, unknown>) => {
        for (const [id, row] of rows) if (Object.entries(query).every(([key, value]) => row[key] === value)) rows.set(id, { ...row, ...values });
      }),
      create: vi.fn(async (_table: string, row: Record<string, unknown>) => {
        rows.set(String(row.id), row);
        return row;
      }),
      remove: vi.fn(async (_table: string, query: Record<string, unknown>) => {
        for (const [id, row] of rows) if (Object.entries(query).every(([key, value]) => row[key] === value)) rows.delete(id);
      }),
    };
    const logger = { level: 2, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const channels = new Channels({ database: {}, model, logger: () => logger } as never, {
      basePath: root,
      compactConfig: { minMessages: 1, maxFailures: 3, inlineFragments: 1 },
    });

    await channels.reset(context);

    expect(model.create).toHaveBeenCalledOnce();
    expect(model.remove).toHaveBeenCalledWith(COMPACT_FRAGMENT_TABLE, { channelKey: "guild:test:room" });
    expect(rows.size).toBe(0);
    await expect(readFile(sessionFile, "utf8")).rejects.toThrow();
  });

  it("does not clear session data when deleting the channel fragment index fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channels-reset-fragments-"));
    roots.push(root);
    const remove = vi.fn(async () => {
      throw new Error("database offline");
    });
    const model = {
      extend: vi.fn(),
      get: vi.fn(async () => []),
      set: vi.fn(),
      create: vi.fn(),
      remove,
    };
    const logger = { level: 2, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const channels = new Channels({ database: {}, model, logger: () => logger } as never, { basePath: root });
    const context = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
    const channel = await channels.resolve(context);
    await channel.conversation.storage.append(createEntry("message", { role: "user", content: "keep this history" }));

    await expect(channels.reset(context)).rejects.toThrow("database offline");

    expect(remove).toHaveBeenCalledWith(COMPACT_FRAGMENT_TABLE, { channelKey: "guild:test:room" });
    await expect(channel.conversation.storage.read()).resolves.toHaveLength(1);
    await expect(channels.resolve(context)).resolves.toBe(channel);
  });

  it("migrates a legacy direct directory with different channelId and userId", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-channels-legacy-direct-diff-"));
    roots.push(root);
    // Legacy direct format: direct-${platform}-${channelId}-${selfId}
    // But manifest already has userId (different from channelId)
    const legacyRoot = join(root, "channels", "direct-onebot-private-bot456");
    await mkdir(legacyRoot, { recursive: true });
    await Promise.all([
      writeFile(
        join(legacyRoot, "channel.json"),
        '{"type":"direct","platform":"onebot","channelId":"private","selfId":"bot456","userId":"user789","createdAt":"2026-08-01T00:00:00.000Z"}\n',
      ),
      writeFile(join(legacyRoot, "legacy.txt"), "legacy direct data\n"),
    ]);

    const channels = new Channels(new Context(), { basePath: root });
    await channels.start();
    const channel = await channels.resolve({ type: "direct", platform: "onebot", selfId: "bot456", channelId: "private", userId: "user789" });
    const canonicalRoot = join(root, "channels", "direct-onebot-user789-bot456");

    expect(channel.root).toBe(canonicalRoot);
    await expect(readFile(join(canonicalRoot, "legacy.txt"), "utf8")).resolves.toBe("legacy direct data\n");
    await expect(readFile(join(legacyRoot, "legacy.txt"), "utf8")).rejects.toThrow();
    expect(JSON.parse(await readFile(join(canonicalRoot, "channel.json"), "utf8"))).toMatchObject({
      type: "direct",
      platform: "onebot",
      channelId: "private",
      selfId: "bot456",
      userId: "user789",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  });
});
