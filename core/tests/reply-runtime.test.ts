import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { Context } from "@koishijs/core";
import { createEntry, type Agent, type AgentPlugin } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("../src/agents/tools.js", async (original) => ({ ...(await original<object>()), pacedDelay: () => 0 }));

import { StickerDeliveryService } from "../../plugins/sticker-manager/src/delivery.js";
import type { StickerStore } from "../../plugins/sticker-manager/src/store.js";
import { config as stickerConfig, createDeps, scope, stickerId } from "../../plugins/sticker-manager/tests/preview-fixtures.js";
import type { ReplyLayoutComposer } from "../src/agents/reply.js";
import { Channel } from "../src/channels/index.js";
import { collectDeliveredSourceRecords } from "../src/conversations/internal-history.js";
import { ChannelRuntime, type ChannelRuntimeOptions } from "../src/runtimes/channel.js";
import { defaultConfig, defaultMessageRecord, deliveryFailedEvent } from "./helpers/index.js";

type Call = { toolName: string; input: Record<string, unknown> };

type Step = Call | ((messages: ModelMessage[]) => Call);
const text = (value: string) => ({ kind: "text" as const, text: value });
const finish = { toolName: "finish", input: {} };
const roots: string[] = [];
const runtimes: ChannelRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
function result(messages: ModelMessage[], name: string): Record<string, unknown> {
  for (const message of [...messages].reverse())
    if (message.role === "tool") {
      const part = message.content.find((part) => part.type === "tool-result" && part.toolName === name);
      if (part?.type === "tool-result" && part.output.type === "json") return part.output.value as Record<string, unknown>;
    }
  throw new Error("missing scripted result");
}

function modelFor(steps: Step[]) {
  const prompts: ModelMessage[][] = [];
  return {
    prompts,
    model: new MockLanguageModelV3({
      doStream: async (options) => {
        const step = steps[prompts.length];
        if (!step) throw new Error("unexpected scripted request");
        const id = `call-${prompts.length}`;
        const messages = options.prompt as ModelMessage[];
        prompts.push(messages);
        const call = typeof step === "function" ? step(messages) : step;
        const input = JSON.stringify(call.input);
        return {
          stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
            { type: "stream-start", warnings: [] },
            { type: "tool-input-start", id, toolName: call.toolName },
            { type: "tool-input-delta", id, delta: input },
            { type: "tool-input-end", id },
            { type: "tool-call", toolCallId: id, toolName: call.toolName, input },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            },
          ]),
        };
      },
    }),
  };
}

