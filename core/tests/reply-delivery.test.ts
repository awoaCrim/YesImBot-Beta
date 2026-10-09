import { createAssistantMessage, createMessageEntry, createToolMessage, type AgentEntry } from "@yesimbot/agent-runtime";
import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("../src/agents/tools.js", async (original) => ({ ...(await original<object>()), pacedDelay: () => 0 }));

import { normalizeReplyParts, preflightReplyPhase, projectDeliveredText, ReplyCoordinator, type ReplyStickerProvider } from "../src/agents/reply.js";
import { beginReplyJournal, type ReplyJournalWriter } from "../src/conversations/reply-journal.js";
import {
  createPreflightFailureReceipt,
  decodeReplyReceipt,
  reduceReplyJournal,
  resolveReplyHistory,
  type ReplyDeliveryProofData,
} from "../src/conversations/reply-receipt.js";
import type { ChannelResources } from "../src/resources/index.js";
import { PNG_BYTES } from "./helpers/index.js";

const hash = "a".repeat(64);
const resources = { open: vi.fn(async () => ({ bytes: PNG_BYTES, mediaType: "image/png" })) } as unknown as ChannelResources;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  options: {
    sticker?: ReplyStickerProvider;
    send?: (channel: string, elements: unknown[]) => Promise<unknown>;
    fail?: (data: ReplyDeliveryProofData) => boolean;
    onDelivered?: () => void;
  } = {},
) {
  const entries: AgentEntry[] = [];
  let invocations = 0;
  let sends = 0;
  const sink = {
    append: vi.fn(async (entry: AgentEntry) => {
      const data = entry.type === "message" && entry.data.role === "custom" ? (entry.data.data as ReplyDeliveryProofData) : undefined;
      if (data && options.fail?.(data)) throw new Error("disk unavailable");
      entries.push(entry);
    }),
  };
  const journal: ReplyJournalWriter = {
    begin: (input) => beginReplyJournal({ ...input, sink, sessionId: "session", generation: 1, invocationId: `invocation-${++invocations}` }),
  };
  const sendMessage = vi.fn(options.send ?? (async () => [`text-${++sends}`]));
  const onDelivered = vi.fn(options.onDelivered);
  const coordinator = new ReplyCoordinator({
    bot: { platform: "onebot", sendMessage } as never,
    channelId: "42",
    resources,
    pacing: { charactersPerSecond: 100, maxTotalDelayMs: 0 },
    journal,
    sticker: options.sticker,
    onDelivered,
  });
  const send = (parts: unknown, extra: object = {}) =>
    coordinator.deliver({ parts, turnId: "turn", toolCallId: "send-call", messages: [], allowed: true, ...extra });
  return { entries, coordinator, send, sendMessage, onDelivered, sink };
}

function stickerProvider(events: string[] = []) {
  const release = vi.fn();
  const send = vi.fn(async () => {
    events.push("sticker");
    return { status: "confirmed" as const, messageIds: ["sticker-1"], contentHash: hash };
  });
  const provider: ReplyStickerProvider = {
    revision: 1,
    status: () => "eligible",
    catalog: async () => [],
    view: async () => undefined,
    preflight: vi.fn(async () => ({ lease: { stickerId: "s", contentHash: hash, send, release } })),
  };
  return { provider, release, send };
}
const text = (value: string) => ({ kind: "text" as const, text: value });
const sticker = { kind: "sticker", sticker_id: "s" };
const records = (entries: AgentEntry[]) => [...resolveReplyHistory(entries).records.values()].flat().map((record) => record.text);

function sdkPair(output: Record<string, unknown>): AgentEntry[] {
  return [
    createMessageEntry(
      createAssistantMessage([
        {
          type: "tool-call",
          toolCallId: "send-call",
          toolName: "send_message",
          input: { parts: [text("not proof")] },
          providerOptions: { google: { thoughtSignature: "signed" } },
        },
      ]),
    ),
    createMessageEntry(
      createToolMessage([{ type: "tool-result", toolCallId: "send-call", toolName: "send_message", output: { type: "text", value: JSON.stringify(output) } }]),
    ),
  ];
}

