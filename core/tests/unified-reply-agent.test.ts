import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createAgent, createUserMessage, type Agent, type AgentPlugin } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("../src/agents/tools.js", async (original) => ({ ...(await original<object>()), pacedDelay: () => 0 }));
import { StickerDeliveryService } from "../../plugins/sticker-manager/src/delivery.js";
import type { StickerStore } from "../../plugins/sticker-manager/src/store.js";
import { config, createDeps, scope, stickerId } from "../../plugins/sticker-manager/tests/preview-fixtures.js";
import { createReplyTools } from "../src/agents/reply-tools.js";
import { createFinishTool } from "../src/agents/tools.js";
import { collectDeliveredSourceRecords, createInternalHistoryProjectionPlugin, stripInternalAssistantInputs } from "../src/conversations/internal-history.js";
import { beginReplyJournal, createReplyJournalHistoryPlugin } from "../src/conversations/reply-journal.js";
type Call = { toolName: string; input: Record<string, unknown> };

type Step = Call | Call[] | ((messages: ModelMessage[]) => Call);
const text = (value: string) => ({ kind: "text" as const, text: value });
const sticker = { kind: "sticker", sticker_id: stickerId };
const preview: Call = { toolName: "sticker_preview", input: { sticker_id: stickerId } };
function modelFor(steps: Step[]) {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: async (options) => {
      const step = steps[index];
      if (!step) throw new Error("unexpected mock request");
      const id = index++;
      const picked = typeof step === "function" ? step(options.prompt as ModelMessage[]) : step;
      const calls = Array.isArray(picked) ? picked : [picked];
      return {
        stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
          { type: "stream-start", warnings: [] },
          ...calls.flatMap((call, position) => {
            const callId = `call-${id}-${position}`;
            const input = JSON.stringify(call.input);
            return [
              { type: "tool-input-start" as const, id: callId, toolName: call.toolName },
              { type: "tool-input-delta" as const, id: callId, delta: input },
              { type: "tool-input-end" as const, id: callId },
              { type: "tool-call" as const, toolCallId: callId, toolName: call.toolName, input },
            ];
          }),
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      };
    },
  });
}

async function run(steps: Step[], options: { failedPreview?: boolean; cancelAfter?: number } = {}) {
  const deps = createDeps();
  if (options.failedPreview) deps.store.get.mockResolvedValue(null);
  let sends = 0;
  let agent!: Agent;
  const sendMessage = vi.fn(async (_channel: string, _elements: unknown[]) => [`platform-${++sends}`]);
  const delivery = new StickerDeliveryService({
    store: deps.store as unknown as StickerStore,
    sender: { send: deps.sender.send, sendWithProof: async () => sendMessage(scope.channelId, [{ type: "img" }]) },
    scope,
    config,
    sendSlot: deps.slot,
    previewGate: deps.gate,
  });
  let invocations = 0;
  const tools = createReplyTools({
    bot: { platform: "test", sendMessage } as never,
    channelId: scope.channelId,
    resources: {} as never,
    pacing: { charactersPerSecond: 1000, maxTotalDelayMs: 0 },
    innerThought: false,
    sticker: {
      revision: 1,
      status: (turnId) => delivery.status(turnId),
      catalog: () => delivery.catalog(),
      view: (turnId, messages) => delivery.view(turnId, messages),
      isViewCurrent: (view, turnId) => delivery.isViewCurrent(view, turnId),
      preflight: (input) => delivery.preflight(input),
    },
    journal: {
      begin: (input) =>
        beginReplyJournal({
          ...input,
          invocationId: `invocation-${++invocations}`,
          sessionId: "session",
          generation: 1,
          sink: {
            append: async (entry) => {
              await agent.storage.append(entry);
            },
          },
        }),
    },
    onDelivered: () => {
      if (options.cancelAfter && sends === options.cancelAfter) void agent.interrupt("cancel-after-real-delivery");
    },
  });
  const lifecycle: AgentPlugin = { name: "reply-test-lifecycle", onTurnFinish: (_result, context) => tools.finishTurn(context.turnId) };
  const model = modelFor(steps);
  agent = createAgent({
    model,
    tools: [...tools.tools, deps.preview, ...deps.tools.filter((tool) => tool.name !== "sticker_send"), createFinishTool()],
    plugins: [createReplyJournalHistoryPlugin(), createInternalHistoryProjectionPlugin(), lifecycle],
    requireTerminalTool: true,
  });
  const events: string[] = [];
  try {
    for await (const event of agent.run(createUserMessage("current scene"))) events.push(event.type);
    await agent.wait();
    const entries = await agent.storage.read();
    return { events, model, entries, sendMessage, records: [...collectDeliveredSourceRecords(entries).values()].flat() };
  } finally {
    await agent.stop();
    deps.projection.clearAll();
    deps.gate.clear();
    deps.slot.clear();
  }
}
const send = (parts: object[], keepGoing = false): Call => ({ toolName: "send_message", input: { parts, continue: keepGoing } });

