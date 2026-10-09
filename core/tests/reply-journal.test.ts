import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEntry, type AgentEntry, type AgentStorage } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("../src/agents/tools.js", async (original) => ({ ...(await original<object>()), pacedDelay: () => 0 }));

import { ReplyCoordinator } from "../src/agents/reply.js";
import { Conversation } from "../src/conversations/index.js";
import { beginReplyJournal, type ReplyJournalSink } from "../src/conversations/reply-journal.js";
import { reduceReplyJournal, resolveReplyHistory, type ReplyDeliveryProofData } from "../src/conversations/reply-receipt.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
const start = {
  phaseId: "phase",
  turnId: "turn",
  toolCallId: "send",
  channelId: "room",
  expectedUnits: [{ kind: "text" as const, segments: 1 }],
  inputFingerprint: "fingerprint",
  invocationId: "invocation",
};
const checkpoint = { sequence: 1, unitIndex: 0, unitKind: "text" as const, segmentIndex: 0, messageIds: ["platform"], unitText: "actual" };
async function conversationFixture() {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-proof-writes-"));
  roots.push(root);
  const conversation = new Conversation(root);
  await conversation.init();
  return conversation;
}

function deliveryFixture(blockKind: "start" | "checkpoint" | "close") {
  const entries: AgentEntry[] = [];
  const raw = deferred<void>();
  const writes = new Set<Promise<void>>();
  let number = 0;
  const sink: ReplyJournalSink = {
    append: vi.fn(async (entry) => {
      const data = entry.type === "message" && entry.data.role === "custom" ? (entry.data.data as ReplyDeliveryProofData) : undefined;
      if (data?.kind === blockKind && (data.kind !== "checkpoint" || data.unitIndex === 1)) await raw.promise;
      entries.push(entry);
    }),
  };
  const sendMessage = vi.fn(async () => [`platform-${++number}`]);
  const coordinator = new ReplyCoordinator({
    bot: { platform: "test", sendMessage } as never,
    channelId: "room",
    resources: {} as never,
    pacing: { charactersPerSecond: 100, maxTotalDelayMs: 0 },
    journal: {
      begin: (input) =>
        beginReplyJournal({
          ...input,
          sink,
          sessionId: "session",
          generation: 1,
          invocationId: "invocation",
          writeTimeoutMs: 25,
          onWrite: (task) => {
            writes.add(task);
            void task.then(
              () => writes.delete(task),
              () => writes.delete(task),
            );
          },
        }),
    },
  });
  return {
    entries,
    sink,
    raw,
    writes,
    sendMessage,
    coordinator,
    sending: coordinator.deliver({
      parts: [
        { kind: "text", text: "first" },
        { kind: "text", text: "second" },
        { kind: "text", text: "never after failure" },
      ],
      turnId: "turn",
      toolCallId: "send",
      messages: [],
      allowed: true,
    }),
  };
}

