import { createEntry, type AgentEntry } from "@yesimbot/agent-runtime";
import { describe, expect, it } from "vitest";

import {
  ContextBlockStore,
  resolveCompactSource,
  safeSourceRecords,
  type CompactEntry,
  type ContextSourceSnapshot,
} from "../src/conversations/context-blocks.js";

const user = (id: string, text = id): AgentEntry => createEntry("message", { id, timestamp: 1, role: "user", content: text }, { id, timestamp: 1 });
const compact = (id: string, data: Partial<CompactEntry["data"]> = {}): CompactEntry =>
  createEntry(
    "compact",
    { summary: id, mode: "compartment", compartmentId: id, lineageId: "c1", sourceSession: "source.jsonl", firstEntryId: "u1", lastEntryId: "u2", ...data },
    { id, timestamp: 2 },
  );
function snapshot(active: readonly AgentEntry[], sessions: Record<string, readonly AgentEntry[]> = { source: active }): ContextSourceSnapshot {
  return {
    sessionId: "source",
    entries: active,
    compacts: Object.values(sessions)
      .flat()
      .filter((entry): entry is CompactEntry => entry.type === "compact"),
    sessionIds: Object.keys(sessions),
    readSession: async (id) => sessions[id] ?? [],
  };
}

function speech(id: string, messages: string[], proof?: Record<string, unknown>): AgentEntry[] {
  return [
    createEntry(
      "message",
      {
        id: `${id}_call`,
        timestamp: 1,
        role: "assistant",
        content: [
          { type: "text", text: "PRIVATE assistant text" },
          { type: "reasoning", text: "PRIVATE reasoning" },
          { type: "tool-call", toolCallId: id, toolName: "send_message", input: { messages } },
        ],
      },
      { id: `${id}_call`, timestamp: 1 },
    ),
    ...(proof
      ? [
          createEntry(
            "message",
            {
              id: `${id}_result`,
              timestamp: 2,
              role: "tool",
              content: [{ type: "tool-result", toolCallId: id, toolName: "send_message", output: { type: "json", value: proof } }],
            },
            { id: `${id}_result`, timestamp: 2 },
          ),
        ]
      : []),
  ];
}

