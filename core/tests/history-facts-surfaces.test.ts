import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAssistantMessage, createEntry, createToolMessage, createUserMessage } from "@yesimbot/agent-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), generateText }));
import { ContextBlockStore } from "../src/conversations/context-blocks.js";
import { isDeliveredTranscript } from "../src/conversations/delivered-transcript.js";
import { Conversation } from "../src/conversations/index.js";
import { collectDeliveredSourceRecords, stripInternalAssistantInputs } from "../src/conversations/internal-history.js";

const roots: string[] = [];
const fact = "助手确认订单条件，但并未承诺已经执行。";
function decode(text: string) {
  return JSON.parse(
    text.split("\n")[1]!.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
  ) as Array<{ id: string; messages: string[] }>;
}

function sources(
  compose = true,
  result = { ok: true, count: 2, messageIds: ["p1", "p2"], deliveredMessages: ["真正发送的第一条！！", "真正发送的第二条！！"] } as Record<string, unknown>,
) {
  return [
    createEntry("message", createUserMessage("用户的原始问题？", { id: "u", timestamp: 1 }), { id: "u", timestamp: 1 }),
    createEntry(
      "message",
      createAssistantMessage(
        [
          {
            type: "tool-call",
            toolCallId: "s",
            toolName: "send_message",
            input: compose ? { facts: ["订单结果"], intent: "确认" } : { messages: ["未发送的原稿"] },
            providerOptions: { google: { thoughtSignature: "OLD_SIGNATURE" } },
          },
        ],
        { id: "a", timestamp: 2 },
      ),
      { id: "a", timestamp: 2 },
    ),
    createEntry(
      "message",
      createToolMessage([{ type: "tool-result", toolCallId: "s", toolName: "send_message", output: { type: "json", value: result } }], {
        id: "r",
        timestamp: 3,
      }),
      { id: "r", timestamp: 3 },
    ),
  ];
}

