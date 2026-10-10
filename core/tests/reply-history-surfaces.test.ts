import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAssistantMessage, createEntry, createMessageEntry, createToolMessage, type AgentEntry } from "@yesimbot/agent-runtime";
import { h, Universal } from "koishi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.hoisted(() => vi.fn());
vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), generateText }));

import { ContextBlockStore, contextRegionSource, safeSourceRecords } from "../src/conversations/context-blocks.js";
import { isDeliveredTranscript } from "../src/conversations/delivered-transcript.js";
import { Conversation } from "../src/conversations/index.js";
import { collectAssistantSourceProofs, stripInternalAssistantInputs } from "../src/conversations/internal-history.js";
import {
  createCompleteReceipt,
  createReplyDeliveryProofMessage,
  isReplyDeliveryProof,
  resolveReplyHistory,
  type ReplyDeliveryProofData,
} from "../src/conversations/reply-receipt.js";
import { createMessage } from "../src/messages/index.js";

const roots: string[] = [];
const firstBody = "已确认的第一条";
const secondBody = "已确认的第二条";
const regionDraft = { importance: 0.5, tiers: { P1: "已确认的历史输出与条件", P2: "确认历史条件", P3: "已确认", P4: "确认" } };

function proof(id: string, data: ReplyDeliveryProofData): AgentEntry {
  return createMessageEntry(createReplyDeliveryProofMessage(data, { id, timestamp: data.timestamp }), { id, timestamp: data.timestamp });
}

function phase(sessionId = "session", bodies = [firstBody, secondBody]): AgentEntry[] {
  const units = bodies.map((text, index) => ({ index, kind: "text" as const, text, segmentMessageIds: [[`platform-${index}`]] }));
  const receipt = createCompleteReceipt({ phaseId: "phase", units, proof: { invocationId: "invocation", sequence: 3 } });
  return [
    createMessageEntry(
      createAssistantMessage(
        [
          {
            type: "tool-call",
            toolCallId: "send",
            toolName: "send_message",
            input: { parts: [{ kind: "text", text: "PRIVATE untrusted plan" }] },
            providerOptions: { google: { thoughtSignature: "SIGNED" } },
          },
        ],
        { id: "call-message", timestamp: 10 },
      ),
      { id: "call", timestamp: 10 },
    ),
    proof("start", {
      version: 1,
      kind: "start",
      invocationId: "invocation",
      phaseId: "phase",
      toolCallId: "send",
      turnId: "turn",
      channelId: "room",
      sessionId,
      generation: 1,
      inputFingerprint: "fingerprint",
      expectedUnits: [
        { kind: "text", segments: 1 },
        { kind: "text", segments: 1 },
      ],
      timestamp: 50,
    }),
    ...bodies.map((unitText, unitIndex) =>
      proof(`checkpoint-${unitIndex}`, {
        version: 1,
        kind: "checkpoint",
        invocationId: "invocation",
        turnId: "turn",
        sequence: unitIndex + 1,
        unitIndex,
        unitKind: "text",
        segmentIndex: 0,
        messageIds: [`platform-${unitIndex}`],
        unitText,
        timestamp: 100 + unitIndex * 100,
      }),
    ),
    proof("close", { version: 1, kind: "close", invocationId: "invocation", turnId: "turn", sequence: 3, status: "complete", timestamp: 300 }),
    createMessageEntry(
      createToolMessage(
        [
          {
            type: "tool-result",
            toolCallId: "send",
            toolName: "send_message",
            output: { type: "text", value: JSON.stringify({ ok: true, replyReceipt: receipt }) },
          },
        ],
        { id: "result-message", timestamp: 400 },
      ),
      { id: "result", timestamp: 400 },
    ),
  ];
}

async function fixture(factual = false, magicContext = true) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-reply-source-"));
  roots.push(root);
  const conversation = new Conversation(
    root,
    { minMessages: 1, maxFailures: 3, mode: "compartment", assistantAsFacts: factual, chunkMessages: 1 },
    { magicContext },
  );
  await conversation.init();
  const entries = phase(conversation.currentSessionId());
  await conversation.storage.append(...entries);
  const compact = createEntry(
    "compact",
    {
      summary: "既有摘要",
      compartmentId: "compact",
      mode: "compartment",
      firstEntryId: "checkpoint-0",
      lastEntryId: "checkpoint-0",
      sourceSession: conversation.currentSessionId(),
      lineageId: "compact",
    },
    { id: "compact", timestamp: 500 },
  );
  await conversation.storage.append(compact);
  return { conversation, entries, root, path: join(root, "sessions", conversation.currentSessionId() + ".jsonl") };
}

