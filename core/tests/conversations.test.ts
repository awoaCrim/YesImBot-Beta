import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEntry } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const generateText = vi.hoisted(() => vi.fn());
vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), generateText }));
import { formatContinuityState, parseContinuityDraft } from "../src/conversations/compact.js";
import type { CompactFragmentInput, CompactFragmentWriter } from "../src/conversations/fragment-store.js";
import { Conversation } from "../src/conversations/index.js";
import { createMessage, type MessageRecord } from "../src/messages/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

// ---------------------------------------------------------------------------
// Conversation.archive
// ---------------------------------------------------------------------------

describe("Conversation.archive", () => {
  it("switches active storage to a fresh session", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-archive-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    await conversation.storage.append(createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "hello" }));

    await conversation.archive();

    expect(await conversation.storage.read()).toEqual([]);
    expect(await conversation.list()).toHaveLength(2);
  });
  it("rejects archiving an empty session without creating a destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-archive-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    const before = await conversation.list();
    await expect(conversation.archive(true)).rejects.toThrow("Cannot archive an empty session");
    expect(await conversation.list()).toEqual(before);
  });

  it("creates a blank destination when noSummary is explicit", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-archive-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    await conversation.storage.append(createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "hello" }));
    await conversation.archive(true);
    expect(await conversation.storage.read()).toEqual([]);
    expect((await conversation.list()).filter((item) => item.isActive)).toHaveLength(1);
  });

  it("performs compact on archive and seeds new session with summary", async () => {
    generateText.mockResolvedValue({ text: "archived memory" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-archive-"));
    roots.push(root);
    const conversation = new Conversation(root, { threshold: 0.9, charTokenRatio: 1.8, minMessages: 2, maxFailures: 3 });
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", {
        id: "m1",
        timestamp: 1,
        role: "custom",
        content: "",
        type: "yesimbot.message",
        data: { user: { id: "u1", name: "Alice" }, elements: [{ type: "text", attrs: { content: "hello" }, children: [] }] },
      }),
      createEntry("message", { id: "m2", timestamp: 2, role: "assistant", content: "hi" }),
    );
    await conversation.archive(false, { model: {} as never });
    expect(generateText).toHaveBeenCalled();
    const entries = await conversation.storage.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "compact", data: expect.objectContaining({ summary: "archived memory" }) });
  });

  it("falls back to blank session when compact fails during archive", async () => {
    generateText.mockRejectedValue(new Error("model unavailable"));
    const root = await mkdtemp(join(tmpdir(), "yesimbot-archive-"));
    roots.push(root);
    const conversation = new Conversation(root, { threshold: 0.9, charTokenRatio: 1.8, minMessages: 2, maxFailures: 3 });
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "first" }),
      createEntry("message", { id: "m2", timestamp: 2, role: "assistant", content: "second" }),
    );
    await conversation.archive(false, { model: {} as never });
    expect(await conversation.storage.read()).toEqual([]);
    expect(await conversation.list()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Conversation.compact
// ---------------------------------------------------------------------------

describe("Conversation.compact", () => {
  it("uses the supplied LLM snapshot and appends a compact boundary", async () => {
    generateText.mockResolvedValue({ text: "LLM memory" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-"));
    roots.push(root);
    const conversation = new Conversation(root, { threshold: 0.9, charTokenRatio: 1.8, minMessages: 2, maxFailures: 3 });
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "first" }),
      createEntry("message", { id: "m2", timestamp: 2, role: "assistant", content: "second" }),
    );

    await expect(conversation.compact("manual", { model: {} as never })).resolves.toEqual({ compacted: true });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.anything(),
        system: expect.stringContaining("压缩长期对话记忆"),
        prompt: expect.stringContaining("<conversation>"),
      }),
    );
    const request = generateText.mock.calls[0]?.[0] as { prompt?: string };
    expect(request.prompt).not.toContain("<previous_memory>");
    expect((await conversation.list()).filter((item) => item.isActive)).toHaveLength(1);
    expect(await conversation.storage.read()).toHaveLength(3);
  });

  it("does not activate a new session for an empty model summary", async () => {
    generateText.mockResolvedValue({ text: " " });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-"));
    roots.push(root);
    const conversation = new Conversation(root, { threshold: 0.9, charTokenRatio: 1.8, minMessages: 2, maxFailures: 3 });
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "first" }),
      createEntry("message", { id: "m2", timestamp: 2, role: "assistant", content: "second" }),
    );
    const before = await conversation.list();
    await expect(conversation.compact("manual", { model: {} as never })).resolves.toMatchObject({
      compacted: false,
      reason: "empty_summary",
    });
    expect(await conversation.list()).toEqual(before);
  });
  it("skips model compaction below the minimum message count", async () => {
    generateText.mockReset();
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-"));
    roots.push(root);
    const conversation = new Conversation(root, { threshold: 0.9, charTokenRatio: 1.8, minMessages: 3, maxFailures: 3 });
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "first" }),
      createEntry("message", { id: "m2", timestamp: 2, role: "assistant", content: "second" }),
    );
    await expect(conversation.compact("auto", { model: {} as never })).resolves.toEqual({
      compacted: false,
      reason: "minimum_messages",
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("keeps the active session when the model fails", async () => {
    generateText.mockReset().mockRejectedValue(new Error("model unavailable"));
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-"));
    roots.push(root);
    const conversation = new Conversation(root, { threshold: 0.9, charTokenRatio: 1.8, minMessages: 2, maxFailures: 3 });
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "first" }),
      createEntry("message", { id: "m2", timestamp: 2, role: "assistant", content: "second" }),
    );
    const before = await conversation.status();
    await expect(conversation.compact("manual", { model: {} as never })).resolves.toEqual({
      compacted: false,
      reason: "model_failure",
    });
    expect(await conversation.status()).toEqual(before);
  });

  it("persists the compact source boundary and resets failures after success", async () => {
    generateText.mockReset().mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce({ text: "stable memory" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-"));
    roots.push(root);
    const conversation = new Conversation(root, { threshold: 0.9, charTokenRatio: 1.8, minMessages: 2, maxFailures: 2 });
    await conversation.init();
    const sourceSession = (await conversation.status()).active!.filename.replace(/\.jsonl$/, "");
    await conversation.storage.append(
      createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "first" }),
      createEntry("message", { id: "m2", timestamp: 2, role: "assistant", content: "second" }),
    );
    await conversation.compact("manual", { model: {} as never });
    await expect(conversation.compact("manual", { model: {} as never })).resolves.toEqual({ compacted: true });
    const entries = await conversation.storage.read();
    expect(entries).toHaveLength(3);
    expect(entries.at(-1)).toMatchObject({ type: "compact", data: expect.objectContaining({ sourceSession, summary: "stable memory" }) });
  });

  it("stops trying after the configured consecutive failure limit", async () => {
    generateText.mockReset().mockRejectedValue(new Error("model unavailable"));
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-"));
    roots.push(root);
    const conversation = new Conversation(root, { threshold: 0.9, charTokenRatio: 1.8, minMessages: 2, maxFailures: 1 });
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "first" }),
      createEntry("message", { id: "m2", timestamp: 2, role: "assistant", content: "second" }),
    );
    await conversation.compact("manual", { model: {} as never });
    await expect(conversation.compact("manual", { model: {} as never })).resolves.toEqual({
      compacted: false,
      reason: "failure_limit",
    });
    expect(generateText).toHaveBeenCalledOnce();
  });

  it("counts only messages after the latest compact boundary", async () => {
    generateText.mockReset().mockResolvedValue({ text: "memory" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-count-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3 });
    await conversation.init();
    await conversation.storage.append(createEntry("message", { id: "m1", timestamp: 1, role: "assistant", content: "first" }));
    expect(await conversation.messagesSinceLastCompact()).toBe(1);
    await conversation.compact("manual", { model: {} as never });
    await conversation.storage.append(
      createEntry("event", { type: "diagnostic", timestamp: 3 }),
      createEntry("message", { id: "m2", timestamp: 4, role: "assistant", content: "second" }),
    );
    expect(await conversation.messagesSinceLastCompact()).toBe(1);
  });

  it("counts platform user messages as turns and resets at the latest compact boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-turns-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3 });
    await conversation.init();
    const first = createEntry("message", createMessage(record("m1", 1)), { id: "user-1" });
    await conversation.storage.append(
      first,
      createEntry("message", { id: "assistant-1", timestamp: 2, role: "assistant", content: "answer" }),
      createEntry("message", { id: "tool-1", timestamp: 3, role: "tool", content: [] }),
      createEntry("event", { type: "diagnostic", timestamp: 4 }),
      createEntry("message", { id: "user-2", timestamp: 5, role: "user", content: "second" }),
    );

    expect(await conversation.userTurnsSinceLastCompact()).toBe(2);

    await conversation.storage.append(createEntry("compact", { summary: "memory", lastEntryId: first.id }, { id: "compact-1" }));
    expect(await conversation.userTurnsSinceLastCompact()).toBe(1);
  });

  it("can compact historical messages without including excluded current-turn entries", async () => {
    generateText.mockReset().mockResolvedValue({ text: "historical memory" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-exclude-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 20, maxFailures: 3 });
    await conversation.init();
    await conversation.storage.append(
      createEntry(
        "message",
        {
          id: "history",
          timestamp: 1,
          role: "custom",
          content: "",
          type: "yesimbot.message",
          data: { user: { id: "history", name: "History" }, elements: [{ type: "text", attrs: { content: "historical text" }, children: [] }] },
        },
        { id: "history" },
      ),
      createEntry(
        "message",
        {
          id: "current",
          timestamp: 2,
          role: "custom",
          content: "",
          type: "yesimbot.message",
          data: { user: { id: "current", name: "Current" }, elements: [{ type: "text", attrs: { content: "current text" }, children: [] }] },
        },
        { id: "current" },
      ),
    );

    await expect(conversation.compact("turn-limit", { model: {} as never, force: true, excludeMessageIds: ["current"] })).resolves.toEqual({
      compacted: true,
    });

    const request = generateText.mock.calls.at(-1)?.[0] as { prompt?: string };
    expect(request.prompt).toContain("historical text");
    expect(request.prompt).not.toContain("current text");
    expect((await conversation.storage.read()).at(-1)).toMatchObject({ type: "compact", data: { lastEntryId: "history" } });
    expect((await conversation.storage.read()).filter((entry) => entry.type === "message")).toHaveLength(2);
  });

  it("keeps excluded current messages in the logical tail for later compaction", async () => {
    generateText.mockReset().mockResolvedValueOnce({ text: "historical memory" }).mockResolvedValueOnce({ text: "complete memory" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-tail-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3 });
    await conversation.init();
    await conversation.storage.append(
      createEntry(
        "message",
        {
          id: "history",
          timestamp: 1,
          role: "custom",
          content: "",
          type: "yesimbot.message",
          data: { user: { id: "history", name: "History" }, elements: [{ type: "text", attrs: { content: "historical text" }, children: [] }] },
        },
        { id: "history" },
      ),
      createEntry(
        "message",
        {
          id: "current",
          timestamp: 2,
          role: "custom",
          content: "",
          type: "yesimbot.message",
          data: { user: { id: "current", name: "Current" }, elements: [{ type: "text", attrs: { content: "current text" }, children: [] }] },
        },
        { id: "current" },
      ),
    );

    await expect(conversation.compact("turn-limit", { model: {} as never, force: true, excludeMessageIds: ["current"] })).resolves.toEqual({
      compacted: true,
    });
    expect(await conversation.messagesSinceLastCompact()).toBe(1);

    await expect(conversation.compact("periodic", { model: {} as never })).resolves.toEqual({ compacted: true });
    const request = generateText.mock.calls.at(-1)?.[0] as { prompt?: string };
    expect(request.prompt).toContain("current text");
    expect((await conversation.storage.read()).filter((entry) => entry.type === "message")).toHaveLength(2);
  });

  it("records independent source metadata and never feeds an older summary back into compaction", async () => {
    generateText.mockReset().mockResolvedValueOnce({ text: "第一段记忆" }).mockResolvedValueOnce({ text: "第二段记忆" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-source-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3 });
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", { id: "m1", timestamp: 1_000, role: "user", content: "first" }, { id: "m1", timestamp: 60_000 }),
      createEntry("message", { id: "m2", timestamp: 2_000, role: "assistant", content: "second" }, { id: "m2", timestamp: 120_000 }),
    );
    await expect(conversation.compact("manual", { model: {} as never })).resolves.toEqual({ compacted: true });

    const first = (await conversation.storage.read()).find((entry) => entry.type === "compact")!;
    expect(first.data).toMatchObject({ firstEntryId: "m1", lastEntryId: "m2", startAt: 1_000, endAt: 2_000 });
    const firstRequest = generateText.mock.calls.at(-1)?.[0] as { prompt?: string };
    expect(firstRequest.prompt).toContain("1970-01-01 08:00");
    expect(firstRequest.prompt).not.toContain("1970-01-01 08:01");
    expect(first.data.lineageId).toBe(first.id);
    expect(first.data.parentCompactId).toBeUndefined();

    await conversation.storage.append(spokenEntry("m3", 3_000, "third"), spokenEntry("m4", 4_000, "fourth"));
    await expect(conversation.compact("manual", { model: {} as never })).resolves.toEqual({ compacted: true });

    const entries = await conversation.storage.read();
    const second = entries.find((entry) => entry.type === "compact" && entry.id !== first.id)!;
    expect(second.data).toMatchObject({
      firstEntryId: "m3",
      lastEntryId: "m4",
      startAt: 3_000,
      endAt: 4_000,
      lineageId: first.data.lineageId,
      parentCompactId: first.id,
    });

    const secondRequest = generateText.mock.calls.at(-1)?.[0] as { prompt?: string };
    expect(secondRequest.prompt).toContain("third");
    expect(secondRequest.prompt).not.toContain("第一段记忆");
    expect(secondRequest.prompt).not.toContain("<previous_memory>");
  });

  it("writes only fragments older than the resident window to the overflow store", async () => {
    generateText.mockReset().mockResolvedValue({ text: "memory" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-overflow-"));
    roots.push(root);
    const upsert = vi.fn(async (_fragments: readonly CompactFragmentInput[]) => undefined);
    const writer: CompactFragmentWriter = { upsert };
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3, inlineFragments: 1 }, { channelKey: "guild:test:room", fragments: writer });
    await conversation.init();

    await conversation.storage.append(spokenEntry("m1", 1, "a"), spokenEntry("m2", 2, "b"));
    await conversation.compact("manual", { model: {} as never });
    expect(upsert).not.toHaveBeenCalled();

    await conversation.storage.append(spokenEntry("m3", 3, "c"));
    await conversation.compact("manual", { model: {} as never });
    const compacts = (await conversation.storage.read()).filter((entry) => entry.type === "compact");
    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0]?.[0].map((fragment) => fragment.id)).toEqual([compacts[0]!.id]);
    expect(upsert.mock.calls[0]?.[0][0]).toMatchObject({ channelKey: "guild:test:room", lineageId: compacts[0]!.id });

    await conversation.storage.append(spokenEntry("m4", 4, "d"));
    await conversation.compact("manual", { model: {} as never });
    expect(upsert.mock.calls.at(-1)?.[0].map((fragment) => fragment.id)).toEqual([compacts[0]!.id, compacts[1]!.id]);
  });

  it("rebuilds the overflow index from archived JSONL after a restart", async () => {
    generateText.mockReset().mockResolvedValue({ text: "memory" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-rebuild-"));
    roots.push(root);
    const failingWriter: CompactFragmentWriter = { upsert: vi.fn(async () => Promise.reject(new Error("database offline"))) };
    const conversation = new Conversation(
      root,
      { minMessages: 1, maxFailures: 3, inlineFragments: 1 },
      { channelKey: "guild:test:room", fragments: failingWriter },
    );
    await conversation.init();
    await conversation.storage.append(spokenEntry("m1", 1_000, "project alpha one"));
    await conversation.compact("manual", { model: {} as never });
    await conversation.storage.append(spokenEntry("m2", 2_000, "project alpha two"));
    await conversation.compact("manual", { model: {} as never });
    const originalCompacts = (await conversation.storage.read()).filter((entry) => entry.type === "compact");
    await conversation.archive(true);

    const repairedUpsert = vi.fn(async (_fragments: readonly CompactFragmentInput[]) => undefined);
    const restarted = new Conversation(
      root,
      { minMessages: 1, maxFailures: 3, inlineFragments: 1 },
      { channelKey: "guild:test:room", fragments: { upsert: repairedUpsert } },
    );
    await restarted.init();

    expect(repairedUpsert).toHaveBeenCalledOnce();
    expect(repairedUpsert.mock.calls[0]?.[0].map((fragment) => fragment.id)).toEqual(originalCompacts.map((entry) => entry.id));
  });

  it("keeps the durable compact entry when the overflow store fails", async () => {
    generateText.mockReset().mockResolvedValue({ text: "memory" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-store-failure-"));
    roots.push(root);
    const onFragmentError = vi.fn();
    const writer: CompactFragmentWriter = { upsert: vi.fn(async () => Promise.reject(new Error("database offline"))) };
    const conversation = new Conversation(
      root,
      { minMessages: 1, maxFailures: 1, inlineFragments: 1 },
      { channelKey: "guild:test:room", fragments: writer, onFragmentError },
    );
    await conversation.init();
    await conversation.storage.append(spokenEntry("m1", 1, "a"), spokenEntry("m2", 2, "b"));
    await expect(conversation.compact("manual", { model: {} as never })).resolves.toEqual({ compacted: true });

    await conversation.storage.append(spokenEntry("m3", 3, "c"));
    await expect(conversation.compact("manual", { model: {} as never })).resolves.toEqual({ compacted: true });
    expect(onFragmentError).toHaveBeenCalledWith("sync", expect.any(Error));
    expect((await conversation.storage.read()).filter((entry) => entry.type === "compact")).toHaveLength(2);
    expect(conversation.failuresCount()).toBe(0);
  });

  it("starts a new lineage when archiving without summaries", async () => {
    generateText.mockReset().mockResolvedValueOnce({ text: "old lineage" }).mockResolvedValueOnce({ text: "new lineage" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-archive-reset-lineage-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3 });
    await conversation.init();
    await conversation.storage.append(spokenEntry("old-message", 1, "old"));
    await conversation.compact("manual", { model: {} as never });
    const oldCompact = (await conversation.storage.read()).find((entry) => entry.type === "compact")!;

    await conversation.archive(true);
    await conversation.storage.append(spokenEntry("new-message", 2, "new"));
    await conversation.compact("manual", { model: {} as never });
    const newCompact = (await conversation.storage.read()).find((entry) => entry.type === "compact")!;

    expect(newCompact.id).not.toBe(oldCompact.id);
    expect(newCompact.data.lineageId).toBe(newCompact.id);
    expect(newCompact.data.parentCompactId).toBeUndefined();
  });

  it("keeps an uncovered raw tail when archiving an oversized session", async () => {
    generateText.mockReset().mockResolvedValue({ text: "first compact" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-archive-tail-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3, inlineFragments: 1 });
    await conversation.init();
    await conversation.storage.append(spokenEntry("m1", 1_000, "covered source"));
    await conversation.compact("manual", { model: {} as never });
    await conversation.storage.append(spokenEntry("m2", 2_000, "uncovered tail"));

    await expect(conversation.archiveIfOversize(1)).resolves.toBe(true);

    const seeded = await conversation.storage.read();
    expect(seeded.map((entry) => entry.type)).toEqual(["compact", "message"]);
    expect(seeded[0]).toMatchObject({ type: "compact", data: { summary: "first compact" } });
    expect(seeded[1]).toMatchObject({ id: "m2", type: "message" });
  });

  it("archives the resident fragments and continues their lineage", async () => {
    generateText
      .mockReset()
      .mockResolvedValueOnce({ text: "one" })
      .mockResolvedValueOnce({ text: "two" })
      .mockResolvedValueOnce({ text: "three" })
      .mockResolvedValueOnce({ text: "four" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-conversation-archive-lineage-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3, inlineFragments: 2 });
    await conversation.init();
    for (const [index, text] of ["a", "b", "c"].entries()) {
      await conversation.storage.append(spokenEntry(`m${index}`, index + 1, text));
      await conversation.compact("manual", { model: {} as never });
    }
    const before = (await conversation.storage.read()).filter((entry) => entry.type === "compact");

    await conversation.archive(false, { model: {} as never });
    const seeded = await conversation.storage.read();
    expect(seeded).toHaveLength(2);
    expect(seeded.map((entry) => entry.id)).toEqual([before[1]!.id, before[2]!.id]);

    await conversation.storage.append(spokenEntry("m4", 10, "d"));
    await conversation.compact("manual", { model: {} as never });
    const continued = (await conversation.storage.read()).filter((entry) => entry.type === "compact").at(-1)!;
    expect(continued.data.lineageId).toBe(before[0]!.data.lineageId);
    expect(continued.data.parentCompactId).toBe(before[2]!.id);
  });
});

function spokenEntry(id: string, timestamp: number, content: string) {
  return createEntry("message", { id, timestamp, role: "assistant", content }, { id, timestamp });
}
describe("Conversation compartment mode", () => {
  it("creates bounded incremental compartments with stable expansion metadata", async () => {
    generateText.mockReset().mockResolvedValueOnce({ text: "事实一" }).mockResolvedValueOnce({ text: "事实二" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-compartment-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3, mode: "compartment", chunkMessages: 2, chunkChars: 10_000 });
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "第一条" }, { id: "m1", timestamp: 1 }),
      createEntry("message", { id: "m2", timestamp: 2, role: "user", content: "第二条" }, { id: "m2", timestamp: 2 }),
      createEntry("message", { id: "m3", timestamp: 3, role: "user", content: "第三条" }, { id: "m3", timestamp: 3 }),
    );

    await expect(conversation.compact("manual", { model: {} as never })).resolves.toEqual({ compacted: true });
    const compacts = (await conversation.storage.read()).filter((entry) => entry.type === "compact");
    expect(compacts).toHaveLength(2);
    expect(compacts[0]).toMatchObject({
      type: "compact",
      data: { mode: "compartment", compartmentId: compacts[0]!.id, compartmentLabel: "compartment-1", firstEntryId: "m1", lastEntryId: "m2" },
    });
    expect(compacts[1]).toMatchObject({ data: { parentCompactId: compacts[0]!.id, firstEntryId: "m3", lastEntryId: "m3" } });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("keeps successful chunks when a later historian call fails and resumes the raw tail", async () => {
    generateText.mockReset().mockResolvedValueOnce({ text: "第一段" }).mockRejectedValueOnce(new Error("temporary"));
    const root = await mkdtemp(join(tmpdir(), "yesimbot-compartment-retry-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3, mode: "compartment", chunkMessages: 1, chunkChars: 10_000 });
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "一" }, { id: "m1", timestamp: 1 }),
      createEntry("message", { id: "m2", timestamp: 2, role: "user", content: "二" }, { id: "m2", timestamp: 2 }),
    );

    await expect(conversation.compact("manual", { model: {} as never })).resolves.toEqual({ compacted: true, reason: "partial_failure" });
    expect((await conversation.storage.read()).filter((entry) => entry.type === "compact")).toHaveLength(1);

    generateText.mockResolvedValueOnce({ text: "第二段" });
    await expect(conversation.compact("manual", { model: {} as never })).resolves.toEqual({ compacted: true });
    const compacts = (await conversation.storage.read()).filter((entry) => entry.type === "compact");
    expect(compacts).toHaveLength(2);
    expect(compacts[1]!.data.firstEntryId).toBe("m2");
  });

  it("expands only the current conversation's raw records with bounded pagination", async () => {
    generateText.mockReset().mockResolvedValue({ text: "历史事实" });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-compartment-expand-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3, mode: "compartment", chunkMessages: 3, chunkChars: 10_000 });
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "原始一" }, { id: "m1", timestamp: 1 }),
      createEntry("message", { id: "m2", timestamp: 2, role: "user", content: "原始二" }, { id: "m2", timestamp: 2 }),
    );
    await conversation.compact("manual", { model: {} as never });
    const compact = (await conversation.storage.read()).find((entry) => entry.type === "compact")!;
    const beforeStorage = await conversation.storage.read();
    const beforeCalls = generateText.mock.calls.length;
    const first = await conversation.expandCompartment(compact.id, { limit: 1 });
    expect(first).toMatchObject({ compartmentId: compact.id, offset: 0, limit: 1, total: 2, nextOffset: 1 });
    expect(first.entries[0]).toMatchObject({ entryId: "m1", role: "user", text: "原始一" });
    await expect(conversation.expandCompartment(compact.id, { offset: 1, limit: 50 })).resolves.toMatchObject({
      entries: [{ entryId: "m2", text: "原始二" }],
    });
    expect(generateText).toHaveBeenCalledTimes(beforeCalls);
    expect(await conversation.storage.read()).toEqual(beforeStorage);
    await expect(conversation.expandCompartment("missing")).rejects.toThrow("was not found");
  });
});