describe("bounded local delivery proof writes", () => {
  it("an ignored admission append expires with zero transport and no unlimited owned work", async () => {
    const f = deliveryFixture("start");
    expect((await f.sending).output).toMatchObject({ ok: false, error: { name: "delivery_proof_persist_failed" } });
    await f.coordinator.settle();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.writes.size).toBe(0);
    f.raw.resolve();
    await vi.waitFor(() => expect(f.entries).toHaveLength(1));
    expect(resolveReplyHistory(f.entries).records.size).toBe(0);
  });
  it("an unresolved checkpoint poisons its sequence: no close, retry or later platform output", async () => {
    const f = deliveryFixture("checkpoint");
    const result = await f.sending;
    await f.coordinator.settle();
    expect(result.output).toMatchObject({ ok: false, sent: ["platform-1", "platform-2"], warning: "delivery_proof_persist_failed" });
    expect(result.receipt).toMatchObject({ proofSequence: 1, completeUnits: [{ text: "first" }] });
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
    expect(f.writes.size).toBe(0);
    expect(f.entries).toHaveLength(2);
    f.raw.resolve();
    await vi.waitFor(() => expect(f.entries).toHaveLength(3));
    expect(reduceReplyJournal(f.entries).invalid.size).toBe(0);
    expect([...resolveReplyHistory(f.entries).records.values()].flat().map((record) => record.text)).toEqual(["first", "second"]);
    expect(f.sink.append).toHaveBeenCalledTimes(3);
  });
  it("an ignored close settles locally without claiming completion or duplicating a sequence", async () => {
    const f = deliveryFixture("close");
    const result = await f.sending;
    await f.coordinator.settle();
    expect(result.output.ok).toBe(false);
    expect(result.receipt).toMatchObject({ status: "failed", proofSequence: 3, failedUnitIndex: 3 });
    expect(f.writes.size).toBe(0);
    f.raw.resolve();
    await vi.waitFor(() => expect(f.entries).toHaveLength(5));
    expect([...reduceReplyJournal(f.entries).journals.values()][0]?.status).toBe("complete");
    expect(f.sendMessage).toHaveBeenCalledTimes(3);
  });
  it("a queued expired admission never starts later when an earlier disk operation unblocks", async () => {
    const conversation = await conversationFixture();
    const storage = Reflect.get(conversation, "fileStorageValue") as AgentStorage<AgentEntry>;
    const append = storage.append.bind(storage);
    const blocked = deferred<void>();
    vi.spyOn(storage, "append").mockImplementationOnce(async (...entries) => {
      await blocked.promise;
      await append(...entries);
    });
    const before = createEntry("message", { id: "user", role: "user", content: "existing", timestamp: 1 }, { id: "user" });
    const pending = conversation.storage.append(before);
    expect(
      await beginReplyJournal({
        ...start,
        sink: conversation.replyProofSink(),
        sessionId: conversation.currentSessionId(),
        generation: conversation.storageGeneration,
        writeTimeoutMs: 25,
      }),
    ).toBeUndefined();
    blocked.resolve();
    await pending;
    expect((await conversation.storage.read()).map((entry) => entry.id)).toEqual(["user"]);
  });
  it.each(["clear", "archive", "switch-back"] as const)("observations cannot repopulate replacement history after %s", async (operation) => {
    const conversation = await conversationFixture();
    const sessionId = conversation.currentSessionId();
    const writer = await beginReplyJournal({ ...start, sink: conversation.replyProofSink(), sessionId, generation: conversation.storageGeneration });
    expect(writer).toBeDefined();
    if (operation === "clear") await conversation.storage.clear();
    else {
      await conversation.archive(true);
      if (operation === "switch-back") await conversation.switch(sessionId);
    }
    await expect(writer!.checkpoint(checkpoint)).rejects.toThrow("ReplyProofGenerationChanged");
    const entries = await conversation.storage.read();
    expect(entries).toHaveLength(operation === "switch-back" ? 1 : 0);
    expect(resolveReplyHistory(entries).records.size).toBe(0);
  });
  it("late IDs still notify actual effects, but their old-generation proof cannot append", async () => {
    const conversation = await conversationFixture();
    const writer = await beginReplyJournal({
      ...start,
      sink: conversation.replyProofSink(),
      sessionId: conversation.currentSessionId(),
      generation: conversation.storageGeneration,
    });
    await writer!.close({ sequence: 1, status: "failed", failureStage: "delivery", failedUnitIndex: 0, uncertainTransport: "text" });
    const raw = deferred<readonly string[] | undefined>();
    const onObserved = vi.fn();
    const onWarn = vi.fn();
    writer!.observeLate({ ...checkpoint, ids: raw.promise, onObserved, onWarn });
    await conversation.storage.clear();
    raw.resolve(["late-platform"]);
    await vi.waitFor(() => expect(onWarn).toHaveBeenCalledWith("reply_delivery_late_observation_failed"));
    expect(onObserved).toHaveBeenCalledWith(["late-platform"]);
    expect(await conversation.storage.read()).toEqual([]);
  });
});