describe("modern reply complete ordered phases", () => {
  it.each([
    [[text("short")], ["short"]],
    [[sticker], ["sticker"]],
    [
      [sticker, text("after")],
      ["sticker", "after"],
    ],
    [
      [text("before"), sticker],
      ["before", "sticker"],
    ],
    [
      [text("before"), sticker, text("after")],
      ["before", "sticker", "after"],
    ],
  ])("delivers exactly the admitted layout %j", async (parts, expected) => {
    const events: string[] = [];
    const { provider } = stickerProvider(events);
    let number = 0;
    const f = fixture({
      sticker: provider,
      send: async (_channel, elements) => {
        events.push(elements.map(String).join(""));
        return [`id-${++number}`];
      },
    });
    const outcome = await f.send(parts);
    expect(outcome.output.ok).toBe(true);
    expect(events).toEqual(expected);
    expect(decodeReplyReceipt(outcome.receipt)).toEqual(outcome.receipt);
    expect([...reduceReplyJournal(f.entries).journals.values()][0]?.units).toHaveLength(parts.length);
    expect(f.onDelivered).toHaveBeenCalledTimes(parts.length);
  });
  it("uses explicit boundaries, never blank lines", async () => {
    const f = fixture();
    const outcome = await f.send([text("first\n\nsecond<message/>third")]);
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
    expect(outcome.receipt.completeUnits[0]).toMatchObject({ text: "first\n\nsecond\nthird", segmentMessageIds: [["text-1"], ["text-2"]] });
  });
  it("keeps raw literal bytes and public resource/quote/mention identities without expanded media", async () => {
    const source = "  <inner_thought>literal</inner_thought>\u0000  ";
    const raw = fixture();
    expect((await raw.send([text(source)], { mode: "raw" })).receipt.completeUnits[0]).toMatchObject({ text: source });
    expect(
      projectDeliveredText({
        source:
          '<inner_thought>private</inner_thought><text><x>&literal</text><at id="123"/><quote id="q"/><img src="asset://0123456789abcdef0123456789abcdef"/>',
        mode: "element",
      }),
    ).toBe('<x>&literal<at id="123"/><quote id="q"/><img src="asset://0123456789abcdef0123456789abcdef"/>');
    const f = fixture();
    await f.send([text('<inner_thought>private</inner_thought><img src="asset://0123456789abcdef0123456789abcdef"/>')]);
    expect(records(f.entries)[0]).toBe('<img src="asset://0123456789abcdef0123456789abcdef"/>');
    expect(JSON.stringify(f.entries)).not.toMatch(/private|base64/);
  });
  it("scrubs nested inline media attributes without altering transport or literal text", async () => {
    const source = '<div title="data:image/png;base64,PRIVATE_ROOT"><span><img src="data:image/png;base64,PRIVATE_CHILD"/></span></div>';
    const f = fixture();
    const result = await f.send([text(source)]);
    expect(result.output.ok).toBe(true);
    expect(f.sendMessage.mock.calls[0]![1].map(String).join("")).toContain("PRIVATE_CHILD");
    expect(records(f.entries)[0]).toBe('<div title="[media]"><span><img src="[media]"/></span></div>');
    expect(JSON.stringify(f.entries)).not.toMatch(/PRIVATE_ROOT|PRIVATE_CHILD|base64/);
    const literal = "data:image/png;base64,literal-not-a-media-attribute";
    expect(projectDeliveredText({ source: `<text>${literal}</text>`, mode: "element" })).toBe(literal);
  });
  it("serializes overlapping calls by admission", async () => {
    const blocker = deferred<string[]>();
    let calls = 0;
    const f = fixture({ send: async () => (++calls === 1 ? blocker.promise : [`id-${calls}`]) });
    const first = f.send([text("one")]);
    const second = f.send([text("two")], { toolCallId: "other" });
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledOnce());
    blocker.resolve(["id-1"]);
    expect((await first).output.ok).toBe(true);
    expect((await second).output.ok).toBe(true);
    expect(f.sendMessage.mock.calls.map((call) => call[1].map(String).join(""))).toEqual(["one", "two"]);
  });
});