describe("Conversation continuity", () => {
  it("persists a verified structured card once and reuses the same source fingerprint", async () => {
    generateText.mockReset().mockResolvedValue({
      text: JSON.stringify({
        goal: "完成连续性实现",
        decisions: ["采用只读历史卡片"],
        constraints: ["不暴露内部指令"],
        facts: ["历史来源可核对"],
        unresolved: ["需要继续验证"],
        completed: ["已保存来源边界"],
        pending: ["等待下一轮"],
      }),
    });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-continuity-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3, mode: "compartment" });
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", { id: "m1", timestamp: 100, role: "user", content: "历史目标" }, { id: "m1", timestamp: 100 }),
      createEntry("message", { id: "m2", timestamp: 200, role: "user", content: "历史决定" }, { id: "m2", timestamp: 200 }),
    );

    const first = await conversation.ensureContinuity({ model: {} as never, sourceEntryIds: ["m1", "m2"] });
    const second = await conversation.ensureContinuity({ model: {} as never, sourceEntryIds: ["m2", "m1"] });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(first.entry.data).toMatchObject({ sourceCount: 2, firstEntryId: "m1", lastEntryId: "m2", sourceStartAt: 100, sourceEndAt: 200 });
    expect((await conversation.storage.read()).filter((entry) => entry.type === "continuity")).toHaveLength(1);
    expect(generateText).toHaveBeenCalledOnce();
    const firstCall = generateText.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect((firstCall![0] as { prompt: string }).prompt).toContain("historical-data");
    expect(formatContinuityState(first.entry.data)).toContain("historical-data");
    expect(formatContinuityState(first.entry.data)).not.toContain("forged");
  });

  it("recalls only verified same-lineage continuity before the current source bound", async () => {
    generateText.mockReset().mockResolvedValue({
      text: JSON.stringify({
        goal: "完成连续性实现",
        decisions: ["采用只读历史卡片"],
        constraints: [],
        facts: ["来源可核对"],
        unresolved: [],
        completed: [],
        pending: ["继续验证"],
      }),
    });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-continuity-recall-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3, mode: "compartment" });
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", { id: "m1", timestamp: 100, role: "user", content: "历史目标" }, { id: "m1", timestamp: 100 }),
      createEntry("message", { id: "m2", timestamp: 200, role: "user", content: "历史决定" }, { id: "m2", timestamp: 200 }),
    );
    const saved = await conversation.ensureContinuity({ model: {} as never, sourceEntryIds: ["m1", "m2"] });
    const recalled = await conversation.recallContinuity({
      lineageId: saved.entry.data.lineageId,
      query: "连续性",
      before: 201,
      limit: 3,
    });
    expect(recalled.map((entry) => entry.id)).toEqual([saved.entry.id]);
    expect(await conversation.recallContinuity({ lineageId: saved.entry.data.lineageId, query: "连续性", before: 199, limit: 3 })).toEqual([]);
    expect(await conversation.recallContinuity({ lineageId: "other-lineage", query: "连续性", before: 201, limit: 3 })).toEqual([]);

    await conversation.storage.append(
      createEntry("continuity", { ...saved.entry.data, sourceFingerprint: "0".repeat(64) }, { id: "forged-continuity", timestamp: saved.entry.timestamp + 1 }),
    );
    expect(
      (await conversation.recallContinuity({ lineageId: saved.entry.data.lineageId, query: "连续性", before: 201, limit: 3 })).map((entry) => entry.id),
    ).toEqual([saved.entry.id]);
  });

  it("rejects malformed model output and keeps canonical history unchanged", async () => {
    generateText.mockReset().mockResolvedValue({
      text: JSON.stringify({ goal: "bad", decisions: [], constraints: [], facts: [], unresolved: [], completed: [], pending: [], lineageId: "forged" }),
    });
    const root = await mkdtemp(join(tmpdir(), "yesimbot-continuity-invalid-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3, mode: "compartment" });
    await conversation.init();
    await conversation.storage.append(createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "source" }, { id: "m1" }));
    await expect(conversation.ensureContinuity({ model: {} as never, sourceEntryIds: ["m1"] })).rejects.toThrow("InvalidContinuityOutput");
    expect((await conversation.storage.read()).filter((entry) => entry.type === "continuity")).toEqual([]);
    expect(() =>
      parseContinuityDraft(JSON.stringify({ goal: "", decisions: [], constraints: [], facts: [], unresolved: [], completed: [], pending: [] })),
    ).toThrow("InvalidContinuityOutput");
  });
});