describe("verified source catalogue and pagination", () => {
  it("builds bounded searchable raw blocks without a compact/model and excludes the active turn", async () => {
    const entries = Array.from({ length: 35 }, (_, i) => user(`u${i}`, `history${i} banana`));
    const store = new ContextBlockStore(async () => snapshot(entries));
    const first = await store.list({ limit: 20 }, new Set(["u34"]));
    expect(first.blocks).toHaveLength(20);
    expect(first.nextCursor).toBeDefined();
    const next = await store.list({ limit: 20, cursor: first.nextCursor }, new Set(["u34"]));
    expect(next.blocks).toHaveLength(14);
    expect(new Set([...first.blocks, ...next.blocks].map((block) => block.id)).size).toBe(34);
    expect((await store.list({ query: "not found" })).blocks).toEqual([]);
    expect((await store.list({ query: "banana" })).blocks).toHaveLength(10);
    await expect(store.list({ cursor: "forged" })).rejects.toThrow("InvalidCursor");
    await expect(store.list({ limit: 21 })).rejects.toThrow("InvalidLimit");
    expect(first.blocks.every((block) => Buffer.byteLength(block.summary!, "utf8") <= 400)).toBe(true);
  });
  it("paginates 60 records and long multibyte text without gaps or changing the source", async () => {
    const text = "🙂中<&>".repeat(1000);
    const raw = [user("u1", text), ...Array.from({ length: 59 }, (_, i) => user(`middle${i}`, `record${i}`)), user("u2")];
    const c = compact("c1");
    const entries = [...raw, c];
    const before = JSON.stringify(entries);
    const store = new ContextBlockStore(async () => snapshot(entries));
    const rendered: string[] = [];
    const recordIds = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.page({ blockId: "c1", cursor }, 1024);
      expect(page.records.length).toBeLessThanOrEqual(50);
      expect(page.records.length).toBeGreaterThan(0);
      for (const record of page.records) {
        recordIds.add(record.entryId);
        if (record.entryId === "u1") rendered.push(record.text);
      }
      expect(page.nextCursor).not.toBe(cursor);
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 200);
    expect(cursor).toBeUndefined();
    expect(pages).toBeGreaterThan(2);
    expect(rendered.join("")).toBe(text);
    expect(recordIds.size).toBe(61);
    expect(JSON.stringify(entries)).toBe(before);
    const large = await store.page({ blockId: "c1" }, 100_000);
    expect(large.records).toHaveLength(50);
    expect(large.nextCursor).toBeDefined();
  });
  it("rejects cross-block, forged and source-changed cursors", async () => {
    let entries = [user("u1", "x".repeat(3000)), user("u2", "y".repeat(3000))];
    const store = new ContextBlockStore(async () => snapshot(entries));
    const blocks = (await store.list({})).blocks;
    const page = await store.page({ blockId: blocks[0]!.id }, 512);
    await expect(store.page({ blockId: blocks[1]!.id, cursor: page.nextCursor }, 512)).rejects.toThrow("InvalidCursor");
    await expect(store.page({ blockId: blocks[0]!.id, cursor: "forged" }, 512)).rejects.toThrow("InvalidCursor");
    entries = entries.map((entry) => (entry.id === blocks[0]!.firstEntryId ? user(entry.id, "changed") : entry));
    await expect(store.page({ blockId: blocks[0]!.id, cursor: page.nextCursor }, 512)).rejects.toThrow("InvalidCursor");
  });
  it("rejects a late archive-body read after invalidation and does not restore old cursors", async () => {
    const entries = [user("u1", "x".repeat(3000)), user("u2"), compact("c1")];
    let blocked = false;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new ContextBlockStore(async () => ({
      ...snapshot(entries),
      readSession: async () => {
        if (blocked) {
          entered();
          await gate;
        }
        return entries;
      },
    }));
    const first = await store.page({ blockId: "c1" }, 512);
    blocked = true;
    const pending = store.page({ blockId: "c1", cursor: first.nextCursor }, 512);
    await ready;
    store.invalidate();
    release();
    await expect(pending).rejects.toThrow("StaleContextRead");
    blocked = false;
    await expect(store.page({ blockId: "c1", cursor: first.nextCursor }, 512)).rejects.toThrow("InvalidCursor");
  });
  it("does not expose non-ancestor compacts even with identical lineage/time, and does not invent old bounds", async () => {
    const c1 = compact("c1");
    const unrelated = compact("unrelated");
    const legacy = compact("legacy", { lineageId: "legacy", firstEntryId: undefined, lastEntryId: undefined, sourceSession: undefined });
    const active = [legacy];
    const store = new ContextBlockStore(async () => snapshot(active, { source: active, archive: [user("u1"), user("u2"), c1, unrelated] }));
    expect((await store.list({})).blocks).toEqual([expect.objectContaining({ id: "legacy", sourceState: "summary-only" })]);
    await expect(store.page({ blockId: "unrelated" }, 1000)).rejects.toThrow("BlockNotAccessible");
    await expect(store.page({ blockId: "legacy" }, 1000)).rejects.toThrow("RawSourceUnavailable");
  });
  it("normalizes safe explicit session suffixes; rejects path injection, reversed and duplicate bounds", async () => {
    const entries = [user("u1"), user("u2"), compact("c1")];
    expect((await resolveCompactSource(snapshot(entries), "c1")).sessionId).toBe("source");
    for (const bad of [compact("c1", { sourceSession: "../private" }), compact("c1", { firstEntryId: "u2", lastEntryId: "u1" })]) {
      await expect(resolveCompactSource(snapshot([user("u1"), user("u2"), bad]), "c1")).rejects.toThrow(/Invalid/);
    }
    await expect(resolveCompactSource(snapshot([user("u1"), user("u1"), user("u2"), compact("c1")]), "c1")).rejects.toThrow("InvalidSourceBounds");
  });
  it("supports bounded legacy compacts via unique source proof rather than hiding usable original text", async () => {
    const entries = [user("u1"), user("u2"), compact("c1", { sourceSession: undefined })];
    const store = new ContextBlockStore(async () => snapshot(entries));
    expect((await store.list({})).blocks[0]).toMatchObject({ sourceState: "raw" });
    expect((await store.page({ blockId: "c1" }, 1000)).records.map((record) => record.text)).toEqual(["u1", "u2"]);
  });
  it("invalidates pagination when delivery evidence outside the compact range changes", async () => {
    const spoken = speech("send", ["public".repeat(1000)], { ok: true, count: 1 });
    const c = compact("c1", { firstEntryId: "send_call", lastEntryId: "send_call" });
    let entries = [...spoken, c];
    const store = new ContextBlockStore(async () => snapshot(entries));
    const page = await store.page({ blockId: "c1" }, 512);
    expect(page.omittedEntries).toBe(0);
    expect(page.nextCursor).toBeDefined();
    entries = [spoken[0]!, ...speech("send", [], { ok: false, sent: [], failedAt: 0 }).slice(1), c];
    await expect(store.page({ blockId: "c1", cursor: page.nextCursor }, 512)).rejects.toThrow("InvalidCursor");
  });
});