async function fixture(enabled = true, compose = true) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-fact-surfaces-"));
  roots.push(root);
  const conversation = new Conversation(
    root,
    { minMessages: 1, maxFailures: 3, mode: "compartment", assistantAsFacts: enabled },
    { resolveHistoryFactsModel: () => ({ key: "aux:1", model: { id: "aux" } as never }) },
  );
  await conversation.init();
  const entries = sources(compose);
  await conversation.storage.append(...entries);
  const session = conversation.currentSessionId();
  await conversation.storage.append(
    createEntry(
      "compact",
      { summary: "既有摘要", mode: "compartment", compartmentId: "c", lineageId: "c", sourceSession: session, firstEntryId: "u", lastEntryId: "a" },
      { id: "c", timestamp: 4 },
    ),
  );
  return { root, conversation, entries, path: join(root, "sessions", session + ".jsonl") };
}
beforeEach(() => {
  generateText.mockImplementation(async (input) =>
    input.model.id === "aux"
      ? { text: JSON.stringify({ records: decode(input.prompt).map(({ id }) => ({ id, facts: [fact] })) }), finishReason: "stop" }
      : { text: "新的客观摘要", finishReason: "stop" },
  );
});
afterEach(async () => {
  generateText.mockReset();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("actual delivered history", () => {
  it.each([true, false])("projects actual bodies rather than a draft in native/default mode (compose=%s)", (compose) => {
    const entries = sources(compose);
    const before = JSON.stringify(entries);
    for (const mode of ["default", "gemini-native"] as const) {
      const text = JSON.stringify(stripInternalAssistantInputs(entries, mode));
      expect(text).toContain("真正发送的第一条");
      expect(text).toContain("真正发送的第二条");
      expect(text).not.toContain("未发送的原稿");
      expect(text).not.toContain("OLD_SIGNATURE");
      expect(text).not.toContain('"toolName":"send_message"');
    }
    expect(JSON.stringify(entries)).toBe(before);
  });
  it("uses completed generated prefix on partial sends, not draft length or platform segment count", () => {
    const records = collectDeliveredSourceRecords(sources(false, { ok: false, failedAt: 2, sent: ["p1", "p2", "p3"], deliveredMessages: ["一", "二"] }));
    expect(records.get("a")?.map((record) => record.text)).toEqual(["一", "二"]);
  });
  it.each([
    { ok: true, count: 2, messageIds: ["p1", "p2"], deliveredMessages: ["一"] },
    { ok: true, count: 1, messageIds: ["p1"], deliveredMessages: [42] },
    { ok: true, count: 1, messageIds: [], deliveredMessages: ["一"] },
    { ok: true, count: 1, deliveredMessages: ["一"] },
    { ok: true, count: 1, messageIds: [""], deliveredMessages: ["一"] },
    { ok: true, count: 1, messageIds: [42], deliveredMessages: ["一"] },
    { ok: false, failedAt: 2, sent: ["p1"], deliveredMessages: ["一", "二"] },
    { ok: false, failedAt: 0, sent: ["segment1"], deliveredMessages: [] },
  ])("fails closed for invalid actual-body proof without rescuing a draft", (result) => {
    const entries = sources(false, result);
    expect(collectDeliveredSourceRecords(entries).size).toBe(0);
    for (const mode of ["default", "gemini-native"] as const) {
      const projected = stripInternalAssistantInputs(entries, mode);
      expect(projected.some((entry) => entry.type === "message" && isDeliveredTranscript(entry.data))).toBe(false);
      expect(JSON.stringify(projected)).not.toContain("未发送的原稿");
    }
  });
  it.each(["reversed", "duplicate-call", "duplicate-result"])("rejects ambiguous actual-body pairing in every renderer (%s)", (kind) => {
    const canonical = sources(false);
    const entries =
      kind === "reversed"
        ? [canonical[0]!, canonical[2]!, canonical[1]!]
        : [...canonical, { ...canonical[kind === "duplicate-call" ? 1 : 2]!, id: "duplicate" }];
    const before = JSON.stringify(entries);
    expect(collectDeliveredSourceRecords(entries).size).toBe(0);
    for (const mode of ["default", "gemini-native"] as const) {
      const projected = stripInternalAssistantInputs(entries, mode);
      expect(projected.some((entry) => entry.type === "message" && isDeliveredTranscript(entry.data))).toBe(false);
      expect(JSON.stringify(projected)).not.toMatch(/真正发送|未发送的原稿|OLD_SIGNATURE/);
    }
    expect(JSON.stringify(entries)).toBe(before);
  });
});

describe("objective source surfaces", () => {
  it("neutralizes the whole verified record before legacy pagination and preserves every JSONL byte", async () => {
    const f = await fixture();
    const before = await readFile(f.path);
    const first = await f.conversation.expandCompartment("c", { limit: 1 });
    expect(first.entries[0]?.text).toBe("用户的原始问题？");
    expect(first.nextOffset).toBe(1);
    expect(first.total).toBe(2);
    const next = await f.conversation.expandCompartment("c", { offset: 1, limit: 1 });
    expect(next.entries[0]?.text).toContain(fact);
    expect(JSON.stringify(next)).not.toMatch(/真正发送|OLD_SIGNATURE|订单结果/);
    expect(generateText).toHaveBeenCalledOnce();
    expect(decode(generateText.mock.calls[0]![0].prompt)[0]?.messages).toHaveLength(2);
    expect(await readFile(f.path)).toEqual(before);
  });
  it("shares canonical facts cache across history, expansion and frozen historian input", async () => {
    const f = await fixture();
    await f.conversation.historyFacts!.projectEntries(f.entries);
    await f.conversation.expandCompartment("c");
    const frozen = await f.conversation.freezeContextRegion(["u", "a"]);
    const records = await f.conversation.projectFrozenAssistantRecords(frozen);
    expect(records[1]?.text).toContain(fact);
    expect(generateText).toHaveBeenCalledOnce();
  });
  it("uses metadata only in expansion when auxiliary extraction fails", async () => {
    const f = await fixture();
    generateText.mockRejectedValue(new Error("aux unavailable"));
    const result = await f.conversation.expandCompartment("c");
    expect(JSON.stringify(result)).toContain("客观正文暂不可用");
    expect(JSON.stringify(result)).not.toContain("真正发送");
  });
  it("rejects a cancelled legacy expansion even if its model ignores abort", async () => {
    const f = await fixture();
    generateText.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = f.conversation.expandCompartment("c", { signal: controller.signal });
    const outcome = pending.then(
      () => "unexpected success",
      (error: Error) => error.message,
    );
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledOnce());
    controller.abort();
    await expect(outcome).resolves.toBe("CancelledContextRead");
  });
  it("rejects a late legacy expansion after switching the storage generation", async () => {
    const f = await fixture();
    let release!: (value: unknown) => void;
    generateText.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.conversation.expandCompartment("c");
    const outcome = pending.then(
      () => "unexpected success",
      (error: Error) => error.message,
    );
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledOnce());
    await f.conversation.archive(true);
    release({ text: "{}", finishReason: "stop" });
    await expect(outcome).resolves.toBe("StaleContextRead");
  });
  it("binds factual Magic cursors/cache to canonical proof even when the body stays the same", async () => {
    const f = await fixture();
    let entries = [...(await f.conversation.storage.read())];
    const snapshot = await f.conversation.contextSources();
    const facts = f.conversation.historyFacts!;
    generateText.mockImplementation(async (input) => ({
      text: JSON.stringify({ records: decode(input.prompt).map(({ id }) => ({ id, facts: ["助手确认" + "订单".repeat(60)] })) }),
      finishReason: "stop",
    }));
    const store = new ContextBlockStore(
      async () => ({ ...snapshot, entries, readSession: async () => entries }),
      (records, canonical, signal) => facts.projectRecords(records, signal, facts.proofsForEntries(canonical)),
    );
    const page = await store.page({ blockId: "c" }, 512);
    expect(page.nextCursor).toBeDefined();
    expect(JSON.stringify(page)).not.toContain("真正发送");
    entries = entries.map((entry) =>
      entry.id === "r"
        ? sources(true, { ok: true, count: 2, messageIds: ["changed1", "changed2"], deliveredMessages: ["真正发送的第一条！！", "真正发送的第二条！！"] })[2]!
        : entry,
    );
    await expect(store.page({ blockId: "c", cursor: page.nextCursor }, 512)).rejects.toThrow("InvalidCursor");
    expect(generateText).toHaveBeenCalledTimes(2);
  });
  it("cancels factual Magic paging without issuing an old source page", async () => {
    const f = await fixture();
    const facts = f.conversation.historyFacts!;
    generateText.mockImplementation(() => new Promise(() => {}));
    const store = new ContextBlockStore(
      () => f.conversation.contextSources(),
      (records, canonical, signal) => facts.projectRecords(records, signal, facts.proofsForEntries(canonical)),
    );
    const controller = new AbortController();
    const pending = store.page({ blockId: "c" }, 4096, new Set(), controller.signal);
    const outcome = pending.then(
      () => "unexpected success",
      (error: Error) => error.message,
    );
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledOnce());
    controller.abort();
    await expect(outcome).resolves.toBe("CancelledContextRead");
  });
  it.each([true, false])("continuity input preserves the disabled source and neutralizes enabled speech (%s)", async (enabled) => {
    const f = await fixture(enabled, false);
    const continuity = { goal: "订单核对", decisions: [], constraints: [], facts: ["订单条件已确认"], unresolved: [], completed: [], pending: [] };
    generateText.mockImplementation(async (input) =>
      input.model.id === "aux"
        ? { text: JSON.stringify({ records: decode(input.prompt).map(({ id }) => ({ id, facts: [fact] })) }), finishReason: "stop" }
        : { text: JSON.stringify(continuity), finishReason: "stop" },
    );
    await f.conversation.ensureContinuity({ sourceEntryIds: ["u", "a"], model: { id: "continuity" } as never });
    const request = generateText.mock.calls.find(([input]) => input.model.id === "continuity")![0];
    expect(request.prompt).not.toContain("未发送的原稿");
    expect(request.prompt).toContain(enabled ? fact : "真正发送的第一条");
    if (enabled) expect(request.prompt).not.toContain("真正发送");
  });
  it.each([true, false])("new summary input uses factual extraction or actual bodies, never a draft (enabled=%s)", async (enabled) => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-compact-facts-"));
    roots.push(root);
    const c = new Conversation(
      root,
      { minMessages: 1, maxFailures: 3, mode: "summary", assistantAsFacts: enabled },
      { resolveHistoryFactsModel: () => ({ key: "aux", model: { id: "aux" } as never }) },
    );
    await c.init();
    await c.storage.append(...sources(false));
    expect(await c.compact("manual", { model: { id: "compact" } as never })).toMatchObject({ compacted: true });
    const request = generateText.mock.calls.find(([input]) => input.model.id === "compact")![0];
    expect(request.prompt).not.toContain("未发送的原稿");
    expect(request.prompt).toContain(enabled ? fact : "真正发送的第一条");
    if (enabled) expect(request.prompt).not.toContain("真正发送");
  });
});
