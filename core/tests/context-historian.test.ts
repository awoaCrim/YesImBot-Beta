import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEntry, type AgentEntry } from "@yesimbot/agent-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.hoisted(() => vi.fn());
vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), generateText }));

import { ContextBlockStore, rangeFingerprint } from "../src/conversations/context-blocks.js";
import {
  generateContextRegionDraft,
  validateContextRegionData,
  validateContextRegionDraft,
  type ContextRegionDraft,
  type ContextRegionEntry,
} from "../src/conversations/historian.js";
import { Conversation } from "../src/conversations/index.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
beforeEach(() => generateText.mockReset());
const draft: ContextRegionDraft = {
  tiers: { P1: "detailed historical banana facts", P2: "historical kiwi facts", P3: "pear fact", P4: "anchor" },
  importance: 0.7,
};
const user = (id: string, text = id): AgentEntry => createEntry("message", { id, timestamp: 1, role: "user", content: text }, { id, timestamp: 1 });
async function fixture(magicContext = true) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-historian-"));
  roots.push(root);
  const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3, mode: "compartment" }, { magicContext });
  await conversation.init();
  return { root, conversation, path: () => join(root, "sessions", conversation.currentSessionId() + ".jsonl") };
}

function speech(): AgentEntry[] {
  return [
    createEntry(
      "message",
      {
        id: "call",
        timestamp: 2,
        role: "assistant",
        content: [
          { type: "text", text: "PRIVATE assistant" },
          { type: "reasoning", text: "PRIVATE reasoning" },
          {
            type: "tool-call",
            toolCallId: "send",
            toolName: "send_message",
            input: { messages: ["public speech<inner_thought>PRIVATE thought</inner_thought>"] },
          },
        ],
      },
      { id: "call", timestamp: 2 },
    ),
    createEntry(
      "message",
      {
        id: "proof",
        timestamp: 3,
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "send", toolName: "send_message", output: { type: "json", value: { ok: true, count: 1 } } }],
      },
      { id: "proof", timestamp: 3 },
    ),
  ];
}

async function commit(conversation: Conversation, ids: readonly string[]) {
  return conversation.commitContextRegion(await conversation.freezeContextRegion(ids), draft);
}

describe("four-tier historian", () => {
  it("generates all tiers from the original safe projection, with delivery proof outside the selected IDs", async () => {
    const { conversation } = await fixture();
    await conversation.storage.append(user("u", "  user public\n"), ...speech());
    const frozen = await conversation.freezeContextRegion(["call", "u"]);
    expect(frozen.sourceEntryIds).toEqual(["u", "call"]);
    expect(frozen.records.map((record) => record.text)).toEqual(["  user public\n", "public speech"]);
    expect(JSON.stringify(frozen)).not.toContain("PRIVATE");
    generateText.mockResolvedValue({ text: JSON.stringify(draft) });
    expect(await generateContextRegionDraft({ model: {} as never, records: frozen.records })).toEqual(draft);
    expect(generateText).toHaveBeenCalledTimes(1);
    const request = generateText.mock.calls[0]![0];
    expect(request.prompt).toContain("public speech");
    expect(request.prompt).not.toContain("PRIVATE");
    expect(request.prompt).not.toContain("proof");
    expect(request.system).toContain("同一原文");
  });
  it("fails oversized original input rather than silently truncating it", async () => {
    const { conversation } = await fixture();
    await conversation.storage.append(user("big", "中".repeat(30_000)));
    await expect(conversation.freezeContextRegion(["big"])).rejects.toThrow("ContextRegionSourceTooLarge");
    await expect(
      generateContextRegionDraft({ model: {} as never, records: [{ entryId: "big", role: "user", timestamp: 1, text: "x".repeat(70_000) }] }),
    ).rejects.toThrow("ContextRegionSourceTooLarge");
    expect(generateText).not.toHaveBeenCalled();
  });
  it.each([
    { ...draft, tiers: { P1: "long", P2: "", P3: "x", P4: "x" } },
    { ...draft, tiers: { P1: "x", P2: "longer", P3: "x", P4: "x" } },
    { ...draft, importance: 1.01 },
    { ...draft, importance: NaN },
    { ...draft, sourceSession: "invented" },
    { ...draft, tiers: { ...draft.tiers, extra: "unknown" } },
    { ...draft, tiers: { P1: "x".repeat(33_000), P2: "x", P3: "x", P4: "x" } },
  ])("rejects incomplete/unbounded/non-descending/model-owned output %#", (value) => {
    expect(() => validateContextRegionDraft(value)).toThrow("InvalidContextRegionOutput");
  });
  it("requires strict JSON, not Markdown or extra model provenance", async () => {
    generateText.mockResolvedValueOnce({ text: "```json\n" + JSON.stringify(draft) + "\n```" });
    await expect(generateContextRegionDraft({ model: {} as never, records: [{ entryId: "u", role: "user", timestamp: 1, text: "hello" }] })).rejects.toThrow(
      "InvalidContextRegionOutput",
    );
  });
  it("supports bounded manifests beyond the old 256-ID limit", async () => {
    const { conversation } = await fixture();
    const raw = Array.from({ length: 300 }, (_, index) => user(`u${index}`));
    await conversation.storage.append(...raw);
    const entry = await commit(
      conversation,
      raw.map((entry) => entry.id),
    );
    expect(entry.data.sourceEntryIds).toHaveLength(300);
    expect(await conversation.contextRegions()).toEqual([entry]);
  });
});

