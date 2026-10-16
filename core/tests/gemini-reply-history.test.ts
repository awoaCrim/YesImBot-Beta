import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@koishijs/core";
import { createAssistantMessage, createEntry, createToolMessage, createUserMessage, type Agent, type AgentPlugin } from "@yesimbot/agent-runtime";
import { h } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("../src/agents/tools.js", async (original) => ({ ...(await original<object>()), pacedDelay: () => 0 }));

import { apply as applyGoogle } from "../../providers/google/src/index.js";
import { Channel } from "../src/channels/index.js";
import { createDeliveredTranscriptMessage } from "../src/conversations/delivered-transcript.js";
import { isReplyDeliveryProof, replyToolValue } from "../src/conversations/reply-receipt.js";
import { ModelService } from "../src/models/index.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import { defaultConfig, defaultMessageRecord, deliveryFailedEvent, testScope } from "./helpers/index.js";

type Call = { name: string; args: Record<string, unknown>; signature?: string };

type WirePart = {
  text?: string;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
};

type WireMessage = { role: string; parts: WirePart[] };

type WireRequest = { contents: WireMessage[]; systemInstruction?: { parts: WirePart[] } };

const roots: string[] = [];
const runtimes: ChannelRuntime[] = [];
const services: ModelService[] = [];
const firstQuestion = "SYNTHETIC_QUESTION_ONE";
const secondQuestion = "SYNTHETIC_QUESTION_TWO";
const currentQuestion = "SYNTHETIC_CURRENT_QUESTION";
const firstAnswer = "SYNTHETIC_DELIVERED_ANSWER_ONE";
const secondAnswer = "SYNTHETIC_DELIVERED_ANSWER_TWO";
const liveSignature = "ZmFrZS1saXZlLXNpZ25hdHVyZQ==";
const send = (text: string): Call => ({ name: "send_message", args: { parts: [{ kind: "text", text }], inner_thought: "PRIVATE_PLAN" } });

function requestText(request: WireRequest): string {
  return request.contents.flatMap((message) => message.parts.flatMap((part) => (part.text === undefined ? [] : [part.text]))).join("\n");
}