describe("public source records", () => {
  it("preserves user indentation and array text while replacing media with inert labels", () => {
    const text = "  indented code\n  next line  ";
    const array = createEntry(
      "message",
      {
        id: "array",
        timestamp: 1,
        role: "user",
        content: [
          { type: "text", text },
          { type: "image", image: "PRIVATE payload", mediaType: "image/png" },
        ],
      },
      { id: "array", timestamp: 1 },
    );
    const records = safeSourceRecords([user("u", text), array]);
    expect(records.map((record) => record.text)).toEqual([text, text + "[图片]"]);
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
  });
  it("omits private assistant/system/tool text, failed or unproven sends and temporary media", () => {
    const entries = [
      user("u1", "user public"),
      createEntry("message", { id: "system", timestamp: 1, role: "system", content: "PRIVATE system" }),
      ...speech("ok", ["public<inner_thought>PRIVATE thought</inner_thought><img src='artifact://secret'/>"], { ok: true, count: 1 }),
      ...speech("failed", ["PRIVATE failed"], { ok: false, sent: [], failedAt: 0 }),
      ...speech("unknown", ["PRIVATE unproven"]),
    ];
    const records = safeSourceRecords(entries);
    const text = JSON.stringify(records);
    expect(text).toContain("user public");
    expect(text).toContain("public[图片]");
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain("artifact://");
    expect(records).toHaveLength(2);
  });
  it("uses successful input count and completed partial boundary, not platform ID count as a message index", () => {
    const records = safeSourceRecords([
      ...speech("ok", ["a", "b"], { ok: true, count: 2, messageIds: ["one", "two", "three"] }),
      ...speech("partial", ["c", "d", "PRIVATE failed"], { ok: false, sent: ["one"], failedAt: 2 }),
    ]);
    expect(records.map((record) => record.text)).toEqual(["a", "b", "c", "d"]);
  });
  it("does not let sanitization shift a partial proof onto an unproven message", () => {
    const records = safeSourceRecords(
      speech("partial", ["<inner_thought>PRIVATE</inner_thought>", "public completed", "PRIVATE failed"], { ok: false, sent: ["one", "two"], failedAt: 2 }),
    );
    expect(records.map((record) => record.text)).toEqual(["public completed"]);
  });
  it.each([
    { ok: true, count: 0 },
    { ok: true, count: 1, messageIds: [] },
    { ok: true, count: 9 },
    { ok: false, sent: ["id"], failedAt: 0 },
    { ok: false, sent: ["id"], failedAt: 9 },
    { ok: false, sent: ["id"], failedAt: 1 },
  ])("denies malformed or zero delivery evidence %j", (proof) => {
    expect(safeSourceRecords(speech("bad", ["PRIVATE uncertain"], proof))).toEqual([]);
  });
  it("does not trust a receipt before its call or malformed control markup", () => {
    const entries = speech("reversed", ["PRIVATE future"], { ok: true, count: 1 });
    expect(safeSourceRecords([...entries].reverse())).toEqual([]);
    expect(safeSourceRecords(speech("markup", ["<inner_thought>PRIVATE unclosed"], { ok: true, count: 1 }))).toEqual([]);
    expect(safeSourceRecords(speech("ids", ["PRIVATE malformed"], { ok: true, messageIds: [null] }))).toEqual([]);
    expect(safeSourceRecords(speech("count", ["PRIVATE malformed"], { ok: true, count: -1, messageIds: ["id"] }))).toEqual([]);
  });
  it("denies duplicate calls or receipts instead of picking one", () => {
    const entries = speech("duplicate", ["PRIVATE duplicate"], { ok: true, count: 1 });
    expect(safeSourceRecords([...entries, entries[0]!])).toEqual([]);
    expect(safeSourceRecords([...entries, entries[1]!])).toEqual([]);
  });
});