describe("atomic region commits and lifecycle", () => {
  it("allows concurrent tail append during auxiliary generation, then appends one complete recoverable record", async () => {
    const { conversation, root, path } = await fixture();
    await conversation.storage.append(user("u1"));
    const frozen = await conversation.freezeContextRegion(["u1"]);
    let release!: (value: { text: string }) => void;
    generateText.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = generateContextRegionDraft({ model: {} as never, records: frozen.records });
    await conversation.storage.append(user("tail")); // Must resolve while the model is still blocked.
    expect((await conversation.storage.read()).map((entry) => entry.id)).toEqual(["u1", "tail"]);
    release({ text: JSON.stringify(draft) });
    const entry = await conversation.commitContextRegion(frozen, await pending);
    const lines = (await readFile(path(), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!)).toEqual(entry);
    const restarted = new Conversation(root, undefined, { magicContext: true });
    await restarted.init();
    expect(await restarted.contextRegions()).toEqual([entry]);
    expect(generateText).toHaveBeenCalledTimes(1); // Recovery never invokes a model.
  });
  it("deduplicates concurrent same-source commits and rejects overlaps without changing raw", async () => {
    const { conversation } = await fixture();
    await conversation.storage.append(user("u1"), user("u2"), user("u3"));
    const frozen = await conversation.freezeContextRegion(["u1", "u2"]);
    const [first, second] = await Promise.all([conversation.commitContextRegion(frozen, draft), conversation.commitContextRegion(frozen, draft)]);
    expect(first.id).toBe(second.id);
    expect((await conversation.storage.read()).filter((entry) => entry.type === "context-region")).toHaveLength(1);
    await expect(commit(conversation, ["u2", "u3"])).rejects.toThrow("ContextRegionSourceConflict");
    expect((await conversation.storage.read()).filter((entry) => entry.type === "message")).toHaveLength(3);
  });
  it("rejects stale switch/back, archive and clear generations, even when IDs/session return", async () => {
    const { conversation } = await fixture();
    await conversation.storage.append(user("u1"));
    const frozen = await conversation.freezeContextRegion(["u1"]);
    const source = conversation.currentSessionId();
    await conversation.archive(true);
    await conversation.switch(source);
    expect(conversation.currentSessionId()).toBe(frozen.sessionId);
    expect(conversation.storageGeneration).toBeGreaterThan(frozen.storageGeneration);
    await expect(conversation.commitContextRegion(frozen, draft)).rejects.toThrow("StaleContextRegion");
    const beforeArchive = await conversation.freezeContextRegion(["u1"]);
    await conversation.archive(false);
    await expect(conversation.commitContextRegion(beforeArchive, draft)).rejects.toThrow("StaleContextRegion");
    const beforeClear = await conversation.freezeContextRegion(["u1"]);
    await conversation.storage.clear();
    await conversation.storage.append(user("u1"));
    await expect(conversation.commitContextRegion(beforeClear, draft)).rejects.toThrow("StaleContextRegion");
  });
  it("checks cancellation inside a queued mutation, not only before queueing", async () => {
    const { conversation } = await fixture();
    await conversation.storage.append(user("u1"));
    const frozen = await conversation.freezeContextRegion(["u1"]);
    const fileStorage = (conversation as unknown as { currentStorage(): { read(): Promise<readonly AgentEntry[]> } }).currentStorage();
    const canonical = await conversation.storage.read();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(fileStorage, "read").mockImplementationOnce(async () => {
      entered();
      await gate;
      return canonical;
    });
    const holding = conversation.freezeContextRegion(["u1"]);
    await ready;
    const controller = new AbortController();
    const pending = conversation.commitContextRegion(frozen, draft, controller.signal);
    controller.abort(new Error("StoppedContextJob"));
    release();
    await holding;
    await expect(pending).rejects.toThrow("StoppedContextJob");
    expect((await conversation.storage.read()).filter((entry) => entry.type === "context-region")).toEqual([]);
  });
  it("rejects forged frozen values and malformed/duplicate/missing sources", async () => {
    const { conversation } = await fixture();
    await conversation.storage.append(user("u1"));
    const frozen = await conversation.freezeContextRegion(["u1"]);
    await expect(conversation.commitContextRegion({ ...frozen }, draft)).rejects.toThrow("StaleContextRegion");
    for (const ids of [[], ["u1", "u1"], ["missing"]]) await expect(conversation.freezeContextRegion(ids)).rejects.toThrow(/ContextRegionSource/);
    await conversation.storage.append(user("u1"));
    await expect(conversation.freezeContextRegion(["u1"])).rejects.toThrow("ContextRegionSourceConflict");
  });
  it("rechecks readable projection when a duplicate delivery receipt outside the selected range is appended", async () => {
    const { conversation } = await fixture();
    const delivered = speech();
    await conversation.storage.append(...delivered);
    const frozen = await conversation.freezeContextRegion(["call"]);
    await conversation.storage.append({ ...delivered[1]!, id: "duplicate-proof" });
    await expect(conversation.commitContextRegion(frozen, draft)).rejects.toThrow(/ContextRegionSource/);
    expect(await conversation.contextRegions()).toEqual([]);
  });
  it("invalidates an already committed source when external delivery proof changes on disk", async () => {
    const { conversation, root, path } = await fixture();
    await conversation.storage.append(...speech());
    const entry = await commit(conversation, ["call"]);
    const before = await conversation.storage.read();
    const modified = before.map((candidate) =>
      candidate.id === "proof"
        ? createEntry(
            "message",
            {
              id: "proof",
              timestamp: 3,
              role: "tool",
              content: [
                { type: "tool-result", toolCallId: "send", toolName: "send_message", output: { type: "json", value: { ok: false, sent: [], failedAt: 0 } } },
              ],
            },
            { id: "proof", timestamp: 3 },
          )
        : candidate,
    );
    await writeFile(path(), modified.map((candidate) => JSON.stringify(candidate)).join("\n") + "\n");
    const restarted = new Conversation(root, undefined, { magicContext: true });
    await restarted.init();
    expect(await restarted.contextRegions()).toEqual([]);
    const store = new ContextBlockStore(() => restarted.contextSources());
    await expect(store.page({ blockId: entry.id }, 2048)).rejects.toThrow("BlockNotAccessible");
  });
  it("ignores partial/invalid/conflicting records on restart and excludes them from archive seeds", async () => {
    const { conversation, root } = await fixture();
    await conversation.storage.append(user("u1"));
    const entry = await commit(conversation, ["u1"]);
    const incomplete = { ...entry, id: "incomplete", data: { ...entry.data, tiers: { P1: "only one tier" } } } as ContextRegionEntry;
    await conversation.storage.append(incomplete, { ...entry, data: { ...entry.data, tiers: { ...entry.data.tiers, P4: "other" } } });
    const restarted = new Conversation(root, undefined, { magicContext: true });
    await restarted.init();
    expect(await restarted.contextRegions()).toEqual([]);
    await restarted.archive(false);
    expect((await restarted.storage.read()).filter((candidate) => candidate.type === "context-region")).toEqual([]);
    expect((await restarted.storage.read()).filter((candidate) => candidate.type === "message")).toHaveLength(1);
  });
  it("recovers complete commits before a torn final region and safely appends after restart", async () => {
    const { conversation, root, path } = await fixture();
    await conversation.storage.append(user("u1"));
    const entry = await commit(conversation, ["u1"]);
    await appendFile(path(), '{"type":"context-region","data":');
    const restarted = new Conversation(root, undefined, { magicContext: true });
    await restarted.init();
    expect(await restarted.contextRegions()).toEqual([entry]);
    await restarted.storage.append(user("tail"));
    expect((await restarted.storage.read()).map((candidate) => candidate.id)).toEqual(["u1", entry.id, "tail"]);
  });
});

