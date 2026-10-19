import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { Context } from "@koishijs/core";
import type { Agent } from "@yesimbot/agent-runtime";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { h } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("koishi", async () => import("@koishijs/core"));

import { defaultWillEngine, type WillEngine } from "../src/agents/will.js";
import { Channel, type ChannelContext } from "../src/channels/index.js";
import type { MessageBatchInput, MessageBatchPlugin } from "../src/message-batches/index.js";
import { createMessage, isMessage, type MessageRecord } from "../src/messages/index.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import { createToolAccessHooks, type ToolAccessDecision } from "../src/tool-access.js";
import { defaultConfig, defaultMessageRecord, deliveryFailedEvent } from "./helpers/index.js";

const scope: ChannelContext = { type: "guild", platform: "test", channelId: "room-1", guildId: "room-1", selfId: "bot-1" };
const sensitive = ["hostExec", "browser-desktop_click", "computer_use"];
const roots: string[] = [];
const runtimes: ChannelRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function message(id: string, userId: string, directed = false): MessageRecord {
  return defaultMessageRecord({
    messageId: id,
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    user: { id: userId },
    elements: [...(directed ? [h.at("bot-1")] : []), h.text(id)],
  });
}

function currentBodies(options: LanguageModelV3CallOptions): string[] {
  const text = options.prompt
    .flatMap((message) =>
      typeof message.content === "string" ? [message.content] : message.content.filter((part) => part.type === "text").map((part) => part.text),
    )
    .join("\n");
  return [...text.matchAll(/\[CURRENT_MESSAGE\]\n([\s\S]*?)\n\[\/CURRENT_MESSAGE\]/g)].map((match) => match[1]!);
}

