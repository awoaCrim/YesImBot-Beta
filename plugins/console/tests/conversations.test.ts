import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseConversationJsonl, readConversationPage } from "../src/conversations.js";

vi.mock("@koishijs/loader", () => ({}));

describe("parseConversationJsonl", () => {
  it("distinguishes reasoning from replies and preserves legacy entries", async () => {
    const fixtures = resolve(process.cwd(), "plugins/console/tests/fixtures");
    const content = await readFile(resolve(fixtures, "real-session.jsonl"), "utf8");
    const { entries } = await parseConversationJsonl(content, "real-session.jsonl", fixtures);

    expect(entries.find((entry) => entry.kind === "thought")?.text).toContain("搜一下");
    expect(entries.find((entry) => entry.kind === "assistant")?.text).toContain("今天晴");
    expect(entries.find((entry) => entry.kind === "tool-call")?.toolName).toBe("search_service");
    expect(entries.find((entry) => entry.kind === "will")?.decision).toBe("trigger");
    expect(entries.find((entry) => entry.kind === "compact")?.text).toContain("用户询问天气");
    expect(entries.find((entry) => entry.kind === "user")?.assets?.[0]).toMatchObject({
      kind: "file",
      title: "notes.txt",
    });
  });
});

describe("readConversationPage", () => {
  it("returns the newest ten records and walks older pages without duplicates", async () => {
    await withTempSession(
      Array.from({ length: 25 }, (_, index) => eventLine(index, true, "x".repeat(4_000))),
      async (filePath, channelRoot) => {
        const latest = await readConversationPage(filePath, "session.jsonl", channelRoot);
        expect(latest.entries.map((entry) => entry.eventType)).toEqual(Array.from({ length: 10 }, (_, index) => `event-${index + 15}`));
        expect(latest.entries).toHaveLength(10);
        expect(latest.hasMore).toBe(true);
        expect(latest.nextCursor).toBeTruthy();

        const older = await readConversationPage(filePath, "session.jsonl", channelRoot, { cursor: latest.nextCursor });
        expect(older.entries.map((entry) => entry.eventType)).toEqual(Array.from({ length: 10 }, (_, index) => `event-${index + 5}`));
        const olderIds = new Set(older.entries.map((entry) => entry.id));
        expect(latest.entries.filter((entry) => olderIds.has(entry.id))).toHaveLength(0);
        expect(older.hasMore).toBe(true);

        const oldest = await readConversationPage(filePath, "session.jsonl", channelRoot, { cursor: older.nextCursor });
        expect(oldest.entries.map((entry) => entry.eventType)).toEqual(["event-0", "event-1", "event-2", "event-3", "event-4"]);
        expect(oldest.hasMore).toBe(false);
        expect(oldest.nextCursor).toBeUndefined();
      },
    );
  });

  it("clamps page size, validates cursors, and keeps fallback ids stable", async () => {
    await withTempSession(
      Array.from({ length: 20 }, (_, index) => eventLine(index, index % 2 === 0)),
      async (filePath, channelRoot) => {
        const first = await readConversationPage(filePath, "session.jsonl", channelRoot, { limit: 100 });
        expect(first.entries).toHaveLength(10);

        const samePage = await readConversationPage(filePath, "session.jsonl", channelRoot);
        expect(samePage.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));

        await expect(readConversationPage(filePath, "session.jsonl", channelRoot, { limit: 0 })).rejects.toThrow("Invalid conversation limit");
        await expect(readConversationPage(filePath, "session.jsonl", channelRoot, { cursor: "not-a-cursor" })).rejects.toThrow("Invalid conversation cursor");
      },
    );
  });

  it("keeps ids stable when new records are appended", async () => {
    await withTempSession(
      Array.from({ length: 20 }, (_, index) => eventLine(index, index % 2 === 0)),
      async (filePath, channelRoot) => {
        const before = await readConversationPage(filePath, "session.jsonl", channelRoot);
        await writeFile(filePath, `${Array.from({ length: 22 }, (_, index) => eventLine(index, index % 2 === 0)).join("\n")}\n`, "utf8");
        const after = await readConversationPage(filePath, "session.jsonl", channelRoot);
        expect(after.entries.map((entry) => entry.eventType)).toEqual(Array.from({ length: 10 }, (_, index) => `event-${index + 12}`));
        const beforeIds = new Map(before.entries.map((entry) => [entry.eventType, entry.id]));
        for (const entry of after.entries) {
          if (beforeIds.has(entry.eventType)) expect(entry.id).toBe(beforeIds.get(entry.eventType));
        }
      },
    );
  });

  it("handles blank, malformed, and CRLF lines", async () => {
    await withTempContent(`\r\n${eventLine(0)}\r\nnot-json\r\nnull\r\n  \r\n${eventLine(1)}\r\n${eventLine(2)}\r\n`, async (filePath, channelRoot) => {
      const page = await readConversationPage(filePath, "session.jsonl", channelRoot);
      expect(page.entries.map((entry) => entry.eventType)).toEqual(["event-0", "event-1", "event-2"]);
    });
  });
});

function eventLine(index: number, withId = true, padding = ""): string {
  return JSON.stringify({
    ...(withId ? { id: `entry-${index}` } : {}),
    type: "event",
    timestamp: index,
    data: { type: `event-${index}`, padding },
  });
}

async function withTempSession(lines: string[], callback: (filePath: string, channelRoot: string) => Promise<void>): Promise<void> {
  return withTempContent(`${lines.join("\n")}\n`, callback);
}

async function withTempContent(content: string, callback: (filePath: string, channelRoot: string) => Promise<void>): Promise<void> {
  const channelRoot = await mkdtemp(join(tmpdir(), "yesimbot-console-"));
  const filePath = join(channelRoot, "session.jsonl");
  try {
    await writeFile(filePath, content, "utf8");
    await callback(filePath, channelRoot);
  } finally {
    await rm(channelRoot, { recursive: true, force: true });
  }
}