describe("Magic archive and history access", () => {
  it("carries verified regions, proof and all uncovered tail; history remains usable with Magic disabled", async () => {
    const { conversation, root } = await fixture();
    await conversation.storage.append(user("u1"), ...speech());
    const originalSession = conversation.currentSessionId();
    const entry = await commit(conversation, ["u1", "call", "proof"]);
    await conversation.storage.append(user("tail", "uncovered tail"));
    await conversation.archive(false, { model: {} as never });
    expect(generateText).not.toHaveBeenCalled();
    expect(conversation.currentSessionId()).not.toBe(originalSession);
    expect(await conversation.contextRegions()).toEqual([entry]);
    expect((await conversation.storage.read()).filter((candidate) => candidate.type === "message").map((candidate) => candidate.id)).toEqual(["tail"]);
    expect((await conversation.contextRegions())[0]!.data.sourceSession).toBe(originalSession);
    const disabled = new Conversation(root, undefined, { magicContext: false });
    await disabled.init();
    expect((await disabled.storage.read()).filter((candidate) => candidate.type === "message").map((candidate) => candidate.id)).toEqual(["tail"]);
    expect((await disabled.expandCompartment(entry.id)).entries.map((record) => record.text)).toEqual(["u1", "public speech"]);
    const store = new ContextBlockStore(() => conversation.contextSources());
    expect((await store.page({ blockId: entry.id }, 2048)).records.map((record) => record.text)).toEqual(["u1", "public speech"]);
    expect((await store.list({ query: "kiwi" })).blocks.map((block) => block.id)).toContain(entry.id); // P2 search, not only preview.
    expect((await store.list({ query: "pear" })).blocks.map((block) => block.id)).toContain(entry.id); // P3 search.
    expect((await store.list({ query: "anchor" })).blocks.map((block) => block.id)).toContain(entry.id); // P4 search.
  });
  it("preserves every raw tail even when there are no regions, for manual and size archives", async () => {
    const { conversation } = await fixture();
    await conversation.storage.append(user("u1"), user("u2"));
    expect(await conversation.archiveIfOversize(0, { model: {} as never })).toBe(false);
    await conversation.archive(false, { model: {} as never });
    expect((await conversation.storage.read()).map((entry) => entry.id)).toEqual(["u1", "u2"]);
    const session = conversation.currentSessionId();
    expect(await conversation.archiveIfOversize(1, { model: {} as never })).toBe(false);
    expect(conversation.currentSessionId()).toBe(session); // No new oversized copy on every input.
    expect((await conversation.storage.read()).map((entry) => entry.id)).toEqual(["u1", "u2"]);
    expect(generateText).not.toHaveBeenCalled();
  });
  it("auto-archives useful coverage once without copying covered raw or rotating the same oversized seed", async () => {
    const { conversation, root, path } = await fixture();
    await conversation.storage.append(user("old", "x".repeat(10000)), user("tail"));
    const region = await commit(conversation, ["old"]);
    const original = path();
    const originalBytes = await readFile(original);
    expect(await conversation.archiveIfOversize(1)).toBe(true);
    expect((await conversation.storage.read()).some((entry) => entry.id === "old")).toBe(false);
    expect(await readFile(original)).toEqual(originalBytes);
    const archived = conversation.currentSessionId();
    expect(await conversation.archiveIfOversize(1)).toBe(false);
    expect(conversation.currentSessionId()).toBe(archived);
    const restored = new Conversation(root, undefined, { magicContext: true });
    await restored.init();
    expect(await restored.contextRegions()).toEqual([region]);
  });
  it("does not split canonical tool pairs when a legacy partial source manifest is archived", async () => {
    const { conversation } = await fixture();
    await conversation.storage.append(...speech());
    await commit(conversation, ["call"]);
    await conversation.archive(false);
    expect((await conversation.storage.read()).filter((entry) => entry.type === "message").map((entry) => entry.id)).toEqual(["call", "proof"]);
  });
  it("noSummary starts an empty isolated lineage and cannot retrieve old regions", async () => {
    const { conversation } = await fixture();
    await conversation.storage.append(user("u1"));
    const entry = await commit(conversation, ["u1"]);
    await conversation.archive(true);
    expect(await conversation.storage.read()).toEqual([]);
    expect(await conversation.contextRegions()).toEqual([]);
    const store = new ContextBlockStore(() => conversation.contextSources());
    expect((await store.list({ query: "banana" })).blocks).toEqual([]);
    await expect(store.page({ blockId: entry.id }, 2048)).rejects.toThrow("BlockNotAccessible");
    await conversation.storage.append(user("new"));
    expect((await conversation.freezeContextRegion(["new"])).lineageId).toBe(conversation.currentSessionId());
  });
  it("carries legacy single-layer compact and valid continuity without upgrading or model calls", async () => {
    const { conversation } = await fixture();
    await conversation.storage.append(user("u1"));
    const session = conversation.currentSessionId();
    const legacy = createEntry(
      "compact",
      { summary: "legacy single layer", lastEntryId: "u1", firstEntryId: "u1", sourceSession: session, lineageId: "old-lineage" },
      { id: "legacy" },
    );
    const continuity = createEntry(
      "continuity",
      {
        version: 1,
        lineageId: "old-lineage",
        sourceSession: session,
        firstEntryId: "u1",
        lastEntryId: "u1",
        sourceCount: 1,
        sourceEntryIds: ["u1"],
        sourceStartAt: 1,
        sourceEndAt: 1,
        sourceFingerprint: rangeFingerprint([user("u1")]),
        promptVersion: "magic-continuity-v1",
        goal: "legacy goal",
        decisions: [],
        constraints: [],
        facts: [],
        unresolved: [],
        completed: [],
        pending: [],
      },
      { id: "legacy-continuity" },
    );
    await conversation.storage.append(legacy, continuity, user("tail"));
    await conversation.archive(false, { model: {} as never });
    expect((await conversation.storage.read()).find((entry) => entry.id === "legacy")).toEqual(legacy);
    expect((await conversation.storage.read()).find((entry) => entry.id === "legacy-continuity")).toEqual(continuity);
    expect(await conversation.contextRegions()).toEqual([]);
    expect(generateText).not.toHaveBeenCalled();
    const next = await commit(conversation, ["tail"]);
    expect(next.data.lineageId).toBe("old-lineage");
  });
  it("paginates region raw bodies directly and invalidates old proof cursors", async () => {
    const { conversation, path } = await fixture();
    const delivered = speech();
    const call = delivered[0]! as Extract<AgentEntry, { type: "message" }>;
    const toolCall = (call.data.content as { input?: { messages: string[] } }[])[2]!;
    toolCall.input!.messages = ["public".repeat(1500)];
    await conversation.storage.append(...delivered);
    const entry = await commit(conversation, ["call"]);
    const store = new ContextBlockStore(() => conversation.contextSources());
    const first = await store.page({ blockId: entry.id }, 512);
    expect(first.nextCursor).toBeDefined();
    let cursor = first.nextCursor;
    let text = first.records.map((record) => record.text).join("");
    while (cursor) {
      const page = await store.page({ blockId: entry.id, cursor }, 512);
      text += page.records.map((record) => record.text).join("");
      cursor = page.nextCursor;
    }
    expect(text).toBe("public".repeat(1500));
    const entries = await conversation.storage.read();
    await writeFile(
      path(),
      entries
        .filter((candidate) => candidate.id !== "proof")
        .map((candidate) => JSON.stringify(candidate))
        .join("\n") + "\n",
    );
    await expect(store.page({ blockId: entry.id, cursor: first.nextCursor }, 512)).rejects.toThrow("BlockNotAccessible");
  });
  it("validates persisted version/provenance rather than trusting a complete-looking tier object", async () => {
    const { conversation } = await fixture();
    await conversation.storage.append(user("u1"));
    const entry = await commit(conversation, ["u1"]);
    for (const patch of [
      { version: 2 },
      { sourceSession: "../other" },
      { sourceEntryIds: ["u1", "u1"] },
      { sourceFingerprint: "made up" },
      { sourceStartAt: 2, sourceEndAt: 1 },
    ]) {
      expect(() => validateContextRegionData({ ...entry.data, ...patch })).toThrow();
    }
  });
});