beforeEach(() => {
  // Only the continuity model may run; no auxiliary per-message extraction route remains.
  generateText.mockImplementation(async () => ({
    text: JSON.stringify({ goal: "核对历史条件", decisions: [], constraints: [], facts: ["已确认历史条件"], unresolved: [], completed: [], pending: [] }),
    finishReason: "stop",
  }));
});
afterEach(async () => {
  generateText.mockReset();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical mixed reply history source", () => {
  it("resolves a checkpoint-only range to its whole invocation with real observation times", () => {
    const entries = phase();
    const source = contextRegionSource(entries, ["checkpoint-0"]);
    expect(source.sourceEntryIds).toEqual(entries.map((entry) => entry.id));
    expect(source.records.map((record) => [record.text, record.timestamp])).toEqual([
      [firstBody, 100],
      [secondBody, 200],
    ]);
    expect([source.sourceStartAt, source.sourceEndAt]).toEqual([100, 200]);
    expect(safeSourceRecords(entries, ["result"])).toEqual(source.records);
    expect(JSON.stringify(source)).not.toMatch(/PRIVATE|SIGNED/);
  });
  it.each(["default", "gemini-native"] as const)("projects each proven unit once, preserving time and partial state in %s history", (mode) => {
    const entries = phase();
    const before = JSON.stringify(entries);
    const projected = stripInternalAssistantInputs(entries, mode);
    const transcripts = projected.flatMap((entry) => (entry.type === "message" && isDeliveredTranscript(entry.data) ? [entry.data] : []));
    expect(transcripts.map((message) => [message.data.messages, message.timestamp, message.data.partial])).toEqual([
      [[firstBody], 100, false],
      [[secondBody], 200, false],
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE|SIGNED|reply-delivery-proof|replyReceipt/);
    expect(JSON.stringify(entries)).toBe(before);
    const open = stripInternalAssistantInputs(entries.slice(1, 3), mode);
    expect(open.flatMap((entry) => (entry.type === "message" && isDeliveredTranscript(entry.data) ? [entry.data.data.partial] : []))).toEqual([true]);
  });
  it.each([false, true])("shares full canonical proof across expansion and frozen regions without extraction (facts=%s)", async (factual) => {
    const f = await fixture(factual);
    const before = await readFile(f.path);
    const expanded = await f.conversation.expandCompartment("compact");
    // Legacy assistantAsFacts parsing must not start an auxiliary per-message extractor.
    expect(expanded.entries.map((record) => record.text)).toEqual([firstBody, secondBody]);
    expect(JSON.stringify(expanded)).not.toMatch(/PRIVATE|SIGNED/);
    const frozen = await f.conversation.freezeContextRegion(["checkpoint-0"]);
    expect(frozen.sourceEntryIds).toEqual(f.entries.map((entry) => entry.id));
    expect([frozen.sourceStartAt, frozen.sourceEndAt]).toEqual([100, 200]);
    expect(frozen.records.map((record) => record.text)).toEqual([firstBody, secondBody]);
    expect(generateText).not.toHaveBeenCalled();
    expect(await readFile(f.path)).toEqual(before);
  });
  it.each([1, 999])("a fresh Conversation reads a persisted journal-only prefix fail-closed (version=%s)", async (version) => {
    const f = await fixture();
    const prefix = structuredClone(f.entries.slice(1, 3)); // Admission plus one real unit; no SDK pair/close.
    if (version !== 1) {
      const checkpoint = prefix[1];
      if (checkpoint?.type !== "message" || !isReplyDeliveryProof(checkpoint.data)) throw new Error("missing fixture checkpoint");
      Reflect.set(checkpoint.data.data, "version", version);
    }
    await f.conversation.storage.clear();
    await f.conversation.storage.append(...prefix);
    const before = await readFile(f.path);
    const restarted = new Conversation(f.root);
    await restarted.init();
    expect(restarted.currentSessionId()).toBe(f.conversation.currentSessionId());
    const entries = await restarted.storage.read();
    expect(safeSourceRecords(entries).map((record) => record.text)).toEqual(version === 1 ? [firstBody] : []);
    expect(JSON.stringify(stripInternalAssistantInputs(entries, "default", undefined, "next-turn"))).not.toMatch(
      /PRIVATE|SIGNED|reply-delivery-proof|replyReceipt/,
    );
    expect(generateText).not.toHaveBeenCalled();
    expect(await readFile(f.path)).toEqual(before);
  });
  it("pages a partial selected range with all proof provenance and rejects any active proof partner", async () => {
    const f = await fixture();
    const store = new ContextBlockStore(() => f.conversation.contextSources());
    const page = await store.page({ blockId: "compact", limit: 1 }, 4096);
    expect(page.records.map((record) => record.text)).toEqual([firstBody]);
    expect(page.sourceEntryIds).toEqual(f.entries.map((entry) => entry.id));
    await expect(store.page({ blockId: "compact" }, 4096, new Set(["result"]))).rejects.toThrow("ActiveTurnSource");
  });
  it.each(["ids", "malformed", "unknown", "missing-start", "conflicting-mirror"])(
    "binds cursors and owner hashes to evidence outside the selected range (%s)",
    async (mutation) => {
      let entries = phase();
      const compact = createEntry(
        "compact",
        { summary: "old", compartmentId: "compact", firstEntryId: "checkpoint-0", lastEntryId: "checkpoint-0", sourceSession: "session", lineageId: "compact" },
        { id: "compact" },
      );
      const store = new ContextBlockStore(async () => ({
        sessionId: "session",
        entries: [...entries, compact],
        compacts: [compact],
        sessionIds: ["session"],
        readSession: async () => entries,
      }));
      const page = await store.page({ blockId: "compact", limit: 1 }, 4096);
      expect(page.nextCursor).toBeDefined();
      const hash = collectAssistantSourceProofs(entries).get("checkpoint-0");
      entries = structuredClone(entries);
      const changed = entries[3] as { data: { data: Record<string, unknown> } };
      if (mutation === "ids") changed.data.data.messageIds = ["changed"];
      if (mutation === "malformed") changed.data.data.extra = "invalid";
      if (mutation === "unknown") changed.data.data.version = 999;
      if (mutation === "missing-start") entries = entries.filter((entry) => entry.id !== "start");
      if (mutation === "conflicting-mirror") {
        const mirror = entries.at(-1);
        if (mirror?.type !== "message" || mirror.data.role !== "tool") throw new Error("missing fixture mirror");
        const part = mirror.data.content[0];
        if (part?.type !== "tool-result" || part.output.type !== "text") throw new Error("missing fixture result");
        const output = JSON.parse(part.output.value) as { replyReceipt: { completeUnits: Array<{ text: string }> } };
        output.replyReceipt.completeUnits[1]!.text = "forged";
        part.output.value = JSON.stringify(output);
      }
      expect(collectAssistantSourceProofs(entries).get("checkpoint-0")).not.toBe(hash);
      expect(resolveReplyHistory(entries).records.size).toBe(0);
      await expect(store.page({ blockId: "compact", cursor: page.nextCursor }, 4096)).rejects.toThrow("InvalidCursor");
    },
  );
  it("invalidates a frozen source after a later observation/edited proof outside its requested IDs", async () => {
    const f = await fixture();
    const frozen = await f.conversation.freezeContextRegion(["checkpoint-0"]);
    const altered = structuredClone(f.entries);
    (altered[3] as { data: { data: { messageIds: string[] } } }).data.data.messageIds = ["edited"];
    // Replace only in this temporary fixture, never mutate repository or production JSONL.
    await f.conversation.storage.clear();
    await f.conversation.storage.append(...altered);
    await expect(f.conversation.commitContextRegion(frozen, regionDraft)).rejects.toThrow("StaleContextRegion");
  });
  it("Magic archive retains or removes a complete journal unit, never an isolated checkpoint", async () => {
    const f = await fixture();
    // This fixture's old compact covers a single checkpoint; whole modern source must be removed
    // together, with the original session still available for explicit expansion.
    const sourceSession = f.conversation.currentSessionId();
    await f.conversation.archive(false);
    const active = await f.conversation.storage.read();
    expect(active.filter((entry) => f.entries.some((source) => source.id === entry.id))).toEqual([]);
    expect(f.conversation.currentSessionId()).not.toBe(sourceSession);
    expect((await f.conversation.expandCompartment("compact")).entries.map((record) => record.text)).toEqual([firstBody, secondBody]);
  });
  it("legacy archive carries a tail invocation including its admission before the compact boundary", async () => {
    const f = await fixture(false, false);
    await f.conversation.archive(false, { model: {} as never, force: true, excludeMessageIds: ["close"] });
    const active = await f.conversation.storage.read();
    expect(active.filter((entry) => f.entries.some((source) => source.id === entry.id)).map((entry) => entry.id)).toEqual(f.entries.map((entry) => entry.id));
    expect(safeSourceRecords(active).map((record) => record.text)).toEqual([firstBody, secondBody]);
  });
  it.each([
    { mode: "summary" as const, assistantAsFacts: false },
    { mode: "summary" as const, assistantAsFacts: true },
    { mode: "compartment" as const, assistantAsFacts: false },
    { mode: "compartment" as const, assistantAsFacts: true },
  ])("keeps actual bodies and old compression behavior with $mode / assistantAsFacts=$assistantAsFacts", async ({ mode, assistantAsFacts }) => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-reply-compact-"));
    roots.push(root);
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3, mode, assistantAsFacts, chunkMessages: 100 });
    await conversation.init();
    const user = createMessageEntry(
      createMessage({
        platform: "test",
        selfId: "bot",
        channel: { id: "room", type: Universal.Channel.Type.TEXT },
        user: { id: "user", name: "Alice" },
        timestamp: 1,
        messageId: "user-message",
        elements: [h.text("public user fact")],
      }),
      { id: "user-entry", timestamp: 1 },
    );
    await conversation.storage.append(user, ...phase(conversation.currentSessionId()));
    const path = join(root, "sessions", conversation.currentSessionId() + ".jsonl");
    const before = await readFile(path);
    const model = { id: "ordinary-compact" } as never;
    expect(await conversation.compact("manual", { model, force: true })).toMatchObject({ compacted: true });
    expect(generateText).toHaveBeenCalledOnce();
    const request = generateText.mock.calls[0]![0];
    expect(request.model).toBe(model);
    expect(request.prompt).toContain("public user fact");
    expect(request.prompt).not.toMatch(/PRIVATE|SIGNED/);
    if (mode === "summary" || assistantAsFacts) {
      expect(request.prompt).toContain(firstBody);
      expect(request.prompt).toContain(secondBody);
      if (assistantAsFacts) expect(request.prompt).toContain("assistant 曾输出原文");
    } else {
      expect(request.prompt).not.toContain(firstBody);
      expect(request.prompt).not.toContain(secondBody);
    }
    const compact = (await conversation.storage.read()).find((entry) => entry.type === "compact");
    if (!compact) throw new Error("missing compact fixture");
    const expanded = await conversation.expandCompartment(compact.id);
    expect(expanded.entries.map((record) => record.text)).toEqual(["public user fact", firstBody, secondBody]);
    expect(generateText).toHaveBeenCalledOnce();
    expect((await readFile(path)).subarray(0, before.length)).toEqual(before);
  });
  it.each([false, true])("continuity keeps actual bodies without extraction (assistantAsFacts=%s)", async (assistantAsFacts) => {
    const f = await fixture(assistantAsFacts);
    const result = await f.conversation.ensureContinuity({ model: {} as never, sourceEntryIds: ["checkpoint-0"] });
    expect(result.entry.data.sourceEntryIds).toEqual(f.entries.map((entry) => entry.id));
    expect([result.entry.data.sourceStartAt, result.entry.data.sourceEndAt]).toEqual([100, 200]);
    expect(generateText).toHaveBeenCalledOnce();
    expect(generateText.mock.calls[0]![0].prompt).toContain(firstBody);
    expect(generateText.mock.calls[0]![0].prompt).toContain(secondBody);
    expect(JSON.stringify(generateText.mock.calls[0])).not.toMatch(/PRIVATE|SIGNED/);
    expect((await f.conversation.ensureContinuity({ model: {} as never, sourceEntryIds: ["result"] })).reused).toBe(true);
    expect(generateText).toHaveBeenCalledOnce();
  });
  it("a shared SDK entry joins multiple invocation groups transitively without duplicating owners", () => {
    const first = phase();
    const rename = (value: string) =>
      value
        .replaceAll('"invocation"', '"second-invocation"')
        .replaceAll('"phase"', '"second-phase"')
        .replaceAll("platform-", "second-platform-")
        .replaceAll('"send"', '"second-send"');
    const second = JSON.parse(rename(JSON.stringify(phase()))) as AgentEntry[];
    second.forEach((entry) => {
      entry.id = `second-${entry.id}`;
      // Text-form SDK output contains nested serialized JSON, so rename its fixture IDs too.
      if (entry.type === "message" && entry.data.role === "tool")
        for (const part of entry.data.content)
          if (part.type === "tool-result" && part.output.type === "text")
            part.output.value = part.output.value.replaceAll('"invocation"', '"second-invocation"').replaceAll('"phase"', '"second-phase"');
    });
    const call = first[0] as Extract<AgentEntry, { type: "message" }>;
    const otherCall = second[0] as Extract<AgentEntry, { type: "message" }>;
    if (call.data.role !== "assistant" || otherCall.data.role !== "assistant" || !Array.isArray(call.data.content) || !Array.isArray(otherCall.data.content))
      throw new Error("fixture");
    const shared = { ...call, data: { ...call.data, content: [...call.data.content, ...otherCall.data.content] } };
    const entries = [shared, ...first.slice(1), ...second.slice(1)];
    const modern = resolveReplyHistory(entries);
    expect(modern.records.size).toBe(2);
    expect(modern.groups.get("checkpoint-0")).toEqual(entries.map((entry) => entry.id));
    expect(safeSourceRecords(entries, ["second-checkpoint-0"])).toHaveLength(4);
  });
});