async function fixture(
  steps: Step[],
  options: Partial<Pick<ChannelRuntimeOptions, "composer" | "polisher" | "replyStillCurrent">> & { send?: () => Promise<string[]> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-modern-runtime-"));
  roots.push(root);
  const channel = new Channel(scope, root);
  await channel.conversation.init();
  const deps = createDeps();
  const sendMessage = vi.fn(options.send ?? (async () => ["platform-id"]));
  const delivery = new StickerDeliveryService({
    store: deps.store as unknown as StickerStore,
    sender: { send: deps.sender.send, sendWithProof: sendMessage },
    scope,
    config: stickerConfig,
    sendSlot: deps.slot,
    previewGate: deps.gate,
  });
  const ctx = new Context();
  const notices: unknown[] = [];
  ctx.on("yesimbot/delivered", (notice) => {
    notices.push(notice);
  });
  const scripted = modelFor(steps);
  const settleReservation = vi.fn(async () => {});
  const plugin: AgentPlugin = {
    name: "runtime-sticker-fixture",
    tools: () => [deps.preview],
    onTurnFinish: (_result, context) => {
      deps.gate.clearTurn(context.turnId);
      deps.slot.clearTurn(context.turnId);
    },
  };
  const runtime = new ChannelRuntime(ctx, {
    channel,
    bot: { selfId: "bot", platform: "test", sendMessage } as never,
    will: {
      decide: async () => "trigger" as const,
      decideBatch: async () => ({ decision: "trigger" as const, reservationId: "reservation" }),
      settleReservation,
      observe: () => {},
    },
    model: scripted.model,
    readImagePolicy: { mode: "native" },
    imageProjection: deps.projection,
    config: defaultConfig({ basePath: root, pacing: { charactersPerSecond: 100, maxTotalDelayMs: 0 }, modelRetries: 0 }),
    modernDelivery: true,
    plugins: [plugin],
    roleProfile: { characterDefinition: "FULL NORMAL MAIN ROLE" },
    ...options,
    sticker: {
      revision: 1,
      status: (turn) => delivery.status(turn),
      catalog: () => delivery.catalog(),
      view: (turn, messages) => delivery.view(turn, messages),
      isViewCurrent: (view, turn) => delivery.isViewCurrent(view, turn),
      preflight: (input) => delivery.preflight(input),
    },
    resolveRoleProfile: async () => ({ persona: "FULL EXPRESSION ROLE", characterDefinition: "FULL CHARACTER CARD" }),
  });
  runtimes.push(runtime);
  await runtime.init();
  const handle = async () => {
    const outcome = await runtime.handle(defaultMessageRecord({ channel: { id: scope.channelId, type: 0 } }));
    if (outcome.kind === "run") await outcome.done;
    await runtime.wait();
  };
  return { runtime, channel, ctx, handle, sendMessage, settleReservation, notices, prompts: scripted.prompts };
}

describe("actual ChannelRuntime modern reply boundaries", () => {
  it("sticker-only delivery with real platform IDs commits the active Will reservation", async () => {
    const f = await fixture([
      { toolName: "sticker_preview", input: { sticker_id: stickerId } },
      { toolName: "send_message", input: { parts: [{ kind: "sticker", sticker_id: stickerId }] } },
    ]);
    await f.handle();
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.settleReservation).toHaveBeenCalledOnce();
    expect(f.settleReservation).toHaveBeenCalledWith("reservation", expect.objectContaining({ kind: "commit", messageId: "platform-id" }));
    expect([...collectDeliveredSourceRecords(await f.channel.conversation.storage.read()).values()].flat().map((record) => record.text)).toEqual([
      `[已发送表情包 ${stickerId}]`,
    ]);
    expect(JSON.stringify(f.prompts[0])).toContain("FULL NORMAL MAIN ROLE");
  });
  it("a zero-ID sticker attempt releases Will instead of promoting uncertainty to delivery", async () => {
    const f = await fixture(
      [
        { toolName: "sticker_preview", input: { sticker_id: stickerId } },
        { toolName: "send_message", input: { parts: [{ kind: "sticker", sticker_id: stickerId }] } },
        finish,
      ],
      { send: async () => [] },
    );
    await f.handle();
    expect(f.settleReservation).toHaveBeenCalledOnce();
    expect(f.settleReservation).toHaveBeenCalledWith("reservation", expect.objectContaining({ kind: "release" }));
    expect(f.notices).toEqual([]);
  });
  it("a confirmed prefix commits Will and stays readable after actual SDK cancellation", async () => {
    const f = await fixture([{ toolName: "send_message", input: { parts: [text("confirmed"), text("never")] } }]);
    // Interrupt the actual SDK agent owned by this fixture without changing production visibility.
    const agent = Reflect.get(f.runtime, "agent") as Agent;
    f.ctx.on("yesimbot/delivered", () => {
      void agent.interrupt("after-first-id");
    });
    await f.handle();
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.settleReservation).toHaveBeenCalledOnce();
    expect(f.settleReservation).toHaveBeenCalledWith("reservation", expect.objectContaining({ kind: "commit" }));
    expect([...collectDeliveredSourceRecords(await f.channel.conversation.storage.read()).values()].flat().map((record) => record.text)).toEqual(["confirmed"]);
  });
  it("late actual IDs after stop record proof but never resurrect a released Will tracker", async () => {
    let resolve!: (ids: string[]) => void;
    const pending = new Promise<string[]>((done) => {
      resolve = done;
    });
    const f = await fixture([{ toolName: "send_message", input: { parts: [text("late actual")] } }], { send: () => pending });
    const run = f.handle();
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledOnce());
    await f.runtime.stop();
    await run;
    expect(f.settleReservation).toHaveBeenCalledOnce();
    expect(f.settleReservation).toHaveBeenCalledWith("reservation", expect.objectContaining({ kind: "release" }));
    resolve(["late-platform"]);
    await vi.waitFor(async () =>
      expect([...collectDeliveredSourceRecords(await f.channel.conversation.storage.read()).values()].flat().map((record) => record.text)).toEqual([
        "late actual",
      ]),
    );
    expect(f.settleReservation).toHaveBeenCalledOnce();
    expect(f.notices).toHaveLength(1);
  });
  it("B main stays neutral while the expression owner receives full profile and controls stay private", async () => {
    const compose = vi.fn<ReplyLayoutComposer["compose"]>(async () => ({ kind: "layout", parts: [text("expression output")] }));
    const f = await fixture(
      [
        { toolName: "prepare_reply", input: { facts: [], intent: "react", inner_thought: "PRIVATE" } },
        (messages) => ({ toolName: "send_message", input: { reply_id: result(messages, "prepare_reply").reply_id } }),
      ],
      {
        composer: { version: 1, name: "dedicated expression", compose },
      },
    );
    await f.handle();
    expect(compose).toHaveBeenCalledOnce();
    expect(compose.mock.calls[0]![0].profile).toMatchObject({ persona: "FULL EXPRESSION ROLE", characterDefinition: "FULL CHARACTER CARD" });
    expect(JSON.stringify(compose.mock.calls)).not.toContain("PRIVATE");
    expect(JSON.stringify(f.prompts)).not.toMatch(/FULL NORMAL MAIN ROLE|FULL EXPRESSION ROLE|FULL CHARACTER CARD|expression output/);
    expect(f.sendMessage).toHaveBeenCalledOnce();
  });
  it("declared unsupported B cannot downgrade to main-authored A or legacy drafts", async () => {
    const f = await fixture([{ toolName: "prepare_reply", input: { facts: [], intent: "react" } }, finish], {
      polisher: { name: "unsupported", mode: "compose", polish: async () => ["legacy draft"], replyLayout: { version: 99 } } as never,
    });
    await f.handle();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(f.prompts)).not.toMatch(/FULL NORMAL MAIN ROLE|legacy draft/);
  });
  it("a registry change during B composition closes preparation before any output", async () => {
    let current = true;
    const compose = vi.fn<ReplyLayoutComposer["compose"]>(async () => {
      current = false;
      return { kind: "layout", parts: [text("obsolete expression")] };
    });
    const f = await fixture([{ toolName: "prepare_reply", input: { facts: [], intent: "react" } }, finish], {
      composer: { version: 1, name: "expression", compose },
      replyStillCurrent: () => current,
    });
    await f.handle();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toContain("obsolete expression");
  });
  it("silent event turns block modern preparation and sending and cannot read ordinary history", async () => {
    const compose = vi.fn<ReplyLayoutComposer["compose"]>(async () => ({ kind: "layout", parts: [text("must not send")] }));
    const f = await fixture([{ toolName: "prepare_reply", input: { facts: [], intent: "react" } }, finish], {
      composer: { version: 1, name: "expression", compose },
    });
    await f.channel.conversation.storage.append(createEntry("message", { role: "user", id: "ordinary", timestamp: 1, content: "ORDINARY PRIVATE HISTORY" }));
    const outcome = await f.runtime.post(deliveryFailedEvent(), { delivery: "silent", historyMode: "event" });
    if (outcome.kind === "run") await outcome.done;
    expect(compose).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(f.prompts)).not.toContain("ORDINARY PRIVATE HISTORY");
  });
});