async function fixture(
  options: {
    will?: WillEngine;
    steps?: string[];
    scope?: ChannelContext;
    immediate?: boolean;
    onExecute?: (agent: Agent) => void | Promise<void>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-group-access-"));
  roots.push(root);
  const channelScope = options.scope ?? scope;
  const channel = new Channel(channelScope, root);
  await channel.conversation.init();
  const requests: LanguageModelV3CallOptions[] = [];
  const decisions: ToolAccessDecision[] = [];
  const executed = vi.fn(async () => {
    await options.onExecute?.(Reflect.get(runtime, "agent") as Agent);
    return { ok: true };
  });
  const steps = options.steps ?? ["finish"];
  const model = new MockLanguageModelV3({
    doStream: async (request) => {
      const step = steps[requests.length];
      if (!step) throw new Error("unexpected scripted model request");
      requests.push(request);
      const id = `call-${requests.length}`;
      return {
        stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
          { type: "stream-start", warnings: [] },
          ...(step === "plain"
            ? [
                { type: "text-start" as const, id },
                { type: "text-delta" as const, id, delta: "internal text without a terminal tool" },
                { type: "text-end" as const, id },
              ]
            : [{ type: "tool-call" as const, toolCallId: id, toolName: step, input: "{}" }]),
          {
            type: "finish",
            finishReason: { unified: step === "plain" ? "stop" : "tool-calls", raw: step === "plain" ? "stop" : "tool-calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      };
    },
  });
  const queued: MessageBatchInput[] = [];
  let flush!: (inputs: readonly MessageBatchInput[]) => Promise<void>;
  const batch: MessageBatchPlugin = {
    priority: 0,
    match: () => true,
    setup: async (_context, flushMessages, extensions) => {
      flush = extensions?.flushInputs ?? (flushMessages as typeof flush);
      return {
        enqueue: (input) => {
          queued.push(input);
        },
        enqueueEvent: (input) => {
          queued.push(input);
          return true;
        },
      };
    },
  };
  const runtime = new ChannelRuntime(new Context(), {
    channel,
    bot: { selfId: "bot-1", platform: "test", sendMessage: vi.fn(async () => ["must-not-send"]) } as never,
    will: options.will ?? { decide: () => "trigger" },
    model,
    readImagePolicy: { mode: "native" },
    config: defaultConfig({
      basePath: root,
      modelRetries: 0,
      session: {
        compact: { responseIdleMinutes: 0, checkIntervalMinutes: 0, turnThreshold: 50, minMessages: 15, maxFailures: 3, inlineFragments: 3 },
        archive: { maxKB: 0 },
      },
    }),
    plugins: [
      {
        name: "sensitive-fixture",
        tools: sensitive.map((name) => ({ name, inputSchema: z.object({}), execute: executed })),
        ...createToolAccessHooks({
          scope: channelScope,
          rules: [{ platform: "test", channelId: "*", userId: "operator" }],
          toolNames: sensitive,
          blockReason: "not authorized",
          onDecision: (decision) => decisions.push(decision),
        }),
      },
    ],
    ...(options.immediate ? {} : { messageBatch: batch }),
  });
  runtimes.push(runtime);
  await runtime.init();
  const drain = async () => {
    if (!options.immediate) await flush(queued.splice(0));
    await runtime.wait();
  };
  const offered = () => requests.map((request) => (request.tools ?? []).map((tool) => tool.name).filter((name) => sensitive.includes(name)));
  return { runtime, channel, queued, drain, requests, offered, decisions, executed };
}

describe("actual group batch request and tool authorization", () => {
  it.each([false, true])("keeps the addressed operator as the principal in either arrival order (reversed=%s)", async (reverse) => {
    const f = await fixture({ steps: ["hostExec", "finish"] });
    const inputs = [message("operator-request-1", "operator", true), message("ambient-2", "bystander")];
    for (const input of reverse ? inputs.toReversed() : inputs) await f.runtime.handle(input);
    await f.drain();
    expect(f.offered()).toEqual([sensitive, sensitive]);
    expect(f.executed).toHaveBeenCalledOnce();
    expect(f.requests.map(currentBodies)).toEqual([['<at id="bot-1"/>operator-request-1'], ['<at id="bot-1"/>operator-request-1']]);
    expect(JSON.stringify(f.requests[0])).toContain("ambient-2");
    expect(f.decisions.every((decision) => decision.actorIds.join() === "operator" && decision.allowed)).toBe(true);
    expect(f.decisions.find((decision) => decision.phase === "execute")).toMatchObject({ stepNumber: 0, reason: "allowed" });
  });

  it("a later directed unauthorized request becomes principal rather than borrowing the operator's grant", async () => {
    const f = await fixture();
    await f.runtime.handle(message("operator-request-1", "operator", true));
    await f.runtime.handle(message("other-request-2", "other", true));
    await f.drain();
    expect(f.offered()).toEqual([[]]);
    expect(f.requests.map(currentBodies)).toEqual([['<at id="bot-1"/>other-request-2']]);
    expect(f.decisions[0]).toMatchObject({ actorIds: ["other"], allowed: false, reason: "actor-denied" });
  });

  it.each(["bot", "third-party", "quoted-at"])("uses only normalized bot quotes or current-body mentions as anchors (%s)", async (kind) => {
    const f = await fixture();
    const request = message("quoted-request-1", "operator");
    await f.runtime.handle({
      ...request,
      ...(kind === "quoted-at"
        ? { elements: [h("quote", { id: "q" }, [h.at("bot-1")]), h.text("quoted-request-1")] }
        : {
            quote: { messageId: "q", author: { id: kind === "bot" ? "bot-1" : "third-party" }, elements: [h.text("quoted text")] },
          }),
    });
    await f.runtime.handle(message("ambient-2", "other"));
    await f.drain();
    expect(f.offered()).toEqual([kind === "bot" ? sensitive : []]);
    expect(f.decisions[0]?.actorIds).toEqual([kind === "bot" ? "operator" : "other"]);
  });

  it("does not preserve an addressed input whose per-input Will decision was wait", async () => {
    const f = await fixture({ will: { decide: (input) => (isMessage(input) && input.data.messageId === "operator-request-1" ? "wait" : "trigger") } });
    await f.runtime.handle(message("operator-request-1", "operator", true));
    await f.runtime.handle(message("ambient-2", "other"));
    await f.drain();
    expect(f.offered()).toEqual([[]]);
  });

  it("keeps no-anchor latest-input behavior and all-wait silence", async () => {
    const f = await fixture();
    await f.runtime.handle(message("operator-1", "operator"));
    await f.runtime.handle(message("other-2", "other"));
    await f.drain();
    expect(f.offered()).toEqual([[]]);
    const waiting = await fixture({ will: { decide: () => "wait" } });
    await waiting.runtime.handle(message("operator-1", "operator", true));
    await waiting.drain();
    expect(waiting.requests).toEqual([]);
  });

  it("keeps direct batches on the latest input", async () => {
    const f = await fixture({ scope: { type: "direct", platform: "test", channelId: "private:operator", userId: "operator", selfId: "bot-1" } });
    await f.runtime.handle(message("first-1", "operator", true));
    await f.runtime.handle(message("latest-2", "operator"));
    await f.drain();
    expect(f.requests.map(currentBodies)).toEqual([["latest-2"]]);
    expect(f.offered()).toEqual([sensitive]);
  });

  it("default mention routing keeps an earlier directed input when the last bystander waits", async () => {
    const f = await fixture({ will: defaultWillEngine });
    await f.runtime.handle(message("request-1", "operator", true));
    await f.runtime.handle(message("ambient-2", "other"));
    await f.drain();
    expect(f.offered()).toEqual([sensitive]);
  });

  it("keeps authorization through tool steps and ignores an unscoped bystander append", async () => {
    const f = await fixture({
      steps: ["hostExec", "browser-desktop_click", "finish"],
      onExecute: (agent) => agent.append(createMessage(message("unscoped-3", "other"))).then(() => undefined),
    });
    await f.runtime.handle(message("request-1", "operator", true));
    await f.runtime.handle(message("ambient-2", "other"));
    await f.drain();
    expect(f.offered()).toEqual([sensitive, sensitive, sensitive]);
    expect(f.requests.map(currentBodies)).toEqual(Array.from({ length: 3 }, () => ['<at id="bot-1"/>request-1']));
    expect(f.decisions.every((decision) => decision.actorIds.join() === "operator")).toBe(true);
  });

  it("retains the same marker during terminal repair", async () => {
    const f = await fixture({ steps: ["hostExec", "plain", "finish"] });
    await f.runtime.handle(message("request-1", "operator", true));
    await f.runtime.handle(message("ambient-2", "other"));
    await f.drain();
    expect(f.requests.map(currentBodies)).toEqual(Array.from({ length: 3 }, () => ['<at id="bot-1"/>request-1']));
    expect(f.offered()).toEqual([sensitive, sensitive, []]);
    expect(JSON.stringify(f.requests[2])).toContain("internal repair step");
  });

  it("checks every actual joined actor, even after an authorized first tool", async () => {
    const f = await fixture({
      steps: ["hostExec", "finish"],
      onExecute: (agent) => {
        agent.send(createMessage(message("joined-3", "other")), { ifBusy: "join" });
      },
    });
    await f.runtime.handle(message("request-1", "operator", true));
    await f.drain();
    expect(f.offered()).toEqual([sensitive, []]);
    expect(f.decisions.at(-1)).toMatchObject({ actorIds: ["operator", "other"], allowed: false });
    expect(f.requests.map(currentBodies)).toEqual([['<at id="bot-1"/>request-1'], ["joined-3"]]);
  });

  it("a triggered actor-less runtime event cannot borrow an earlier operator's identity", async () => {
    const settleReservation = vi.fn(async () => {});
    const f = await fixture({
      will: { decide: () => "wait", decideBatch: () => ({ decision: "trigger", reservationId: "event-reservation" }), settleReservation },
    });
    await f.runtime.handle(message("request-1", "operator", true));
    await f.runtime.handle(deliveryFailedEvent());
    await f.drain();
    expect(f.offered()).toEqual([[]]);
    expect(f.decisions[0]).toMatchObject({ actorIds: [], reason: "missing-actor" });
    expect(settleReservation).toHaveBeenCalledOnce();
  });
});

describe("actual batch-aware Will candidate binding", () => {
  it("uses the actual candidate ID and author instead of the last batch message", async () => {
    const settleReservation = vi.fn(async () => {});
    const f = await fixture({
      will: {
        decide: () => "wait",
        decideBatch: (inputs) => ({
          decision: "trigger",
          candidate: { inputId: inputs[0]!.id, authorId: "operator", score: 80, probability: 0.8 },
          reservationId: "r",
        }),
        settleReservation,
      },
    });
    await f.runtime.handle(message("candidate-1", "operator"));
    await f.runtime.handle(message("latest-2", "other", true));
    await f.drain();
    expect(f.offered()).toEqual([sensitive]);
    expect(f.requests.map(currentBodies)).toEqual([["candidate-1"]]);
    expect(settleReservation).toHaveBeenCalledWith("r", expect.objectContaining({ kind: "release", reason: "done-without-delivery" }));
  });

  it.each(["platform-id", "wrong-author", "unknown-id"])("rejects %s candidates and releases their reservation", async (kind) => {
    const settleReservation = vi.fn(async () => {});
    const f = await fixture({
      will: {
        decide: () => "wait",
        decideBatch: (inputs) => ({
          decision: "trigger",
          candidate: {
            inputId: kind === "wrong-author" ? inputs[0]!.id : kind === "platform-id" ? "candidate-1" : "unknown",
            authorId: kind === "wrong-author" ? "other" : "operator",
            score: 80,
            probability: 0.8,
          },
          reservationId: "r",
        }),
        settleReservation,
      },
    });
    await f.runtime.handle(message("candidate-1", "operator", true));
    await f.drain();
    expect(f.requests).toEqual([]);
    expect(settleReservation).toHaveBeenCalledOnce();
    expect(settleReservation).toHaveBeenCalledWith("r", { kind: "release", reason: "start-failed" });
  });

  it.each([false, true])("validates immediate non-batched candidates too (valid=%s)", async (valid) => {
    const settleReservation = vi.fn(async () => {});
    const f = await fixture({
      immediate: true,
      will: {
        decide: () => "wait",
        decideBatch: (inputs) => ({
          decision: "trigger",
          candidate: { inputId: valid ? inputs[0]!.id : "missing", authorId: "operator", score: 80, probability: 0.8 },
          reservationId: "r",
        }),
        settleReservation,
      },
    });
    const result = await f.runtime.handle(message("request-1", "operator", true));
    if (result.kind === "run") await result.done;
    await f.drain();
    expect(f.requests).toHaveLength(valid ? 1 : 0);
    expect(result.kind).toBe(valid ? "run" : "wait");
    expect(settleReservation).toHaveBeenCalledOnce();
  });

  it("retries reservation release after an invalid candidate", async () => {
    const settleReservation = vi.fn(async () => {}).mockRejectedValueOnce(new Error("temporary persistence failure"));
    const f = await fixture({
      will: {
        decide: () => "wait",
        decideBatch: () => ({ decision: "trigger", candidate: { inputId: "missing", authorId: "operator", score: 1, probability: 1 }, reservationId: "r" }),
        settleReservation,
      },
    });
    await f.runtime.handle(message("request-1", "operator", true));
    await f.drain();
    expect(f.requests).toEqual([]);
    expect(settleReservation).toHaveBeenCalledTimes(2);
  });

  it("binds a typed poke candidate to its real actor without granting message-user permissions", async () => {
    const settleReservation = vi.fn(async () => {});
    const f = await fixture({
      will: {
        decide: () => "wait",
        decideBatch: (inputs) => ({
          decision: "trigger",
          candidate: { inputId: inputs[0]!.id, authorId: "operator", score: 1, probability: 1 },
          reservationId: "r",
        }),
        settleReservation,
      },
    });
    await f.runtime.handle({
      eventType: "notice.poke",
      platform: "test",
      selfId: "bot-1",
      timestamp: 1,
      channel: { id: "room-1", type: 0 },
      text: "poke",
      actorId: "operator",
      targetId: "bot-1",
      action: "poke",
    } as never);
    await f.drain();
    expect(f.requests).toHaveLength(1);
    expect(f.offered()).toEqual([[]]);
    expect(f.decisions[0]?.reason).toBe("missing-actor");
    expect(settleReservation).toHaveBeenCalledOnce();
  });
});