function containing(request: WireRequest, text: string): number {
  return request.contents.findIndex((message) => message.parts.some((part) => part.text?.includes(text)));
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(calls: Call[], magic: boolean) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-gemini-reply-history-"));
  roots.push(root);
  const ctx = new Context();
  const service = new ModelService(ctx as never, { basePath: root, logLevel: 0 });
  services.push(service);
  await service.start();
  const ready: Array<() => void> = [];
  applyGoogle(
    {
      on(event: string, callback: () => void) {
        if (event === "ready") ready.push(callback);
      },
      yesimbot: { model: service },
      logger: () => ({ warn: vi.fn() }),
    } as never,
    {
      id: "synthetic-google",
      apiKey: "test-not-a-real-key",
      baseURL: "https://provider.invalid/v1beta",
      chatModels: [{ id: "gemini-3.7-flash-high", limit: { context: 147200, output: 8192 } }],
    },
  );
  for (const callback of ready) callback();

  const requests: WireRequest[] = [];
  const fetch = vi.fn(async (url: unknown, init: RequestInit) => {
    expect(String(url)).toMatch(/^https:\/\/provider\.invalid\//);
    const call = calls[requests.length];
    if (!call) throw new Error("unexpected synthetic provider request");
    requests.push(JSON.parse(String(init.body)) as WireRequest);
    const response = {
      candidates: [
        {
          index: 0,
          content: {
            role: "model",
            parts: [{ functionCall: { name: call.name, args: call.args }, thoughtSignature: call.signature ?? liveSignature }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1, totalTokenCount: 101 },
    };
    return new Response(`data: ${JSON.stringify(response)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetch);
  const model = service.resolveChatModel("synthetic-google:gemini-3.7-flash-high");
  expect(model.capabilities.historyProjection).toBe("gemini-native");

  const channel = new Channel(testScope, root);
  await channel.conversation.init();
  let delivered = 0;
  const sendMessage = vi.fn(async () => [`synthetic-platform-${++delivered}`]);
  const config = defaultConfig({ basePath: root, modelRetries: 0, logLevel: 0, pacing: { charactersPerSecond: 100, maxTotalDelayMs: 0 } });
  const plugin: AgentPlugin = {
    name: "synthetic-lookup",
    tools: () => [{ name: "lookup", description: "Returns a synthetic local result", inputSchema: z.object({}), execute: async () => "CURRENT_LOOKUP_RESULT" }],
  };
  const runtime = new ChannelRuntime(ctx, {
    channel,
    bot: { selfId: "bot-1", platform: "test", sendMessage } as never,
    will: { decide: async () => "trigger" as const, observe: () => {} },
    model: model.model,
    historyProjection: model.capabilities.historyProjection,
    contextModelLimit: service.contextLimit(model.model),
    readImagePolicy: { mode: "native" },
    config: {
      ...config,
      session: {
        ...config.session,
        compact: { ...config.session.compact, mode: "compartment" },
        magicContext: {
          enabled: magic,
          contextWindow: 147200,
          outputReserveTokens: 8192,
          historyBudgetPercentage: 25,
          recentMessages: 20,
          maxLoadedBlocks: 4,
          pageTokenBudget: 4096,
          retainTurns: 2,
        },
      },
    },
    plugins: [plugin],
  });
  runtimes.push(runtime);
  await runtime.init();
  let inputs = 0;
  const handle = async (text: string) => {
    const outcome = await runtime.handle(defaultMessageRecord({ messageId: `synthetic-input-${++inputs}`, timestamp: Date.now(), elements: [h.text(text)] }));
    if (outcome.kind === "run") await outcome.done;
    await runtime.wait();
  };
  return { runtime, channel, ctx, handle, sendMessage, requests, fetch };
}

describe("Gemini delivered reply history (real Core and Google SDK, stub HTTP only)", () => {
  it.each([false, true])("keeps two answered questions and the new current input in source order (Magic=%s)", async (magic) => {
    const f = await fixture([send(firstAnswer), send(secondAnswer), send("SYNTHETIC_NEW_ANSWER")], magic);
    await f.handle(firstQuestion);
    await f.handle(secondQuestion);
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
    const before = JSON.stringify(await f.channel.conversation.storage.read());
    const previousCount = (await f.channel.conversation.storage.read()).length;
    await f.handle(currentQuestion);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.sendMessage).toHaveBeenCalledTimes(3);

    const request = f.requests[2]!;
    const text = requestText(request);
    expect(text).toContain(firstQuestion);
    expect(text).toContain(secondQuestion);
    expect(text).toContain(currentQuestion);
    expect(text.split(firstAnswer)).toHaveLength(2);
    expect(text.split(secondAnswer)).toHaveLength(2);
    expect(text.split("[CURRENT_MESSAGE]")).toHaveLength(2);
    expect(containing(request, firstQuestion)).toBeLessThan(containing(request, firstAnswer));
    expect(containing(request, firstAnswer)).toBeLessThan(containing(request, secondQuestion));
    expect(containing(request, secondQuestion)).toBeLessThan(containing(request, secondAnswer));
    expect(containing(request, secondAnswer)).toBeLessThan(containing(request, currentQuestion));
    for (const answer of [firstAnswer, secondAnswer]) {
      expect(request.contents[containing(request, answer)]?.role).toBe("model");
    }
    expect(text).toContain('status="already-delivered"');
    expect(JSON.stringify(request.contents)).not.toMatch(/PRIVATE_PLAN|replyReceipt|reply-delivery-proof/);
    expect(request.contents.some((message) => message.role === "system")).toBe(false);
    expect(JSON.stringify((await f.channel.conversation.storage.read()).slice(0, previousCount))).toBe(before);
  });

  it("uses valid Magic coverage without dropping or duplicating another uncovered reply", async () => {
    const f = await fixture([send(firstAnswer), send(secondAnswer), { name: "finish", args: {} }], true);
    await f.handle(firstQuestion);
    const coveredEntries = await f.channel.conversation.storage.read();
    await f.handle(secondQuestion);
    const frozen = await f.channel.conversation.freezeContextRegion(coveredEntries.filter((entry) => entry.type === "message").map((entry) => entry.id));
    await f.channel.conversation.commitContextRegion(frozen, {
      importance: 0.5,
      tiers: { P1: "SYNTHETIC_COVERED_HISTORY_SUMMARY", P2: "covered history", P3: "covered", P4: "old" },
    });
    const before = await f.channel.conversation.storage.read();
    await f.handle(currentQuestion);
    const request = f.requests[2]!;
    expect(JSON.stringify(request.systemInstruction)).toContain("SYNTHETIC_COVERED_HISTORY_SUMMARY");
    const text = requestText(request);
    expect(text).not.toContain(firstQuestion);
    expect(text).not.toContain(firstAnswer);
    expect(text).toContain(secondQuestion);
    expect(text.split(secondAnswer)).toHaveLength(2);
    expect(containing(request, secondQuestion)).toBeLessThan(containing(request, secondAnswer));
    expect(containing(request, secondAnswer)).toBeLessThan(containing(request, currentQuestion));
    expect(text.split("[CURRENT_MESSAGE]")).toHaveLength(2);
    expect(JSON.stringify((await f.channel.conversation.storage.read()).slice(0, before.length))).toBe(JSON.stringify(before));
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("retains signed live tool continuation while restoring earlier delivered speech (Magic=%s)", async (magic) => {
    const f = await fixture([send(firstAnswer), { name: "lookup", args: {}, signature: liveSignature }, send(secondAnswer)], magic);
    await f.handle(firstQuestion);
    await f.handle(currentQuestion);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
    const request = f.requests[2]!;
    expect(requestText(request).split(firstAnswer)).toHaveLength(2);
    const call = request.contents.flatMap((message) => message.parts).find((part) => part.functionCall?.name === "lookup");
    expect(call?.thoughtSignature).toBe(liveSignature);
    const result = request.contents.flatMap((message) => message.parts).find((part) => part.functionResponse?.name === "lookup");
    expect(JSON.stringify(result)).toContain("CURRENT_LOOKUP_RESULT");
    expect(JSON.stringify(request)).not.toContain("PRIVATE_PLAN");
    expect(requestText(f.requests[1]!).split("[CURRENT_MESSAGE]")).toHaveLength(2);
    // The same admitted input stays marked across a tool continuation.
    expect(requestText(request)).toContain(currentQuestion);
    expect(requestText(request).split("[CURRENT_MESSAGE]")).toHaveLength(2);
  });

  it.each([false, true])("restores only the actually delivered journal-only prefix after SDK abort (Magic=%s)", async (magic) => {
    const f = await fixture(
      [
        {
          name: "send_message",
          args: {
            parts: [
              { kind: "text", text: firstAnswer },
              { kind: "text", text: "UNSENT_AFTER_ABORT" },
            ],
          },
        },
        { name: "finish", args: {} },
      ],
      magic,
    );
    const agent = Reflect.get(f.runtime, "agent") as Agent;
    let interrupted = false;
    f.ctx.on("yesimbot/delivered", () => {
      if (interrupted) return;
      interrupted = true;
      void agent.interrupt("synthetic-after-first-id");
    });
    await f.handle(firstQuestion);
    expect(f.sendMessage).toHaveBeenCalledOnce();
    const entries = await f.channel.conversation.storage.read();
    expect(entries.some((entry) => entry.type === "message" && isReplyDeliveryProof(entry.data))).toBe(true);
    expect(entries.some((entry) => entry.type === "message" && entry.data.role === "tool")).toBe(false);
    const before = JSON.stringify(entries);
    await f.handle(currentQuestion);
    const request = f.requests[1]!;
    expect(requestText(request).split(firstAnswer)).toHaveLength(2);
    expect(requestText(request)).toContain('partial="true"');
    expect(JSON.stringify(request)).not.toContain("UNSENT_AFTER_ABORT");
    expect(containing(request, firstQuestion)).toBeLessThan(containing(request, firstAnswer));
    expect(containing(request, firstAnswer)).toBeLessThan(containing(request, currentQuestion));
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify((await f.channel.conversation.storage.read()).slice(0, entries.length))).toBe(before);
  });

  it.each([false, true])("isolates event-only requests without discarding ordinary delivered history (Magic=%s)", async (magic) => {
    const f = await fixture([send(firstAnswer), { name: "finish", args: {} }, { name: "finish", args: {} }], magic);
    await f.handle(firstQuestion);
    const outcome = await f.runtime.post(deliveryFailedEvent(), { historyMode: "event", delivery: "silent" });
    if (outcome.kind === "run") await outcome.done;
    await f.runtime.wait();
    expect(JSON.stringify(f.requests[1])).not.toContain(firstQuestion);
    expect(JSON.stringify(f.requests[1])).not.toContain(firstAnswer);
    const eventText = requestText(f.requests[1]!);
    expect(eventText).toContain("[CURRENT_MESSAGE]\nThis is the current runtime event for this turn");
    expect(eventText).toContain('"eventType":"delivery.failed"');
    expect(eventText.split("[CURRENT_MESSAGE]")).toHaveLength(2);
    await f.handle(currentQuestion);
    expect(requestText(f.requests[2]!).split(firstAnswer)).toHaveLength(2);
    expect(requestText(f.requests[2]!)).toContain(firstQuestion);
    expect(requestText(f.requests[2]!)).toContain(`[CURRENT_MESSAGE]\n${currentQuestion}\n[/CURRENT_MESSAGE]`);
    expect(requestText(f.requests[2]!).split("[CURRENT_MESSAGE]")).toHaveLength(2);
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });

  it.each(["unknown-version", "missing-start", "empty-ids", "conflicting-mirror"] as const)(
    "does not rescue a historical draft or body from invalid modern proof (%s)",
    async (issue) => {
      const f = await fixture([send(firstAnswer), { name: "finish", args: {} }], true);
      await f.handle(firstQuestion);
      // Deliberately corrupt only this temporary fixture to exercise the full-canonical boundary.
      let entries = structuredClone(await f.channel.conversation.storage.read());
      if (issue === "missing-start") {
        entries = entries.filter((entry) => !(entry.type === "message" && isReplyDeliveryProof(entry.data) && entry.data.data.kind === "start"));
      } else if (issue === "conflicting-mirror") {
        const tool = entries.find((entry) => entry.type === "message" && entry.data.role === "tool");
        if (tool?.type !== "message" || tool.data.role !== "tool") throw new Error("missing synthetic mirror");
        const part = tool.data.content.find((item) => item.type === "tool-result" && item.toolName === "send_message");
        if (part?.type !== "tool-result") throw new Error("missing synthetic receipt");
        const value = replyToolValue(part.output) as { replyReceipt: { completeUnits: Array<{ text: string }> } };
        value.replyReceipt.completeUnits[0]!.text = "CONFLICTING_UNPROVEN_ANSWER";
        if (part.output.type === "text") part.output.value = JSON.stringify(value);
        else if (part.output.type === "json") part.output.value = value;
        else throw new Error("unexpected synthetic receipt type");
      } else {
        const checkpoint = entries.find((entry) => entry.type === "message" && isReplyDeliveryProof(entry.data) && entry.data.data.kind === "checkpoint");
        if (checkpoint?.type !== "message" || !isReplyDeliveryProof(checkpoint.data)) throw new Error("missing synthetic checkpoint");
        Reflect.set(checkpoint.data.data, issue === "unknown-version" ? "version" : "messageIds", issue === "unknown-version" ? 999 : []);
      }
      await f.channel.conversation.storage.clear();
      await f.channel.conversation.storage.append(...entries);
      await f.handle(currentQuestion);
      expect(requestText(f.requests[1]!)).toContain(firstQuestion);
      expect(JSON.stringify(f.requests[1]!.contents)).not.toMatch(/SYNTHETIC_DELIVERED_ANSWER_ONE|CONFLICTING_UNPROVEN_ANSWER|PRIVATE_PLAN|replyReceipt/);
      expect(f.fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { magic: false, partial: false },
    { magic: true, partial: false },
    { magic: false, partial: true },
    { magic: true, partial: true },
  ])("projects old actual-body receipts without restoring signed draft arguments (Magic=$magic, partial=$partial)", async ({ magic, partial }) => {
    const f = await fixture([{ name: "finish", args: {} }], magic);
    const output = partial
      ? { ok: false, sent: ["legacy-platform"], failedAt: 1, deliveredMessages: [firstAnswer] }
      : { ok: true, messageIds: ["legacy-platform"], count: 1, deliveredMessages: [firstAnswer] };
    await f.channel.conversation.storage.append(
      createEntry("message", createUserMessage(firstQuestion), { id: "legacy-user", timestamp: 1 }),
      createEntry(
        "message",
        createAssistantMessage([
          {
            type: "tool-call",
            toolCallId: "legacy-send",
            toolName: "send_message",
            input: { messages: ["PRIVATE_LEGACY_DRAFT", "UNSENT_LEGACY_DRAFT"], inner_thought: "PRIVATE_LEGACY_THOUGHT" },
            providerOptions: { google: { thoughtSignature: "LEGACY_DRAFT_SIGNATURE" } },
          },
        ]),
        { id: "legacy-call", timestamp: 2 },
      ),
      createEntry(
        "message",
        createToolMessage([{ type: "tool-result", toolCallId: "legacy-send", toolName: "send_message", output: { type: "json", value: output } }]),
        { id: "legacy-result", timestamp: 3 },
      ),
    );
    const before = JSON.stringify(await f.channel.conversation.storage.read());
    await f.handle(currentQuestion);
    const request = f.requests[0]!;
    expect(requestText(request).split(firstAnswer)).toHaveLength(2);
    expect(requestText(request)).toContain(`partial="${partial}"`);
    expect(containing(request, firstQuestion)).toBeLessThan(containing(request, firstAnswer));
    expect(containing(request, firstAnswer)).toBeLessThan(containing(request, currentQuestion));
    expect(JSON.stringify(request)).not.toMatch(/PRIVATE_LEGACY|UNSENT_LEGACY|LEGACY_DRAFT_SIGNATURE/);
    expect(request.contents.flatMap((message) => message.parts).some((part) => part.functionCall?.name === "send_message")).toBe(false);
    expect(JSON.stringify((await f.channel.conversation.storage.read()).slice(0, 3))).toBe(before);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps safe old native call/result pairs and their signatures without creating duplicate speech", async () => {
    const f = await fixture([{ name: "finish", args: {} }], true);
    await f.channel.conversation.storage.append(
      createEntry("message", createUserMessage(firstQuestion), { id: "paired-user", timestamp: 1 }),
      createEntry(
        "message",
        createAssistantMessage([
          {
            type: "tool-call",
            toolCallId: "paired-send",
            toolName: "send_message",
            input: { messages: [firstAnswer], inner_thought: "PRIVATE_OLD_THOUGHT" },
            providerOptions: { google: { thoughtSignature: liveSignature } },
          },
        ]),
        { id: "paired-call", timestamp: 2 },
      ),
      createEntry(
        "message",
        createToolMessage([
          {
            type: "tool-result",
            toolCallId: "paired-send",
            toolName: "send_message",
            output: { type: "json", value: { ok: true, count: 1, messageIds: ["paired-platform"] } },
          },
        ]),
        { id: "paired-result", timestamp: 3 },
      ),
    );
    await f.handle(currentQuestion);
    const parts = f.requests[0]!.contents.flatMap((message) => message.parts);
    const call = parts.find((part) => part.functionCall?.name === "send_message");
    expect(call?.functionCall?.args).toEqual({ messages: [firstAnswer] });
    expect(call?.thoughtSignature).toBe(liveSignature);
    expect(parts.filter((part) => part.functionResponse?.name === "send_message")).toHaveLength(1);
    expect(JSON.stringify(f.requests[0]).split(firstAnswer)).toHaveLength(2);
    expect(JSON.stringify(f.requests[0])).not.toContain("PRIVATE_OLD_THOUGHT");
    expect(JSON.stringify(f.requests[0]!.contents)).not.toContain("<delivered_transcript");
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("does not accept stored typed transcripts or marker-only assistant text as proven Gemini speech", async () => {
    const f = await fixture([{ name: "finish", args: {} }], false);
    await f.channel.conversation.storage.append(
      createEntry("message", createDeliveredTranscriptMessage({ messages: ["UNPROVEN_STORED_TRANSCRIPT"], deliveredCount: 1, partial: false })),
      createEntry("message", createAssistantMessage("[DELIVERED_MESSAGE]\nUNPROVEN_MARKER_BODY\n[/DELIVERED_MESSAGE]")),
    );
    await f.handle(currentQuestion);
    expect(JSON.stringify(f.requests[0])).not.toMatch(/UNPROVEN_STORED_TRANSCRIPT|UNPROVEN_MARKER_BODY/);
    expect(requestText(f.requests[0]!)).toContain(currentQuestion);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});