describe("Conversation archiving policies", () => {
  it("keeps the storage facade on the new active file after archiving", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-storage-facade-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    const storage = conversation.storage;
    await storage.append(createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "hello" }));

    await conversation.archive(true);

    expect(await storage.read()).toEqual([]);
  });

  it("archives the active file only after it exceeds the byte limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-size-archive-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    await conversation.storage.append(createEntry("message", { id: "m1", timestamp: 1, role: "user", content: "x".repeat(1000) }));

    await expect(conversation.archiveIfOversize(10_000)).resolves.toBe(false);
    await expect(conversation.archiveIfOversize(1)).resolves.toBe(true);
    expect((await conversation.list()).filter((item) => item.isActive)).toHaveLength(1);
    expect(await conversation.storage.read()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Conversation.read
// ---------------------------------------------------------------------------

function record(messageId: string, timestamp: number, userId = "user-1"): MessageRecord {
  return {
    platform: "test",
    selfId: "bot-1",
    timestamp,
    channel: { id: "room-1", type: 0 },
    user: { id: userId, name: userId },
    messageId,
    elements: [],
  };
}

describe("Conversation.read", () => {
  it("reads platform messages across active and archived sessions in chronological source windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-read-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", createMessage(record("first", 1))),
      createEntry("message", { id: "assistant", timestamp: 2, role: "assistant", content: "ignored" }),
      createEntry("event", { type: "started", turnId: "turn" }),
      createEntry("message", createMessage(record("source", 3, "user-2"))),
    );
    await conversation.archive(true);
    await conversation.storage.append(createEntry("message", createMessage(record("last", 4))));

    await expect(conversation.read({ messageIds: ["source", "last"], before: 1, after: 1, userIds: ["user-1", "user-2"] })).resolves.toMatchObject([
      { messageId: "first" },
      { messageId: "source" },
      { messageId: "last" },
    ]);
  });

  it("limits source windows without dropping sources and uses newest entries without sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-read-limit-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    await conversation.storage.append(
      createEntry("message", createMessage(record("one", 1))),
      createEntry("message", createMessage(record("two", 2))),
      createEntry("message", createMessage(record("three", 3))),
    );

    await expect(conversation.read({ messageIds: ["one", "three"], before: 1, after: 1, limit: 1 })).resolves.toMatchObject([
      { messageId: "one" },
      { messageId: "three" },
    ]);
    await expect(conversation.read({ limit: 2 })).resolves.toMatchObject([{ messageId: "two" }, { messageId: "three" }]);
  });
  it("rejects missing and duplicate source ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-read-errors-"));
    roots.push(root);
    const conversation = new Conversation(root);
    await conversation.init();
    await conversation.storage.append(createEntry("message", createMessage(record("duplicate", 1))));
    await conversation.archive(true);
    await conversation.storage.append(createEntry("message", createMessage(record("duplicate", 2))));

    await expect(conversation.read({ messageIds: ["missing"] })).rejects.toThrow("missing");
    await expect(conversation.read({ messageIds: ["duplicate"] })).rejects.toThrow("duplicate");
  });
});