describe("actual SDK unified reply orchestration", () => {
  it.each([
    { name: "short text", parts: [text("short")], kinds: ["text"] },
    { name: "sticker only", parts: [sticker], kinds: ["img"] },
    { name: "sticker text", parts: [sticker, text("after")], kinds: ["img", "text"] },
    { name: "text sticker", parts: [text("before"), sticker], kinds: ["text", "img"] },
    { name: "text sticker text", parts: [text("before"), sticker, text("after")], kinds: ["text", "img", "text"] },
  ])("A delivers $name from one accepted phase without expression", async ({ parts, kinds }) => {
    const sticker = parts.some((part) => part.kind === "sticker");
    const f = await run(sticker ? [preview, send(parts)] : [send(parts)]);
    expect(f.events).toContain("turn.done");
    expect(f.events).not.toContain("turn.failed");
    expect(f.sendMessage.mock.calls.map((call) => call[1].map((element) => (element as { type: string }).type).join(""))).toEqual(kinds);
    expect(f.records).toHaveLength(parts.length);
    // Only the scripted main-model steps run: no second expression/auxiliary inference exists.
    expect(f.model.doStreamCalls).toHaveLength(sticker ? 2 : 1);
    expect(JSON.stringify(f.entries)).not.toContain('"type":"image-data"');
  });
  it("preview may be omitted from delivery, silence uses finish", async () => {
    expect((await run([preview, send([text("no sticker fits")])])).records.map((record) => record.text)).toEqual(["no sticker fits"]);
    const silent = await run([{ toolName: "finish", input: {} }]);
    expect(silent.sendMessage).not.toHaveBeenCalled();
    expect(silent.records).toEqual([]);
  });
  it("a preliminary continue phase can precede more work and a final phase", async () => {
    const f = await run([send([text("acknowledgement")], true), { toolName: "sticker_categories", input: {} }, send([text("result")])]);
    expect(f.records.map((record) => record.text)).toEqual(["acknowledgement", "result"]);
    expect(f.events).toContain("turn.done");
  });
  it("same-step viewing cannot authorize A transport", async () => {
    const f = await run([[preview, send([sticker])], { toolName: "finish", input: {} }]);
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.records).toEqual([]);
  });
  it("a later authored phase after a consumed sticker keeps real ordering and IDs", async () => {
    const f = await run([preview, send([sticker], true), { toolName: "sticker_categories", input: {} }, send([text("later text")])]);
    expect(f.events).toContain("turn.done");
    expect(f.events).not.toContain("turn.failed");
    expect(f.sendMessage.mock.calls.map((call) => call[1].map((element) => (element as { type: string }).type))).toEqual([["img"], ["text"]]);
    expect(f.records.map((record) => record.text)).toEqual([`[已发送表情包 ${stickerId}]`, "later text"]);
    expect(f.model.doStreamCalls).toHaveLength(4);
    const outputs = f.entries.flatMap((entry) =>
      entry.type === "message" && entry.data.role === "tool"
        ? entry.data.content.flatMap((part) => (part.type === "tool-result" && part.toolName === "send_message" ? [part.output] : []))
        : [],
    );
    expect(outputs).toEqual([
      { type: "json", value: expect.objectContaining({ ok: true, messageIds: ["platform-1"] }) },
      { type: "json", value: expect.objectContaining({ ok: true, messageIds: ["platform-2"] }) },
    ]);
  });
  it("a consumed sticker rejects a second transport without blocking a later text phase", async () => {
    const f = await run([preview, send([sticker], true), send([sticker], true), send([text("later text")])]);
    expect(f.events).toContain("turn.done");
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
    expect(f.records.map((record) => record.text)).toEqual([`[已发送表情包 ${stickerId}]`, "later text"]);
    expect(JSON.stringify(f.entries)).toContain("sticker_send_limit_reached");
    expect(f.model.doStreamCalls).toHaveLength(4);
  });
  it.each([false, true])("a preview request stays internal and never becomes main-authored dialogue (failedPreview=%s)", async (failedPreview) => {
    const f = await run([preview, send([text("text-only reply")])], { failedPreview });
    expect(f.events).toContain("turn.done");
    expect(f.records.map((record) => record.text)).toEqual(["text-only reply"]);
    const nextRequest = JSON.stringify(f.model.doStreamCalls[1]);
    if (failedPreview) {
      expect(nextRequest).toContain("sticker_not_found");
      expect(nextRequest).not.toContain('"type":"image-data"');
    } else {
      expect(nextRequest).not.toContain("sticker_not_found");
      expect(nextRequest).toContain('"type":"image-data"');
    }
    expect(JSON.stringify(f.entries)).not.toContain("selector");
    expect(f.model.doStreamCalls).toHaveLength(2);
  });
  it("SDK abort before onStepFinish still retains Core actual prefix without inventing a signed pair", async () => {
    const f = await run([send([text("confirmed prefix"), text("never sent")])], { cancelAfter: 1 });
    expect(f.events).toContain("turn.aborted");
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.records.map((record) => record.text)).toEqual(["confirmed prefix"]);
    const serialized = JSON.stringify(stripInternalAssistantInputs(f.entries));
    expect(serialized).toContain("confirmed prefix");
    expect(serialized).not.toContain("never sent");
    expect(
      f.entries.some(
        (entry) =>
          entry.type === "message" &&
          entry.data.role === "assistant" &&
          Array.isArray(entry.data.content) &&
          entry.data.content.some((part) => part.type === "tool-call" && part.toolName === "send_message"),
      ),
    ).toBe(false);
  });
});