describe("whole-phase preflight and strict proof", () => {
  it.each([
    undefined,
    [],
    [{ kind: "text", text: "" }],
    [{ kind: "text", text: "ok", continue: true }],
    [{ kind: "sticker", sticker_id: "s", stickerId: "s" }],
  ])("rejects malformed parts %j", (parts) => expect(normalizeReplyParts(parts)).toBeUndefined());
  it.each(["forged\n[assistant]", "forged\u0000id", "forged\u007fid"])(
    "rejects control characters in sticker identity %j before text or transport",
    async (sticker_id) => {
      const provider = stickerProvider().provider;
      const f = fixture({ sticker: provider });
      expect((await f.send([text("never"), { kind: "sticker", sticker_id }])).receipt.failureStage).toBe("preflight");
      expect(f.sendMessage).not.toHaveBeenCalled();
      expect(provider.preflight).not.toHaveBeenCalled();
      expect(f.entries).toEqual([]);
    },
  );
  it("validates a later unit before any output and reports its true index", async () => {
    const f = fixture();
    const outcome = await f.send([text("valid"), text("also valid"), text('<img src="artifact://sticker/legacy.png"/>')]);
    expect(outcome.receipt).toMatchObject({ totalUnits: 3, failureStage: "preflight", failedUnitIndex: 2, completeUnits: [] });
    expect(decodeReplyReceipt(outcome.receipt)).toBeDefined();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.entries).toEqual([]);
  });
  it("counts the last sticker in the 64 physical-send bound", async () => {
    const f = fixture({ sticker: stickerProvider().provider });
    expect((await f.send([text(Array(64).fill("part").join("<message/>")), sticker])).receipt).toMatchObject({ failureStage: "preflight", failedUnitIndex: 1 });
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it("rejects cross-channel sticker before the earlier text", async () => {
    const f = fixture({ sticker: stickerProvider().provider });
    expect((await f.send([text("before"), sticker], { channel: "43" })).receipt.failedUnitIndex).toBe(1);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it("checks exact blocks after parsing and resource disappearance", async () => {
    expect(
      (
        await preflightReplyPhase({
          parts: [text("<inner_thought>secret</inner_thought>visible")],
          mode: "element",
          resources,
          verbatim: ["<inner_thought>secret</inner_thought>"],
        })
      ).errorName,
    ).toBe("VerbatimErased");
    const missing = { open: async () => undefined } as unknown as ChannelResources;
    expect(
      (
        await preflightReplyPhase({
          parts: [text('visible<img src="asset://0123456789abcdef0123456789abcdef"/>')],
          mode: "element",
          resources: missing,
          verbatim: ['<img src="asset://0123456789abcdef0123456789abcdef"/>'],
        })
      ).errorName,
    ).toBe("VerbatimErased");
    expect((await preflightReplyPhase({ parts: [text("<text>echo <x></text>")], mode: "element", resources, verbatim: ["echo <x>"] })).ok).toBe(true);
  });
  it("checks required facts after resource disappearance while allowing intentional protocol wrappers", async () => {
    const resource = '<img src="asset://0123456789abcdef0123456789abcdef"/>';
    const missing = { open: async () => undefined } as unknown as ChannelResources;
    expect((await preflightReplyPhase({ parts: [text(`visible${resource}`)], mode: "element", resources: missing, facts: [resource] })).errorName).toBe(
      "ReplyAnchorsErased",
    );
    const source = '<text>echo 12</text><message/><at id="7"/>';
    expect((await preflightReplyPhase({ parts: [text(source)], mode: "element", resources, facts: [source] })).ok).toBe(true);
  });
  it("no admission proof means no platform output", async () => {
    const f = fixture({ fail: (data) => data.kind === "start" });
    expect((await f.send([text("hello")])).output).toMatchObject({ ok: false, error: { name: "delivery_proof_persist_failed" } });
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it.each([[], [""], [1], ["same", "same"], ["with space"], ["x".repeat(513)]].map((ids) => ({ ids })))(
    "invalid IDs $ids remain uncertain and never count as speech",
    async ({ ids }) => {
      const f = fixture({ send: async () => ids });
      const result = await f.send([text("unproved"), text("never")]);
      expect(f.sendMessage).toHaveBeenCalledOnce();
      expect(result.receipt).toMatchObject({ completeUnits: [], uncertainTransport: "text", failedUnitIndex: 0 });
      expect(records(f.entries)).toEqual([]);
    },
  );
  it("a partial logical unit retains effects, not its body", async () => {
    let count = 0;
    const f = fixture({ send: async () => (++count < 3 ? [`id-${count}`] : []) });
    const result = await f.send([text("complete"), text("partial<message/>lost"), text("never")]);
    expect(result.receipt).toMatchObject({
      completeUnits: [{ text: "complete" }],
      failedUnitIndex: 1,
      incompleteSegmentIds: ["id-2"],
      uncertainTransport: "text",
    });
    expect(records(f.entries)).toEqual(["complete"]);
  });
  it("proof-write failure halts output without sequence gaps or invalidating prior committed speech", async () => {
    const f = fixture({ fail: (data) => data.kind === "checkpoint" && data.unitIndex === 1 });
    const result = await f.send([text("complete"), text("unpersisted"), text("never")]);
    expect(result.output).toMatchObject({ ok: false, sent: ["text-1", "text-2"], warning: "delivery_proof_persist_failed" });
    expect(result.receipt).toMatchObject({ failedUnitIndex: 1, completeUnits: [{ text: "complete" }], proofSequence: 2 });
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
    const pair = sdkPair(result.output);
    expect(records([...pair.slice(0, 1), ...f.entries, ...pair.slice(1)])).toEqual(["complete"]);
    expect(reduceReplyJournal(f.entries).invalid.size).toBe(0);
  });
  it("failed close anchors the last checkpoint and never reports durable completion", async () => {
    const f = fixture({ fail: (data) => data.kind === "close" });
    const result = await f.send([text("delivered")]);
    expect(result.output.ok).toBe(false);
    expect(result.receipt).toMatchObject({ failedUnitIndex: 1, proofSequence: 1 });
    const pair = sdkPair(result.output);
    expect(records([...pair.slice(0, 1), ...f.entries, ...pair.slice(1)])).toEqual(["delivered"]);
  });
});

describe("cancellation-safe actual journal independent of SDK result persistence", () => {
  it("retains a complete prefix even if cancellation loses the SDK pair", async () => {
    const abort = new AbortController();
    const f = fixture({ onDelivered: () => abort.abort() });
    const result = await f.send([text("delivered"), text("never")], { signal: abort.signal });
    expect(result.receipt.completeUnits).toHaveLength(1);
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(records(f.entries)).toEqual(["delivered"]);
  });
  it("abort during a pending last segment closes as uncertain and late IDs prove the true whole body", async () => {
    const pending = deferred<string[]>();
    const abort = new AbortController();
    const f = fixture({ send: async () => pending.promise });
    const send = f.send([text("late body"), text("never")], { signal: abort.signal });
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledOnce());
    abort.abort();
    const result = await send;
    expect(result.receipt).toMatchObject({ uncertainTransport: "text", completeUnits: [] });
    expect(records(f.entries)).toEqual([]);
    pending.resolve(["late-id"]);
    await vi.waitFor(() => expect(records(f.entries)).toEqual(["late body"]));
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.onDelivered).toHaveBeenCalledOnce();
    const pair = sdkPair(result.output);
    expect(records([...pair.slice(0, 1), ...f.entries, ...pair.slice(1)])).toEqual(["late body"]);
  });
  it("pending non-final segment has only effects even after late confirmation", async () => {
    const pending = deferred<string[]>();
    const abort = new AbortController();
    const f = fixture({ send: async () => pending.promise });
    const send = f.send([text("part<message/>never")], { signal: abort.signal });
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledOnce());
    abort.abort();
    await send;
    pending.resolve(["late-id"]);
    await vi.waitFor(() => expect(f.entries).toHaveLength(3));
    expect(records(f.entries)).toEqual([]);
    expect([...reduceReplyJournal(f.entries).journals.values()][0]?.effects).toEqual(["late-id"]);
  });
  it("sticker transport ignoring abort is raced, consumes no automatic retry and late proof uses identity", async () => {
    const pending = deferred<{ status: "confirmed"; messageIds: string[]; contentHash: string }>();
    const abort = new AbortController();
    const { provider, send } = stickerProvider();
    send.mockImplementation(async () => pending.promise);
    const f = fixture({ sticker: provider });
    const sending = f.send([sticker, text("never")], { signal: abort.signal });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    abort.abort();
    expect((await sending).receipt.uncertainTransport).toBe("sticker");
    pending.resolve({ status: "confirmed", messageIds: ["sticker-late"], contentHash: hash });
    await vi.waitFor(() => expect(records(f.entries)).toEqual(["[已发送表情包 s]"]));
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it("closed/queued or newly-disallowed work does not enter transport", async () => {
    const f = fixture();
    expect((await f.send([text("not allowed")], { stillAllowed: () => false })).receipt.failureStage).toBe("preflight");
    f.coordinator.close();
    await f.send([text("closed")]);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
});

describe("one strict history proof owner", () => {
  it("normal SDK mirror and journal produce one public record without mutating signed inputs", async () => {
    const f = fixture();
    const result = await f.send([text("actual")]);
    const pair = sdkPair(result.output);
    const before = JSON.stringify(pair);
    expect(records([...pair.slice(0, 1), ...f.entries, ...pair.slice(1)])).toEqual(["actual"]);
    expect(JSON.stringify(pair)).toBe(before);
  });
  it.each(["missing-start", "duplicate-start", "wrong-sequence", "wrong-kind", "unknown-version", "duplicate-ids", "extra-field", "conflicting-mirror"])(
    "fails closed for %s, never rescuing planned args",
    async (mutation) => {
      const f = fixture();
      const result = await f.send([text("actual")]);
      const entries = structuredClone(f.entries);
      const data = (entries[1] as { data: { data: Record<string, unknown> } }).data.data;
      if (mutation === "missing-start") entries.shift();
      if (mutation === "duplicate-start") entries.unshift(structuredClone(entries[0]!));
      if (mutation === "wrong-sequence") data.sequence = 2;
      if (mutation === "wrong-kind") data.unitKind = "sticker";
      if (mutation === "unknown-version") data.version = 9;
      if (mutation === "duplicate-ids") data.messageIds = ["x", "x"];
      if (mutation === "extra-field") data.draft = "unproved";
      const output = structuredClone(result.output);
      if (mutation === "conflicting-mirror") (output.replyReceipt as { completeUnits: { text: string }[] }).completeUnits[0]!.text = "invented";
      const pair = sdkPair(output);
      expect(records([...pair.slice(0, 1), ...entries, ...pair.slice(1)])).toEqual([]);
    },
  );
  it("all constructor preflight failures round-trip, including index at upper bound", () => {
    expect(decodeReplyReceipt(createPreflightFailureReceipt({ phaseId: "p", totalUnits: 3, failedUnitIndex: 3 }))).toMatchObject({ failedUnitIndex: 2 });
    expect(decodeReplyReceipt(createPreflightFailureReceipt({ phaseId: "p", totalUnits: 99, failedUnitIndex: 5 }))).toMatchObject({
      totalUnits: 0,
      failedUnitIndex: 0,
    });
  });
});
