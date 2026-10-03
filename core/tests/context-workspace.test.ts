import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { Context, h } from "@koishijs/core";
import { AgentRequestProjection, createAgent, createEntry, createUserMessage, type AgentModelRequestContext } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));
import { createContextWorkspaceTools, createFinishTool } from "../src/agents/tools.js";
import { Channel } from "../src/channels/index.js";
import { Config } from "../src/config.js";
import { Conversation } from "../src/conversations/index.js";
import { createInternalHistoryProjectionPlugin } from "../src/conversations/internal-history.js";
import { ChannelRuntime, createModelInputPlugin, mergeAdjacentUserMessages } from "../src/runtimes/channel.js";
import { ContextWorkspace } from "../src/runtimes/context-workspace.js";

const roots: string[] = [];
const workspaces: ContextWorkspace[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const workspace of workspaces.splice(0)) workspace.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const draft = JSON.stringify({
  tiers: { P1: "已确认目标和约束，下一步继续核对原文。", P2: "已确认目标约束，待核对原文。", P3: "保留目标，待核对。", P4: "待核对。" },
  importance: 0.8,
});
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function historian(blocked?: ReturnType<typeof latch>, text = draft) {
  const entered = latch();
  const generate = vi.fn(async () => {
    entered.release();
    await blocked?.promise;
    return {
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: { inputTokens: { total: 999999, noCache: 999999, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    };
  });
  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "historian",
    modelId: "historian",
    supportedUrls: {},
    doGenerate: generate,
    doStream: async () => {
      throw new Error("unexpected stream");
    },
  };
  return { model, generate, entered };
}

function mainModel(script: readonly { name: string; input: () => string; usage?: number }[] = []) {
  const calls: LanguageModelV3CallOptions[] = [];
  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "main",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("unexpected generate");
    },
    async doStream(options) {
      const action = script[calls.length];
      calls.push(structuredClone(options));
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (action) controller.enqueue({ type: "tool-call", toolCallId: `call_${calls.length}`, toolName: action.name, input: action.input() });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: action ? "tool-calls" : "stop", raw: undefined },
              usage: {
                inputTokens: { total: action?.usage ?? 100, noCache: action?.usage ?? 100, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            controller.close();
          },
        }),
      };
    },
  };
  return { model, calls };
}

async function fixture(texts = ["已结束的历史原文"], extra: Partial<ConstructorParameters<typeof ContextWorkspace>[2]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-magic-"));
  roots.push(root);
  const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3, mode: "compartment" }, { magicContext: true });
  await conversation.init();
  const entries = texts.map((content, index) =>
    createEntry("message", { id: `old_${index}`, timestamp: index + 1, role: "user", content }, { id: `old_${index}`, timestamp: index + 1 }),
  );
  await conversation.storage.append(...entries);
  const projection = new AgentRequestProjection();
  const { model, calls } = mainModel();
  const workspace = new ContextWorkspace(conversation, projection, {
    config: { contextWindow: 300000, outputReserveTokens: 1000 },
    compactMode: "compartment",
    model,
    ...extra,
  });
  workspaces.push(workspace);
  workspace.capture(entries);
  return { root, conversation, entries, projection, model, calls, workspace };
}

function context(
  f: Awaited<ReturnType<typeof fixture>>,
  turnId = "turn",
  stepNumber = 0,
  more: ModelMessage[] = [],
  historyMode: "conversation" | "event" = "conversation",
): AgentModelRequestContext {
  const live: ModelMessage = { role: "user", content: "当前问题" };
  f.projection.register(live, { kind: "live", sourceEntryIds: ["live"] });
  const history: ModelMessage[] = f.entries.map((entry) => {
    const message: ModelMessage = { role: "user", content: entry.data.role === "user" ? String(entry.data.content) : "" };
    f.projection.register(message, { kind: "history", sourceEntryIds: [entry.id], timestamp: entry.timestamp });
    return message;
  });
  return {
    model: f.model,
    system: "system",
    messages: historyMode === "event" ? [live, ...more] : [...history, live, ...more],
    tools: {},
    currentMessageIds: ["live"],
    projection: f.projection,
    historyMode,
    turnId,
    stepNumber,
    signal: new AbortController().signal,
    rebuildMessages: async () => [],
  };
}
const many = () => Array.from({ length: 90 }, (_, index) => `历史${index}:` + "x".repeat(4000));
async function settled(f: Awaited<ReturnType<typeof fixture>>) {
  await vi.waitFor(() => expect(f.workspace.status().backgroundActive).toBe(false));
}

describe("asynchronous Magic workspace", () => {
  it("keeps more than twenty messages and history beyond the old 20k budget without a measured trigger", async () => {
    const aux = historian();
    const f = await fixture(many(), { continuityModel: aux.model });
    const result = await f.workspace.guard(context(f));
    expect(result).toHaveLength(91);
    expect(JSON.stringify(result)).toContain("历史0:");
    expect(aux.generate).not.toHaveBeenCalled();
    expect(await f.conversation.contextRegions()).toHaveLength(0);
  });
  it("99999 does not trigger; 100000 starts outside the foreground and storage FIFO; next request adopts ready", async () => {
    const block = latch();
    const aux = historian(block);
    const f = await fixture(many(), { continuityModel: aux.model });
    const original = await f.workspace.guard(context(f));
    f.workspace.observeUsage("turn", 0, 99999);
    expect(aux.generate).not.toHaveBeenCalled();
    await f.workspace.guard(context(f, "turn", 1));
    f.workspace.observeUsage("turn", 1, 100000);
    await aux.entered.promise;
    const newEntry = createEntry("message", createUserMessage("并发到达的新消息"));
    await f.conversation.storage.append(newEntry);
    const during = await f.workspace.guard(context(f, "turn", 2));
    expect(JSON.stringify(during)).toContain("历史0:");
    expect(aux.generate).toHaveBeenCalledTimes(1);
    block.release();
    await settled(f);
    expect((await f.conversation.storage.read()).some((entry) => entry.id === newEntry.id)).toBe(true);
    const next = await f.workspace.guard(context(f, "turn", 3));
    expect(JSON.stringify(next)).toContain("context_region");
    expect(JSON.stringify(next)).not.toContain("历史0:");
    expect(JSON.stringify(next)).toContain("历史89:");
    expect(JSON.stringify(original)).toContain("历史0:");
    expect(f.workspace.status().providerInputTokens).toBe(100000); // auxiliary 999999 never enters policy
    const count = aux.generate.mock.calls.length;
    await f.workspace.guard(context(f, "turn", 4));
    expect(aux.generate).toHaveBeenCalledTimes(count);
  });
  it("does not move raw coverage after invalid historian output and does not retry every step", async () => {
    const aux = historian(undefined, "not-json");
    const f = await fixture(many(), { continuityModel: aux.model });
    await f.workspace.guard(context(f));
    f.workspace.observeUsage("turn", 0, 100000);
    await aux.entered.promise;
    await settled(f);
    expect(await f.conversation.contextRegions()).toHaveLength(0);
    expect(JSON.stringify(await f.workspace.guard(context(f, "turn", 1)))).toContain("历史0:");
    expect(aux.generate).toHaveBeenCalledTimes(1);
  });
  it("rejects fixed mandatory overflow without waiting for an impossible summary", async () => {
    const f = await fixture([], { config: { contextWindow: 10000, outputReserveTokens: 1000 } });
    await expect(f.workspace.guard(context(f, "turn", 0, [{ role: "assistant", content: "x".repeat(100000) }]))).rejects.toThrow("ContextBudgetExceeded");
  });
  it("limits a safety episode to sixty seconds, retains late commits without a late request", async () => {
    const block = latch();
    const aux = historian(block);
    const f = await fixture(many(), { continuityModel: aux.model, config: { contextWindow: 100000, outputReserveTokens: 1000 } });
    vi.useFakeTimers();
    const pending = f.workspace.guard(context(f));
    const outcome = pending.then(
      () => "accepted",
      (error: Error) => error.message,
    );
    await aux.entered.promise;
    await vi.advanceTimersByTimeAsync(59999);
    expect(f.workspace.status().historian).toBe("generating");
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("ContextBudgetExceeded");
    vi.useRealTimers();
    block.release();
    await settled(f);
    expect((await f.conversation.contextRegions()).length).toBeGreaterThan(0);
    expect(f.calls).toHaveLength(0);
  });
  it("does not reuse a later sample from the old view after ready coverage is adopted", async () => {
    const block = latch();
    const aux = historian(block);
    const f = await fixture(many(), { continuityModel: aux.model });
    await f.workspace.guard(context(f));
    f.workspace.observeUsage("turn", 0, 100000);
    await aux.entered.promise;
    await f.workspace.guard(context(f, "turn", 1));
    f.workspace.observeUsage("turn", 1, 100000);
    block.release();
    await settled(f);
    const calls = aux.generate.mock.calls.length;
    await f.workspace.guard(context(f, "turn", 2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(aux.generate).toHaveBeenCalledTimes(calls);
    expect(f.workspace.status().backgroundActive).toBe(false);
  });
  it("does not let event usage calibrate or trigger the following ordinary conversation", async () => {
    const aux = historian();
    const f = await fixture(many(), { continuityModel: aux.model });
    await f.workspace.guard(context(f, "event", 0, [], "event"));
    f.workspace.observeUsage("event", 0, 100000);
    expect(f.workspace.status().providerInputTokens).toBeUndefined();
    expect(f.workspace.status().estimateMultiplier).toBe(0.25);
    await f.workspace.guard(context(f, "ordinary"));
    expect(aux.generate).not.toHaveBeenCalled();
  });
  it("includes post-progress storage reads in the same sixty-second safety deadline", async () => {
    const block = latch();
    const aux = historian(block);
    const f = await fixture(many(), { continuityModel: aux.model, config: { contextWindow: 100000, outputReserveTokens: 1000 } });
    const readBlock = latch();
    const readEntered = latch();
    vi.useFakeTimers();
    const pending = f.workspace.guard(context(f));
    const outcome = pending.then(
      () => "accepted",
      (error: Error) => error.message,
    );
    await aux.entered.promise;
    const original = f.conversation.contextRegions.bind(f.conversation);
    vi.spyOn(f.conversation, "contextRegions").mockImplementationOnce(async () => {
      readEntered.release();
      await readBlock.promise;
      return original();
    });
    block.release();
    await readEntered.promise;
    await vi.advanceTimersByTimeAsync(60000);
    expect(await outcome).toBe("ContextBudgetExceeded");
    readBlock.release();
    vi.useRealTimers();
    await settled(f);
  });
  it("consumes a delayed source rejection when cancellation wins before the deadline wrapper attaches", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const blocked = latch();
    const finished = latch();
    vi.spyOn(f.conversation, "contextRegions").mockImplementationOnce(() => {
      controller.abort();
      return blocked.promise.then(() => {
        finished.release();
        throw new Error("late source failure");
      });
    });
    await expect(f.workspace.guard({ ...context(f), signal: controller.signal })).rejects.toThrow("ContextStopped");
    blocked.release();
    await finished.promise;
    // Let Node report an unhandled rejection if the started read was abandoned.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  it("stop invalidates an in-flight historian before it can commit", async () => {
    const block = latch();
    const aux = historian(block);
    const f = await fixture(many(), { continuityModel: aux.model });
    await f.workspace.guard(context(f));
    f.workspace.observeUsage("turn", 0, 100000);
    await aux.entered.promise;
    f.workspace.stop();
    block.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await f.conversation.contextRegions()).toHaveLength(0);
  });
  it("event-only neither injects normal regions nor starts work and denies context tools", async () => {
    const aux = historian();
    const f = await fixture(many(), { continuityModel: aux.model });
    const messages = await f.workspace.guard(context(f, "event", 0, [], "event"));
    f.workspace.observeUsage("event", 0, 100000);
    expect(messages).toHaveLength(1);
    expect(aux.generate).not.toHaveBeenCalled();
    await expect(f.workspace.blocks({})).rejects.toThrow("EventHistoryIsolated");
  });
  it("returns bounded bodies directly with stable paging, no page leases, and protects unsummarized raw", async () => {
    const f = await fixture(["🙂<&历史>".repeat(5000)]);
    await f.workspace.guard(context(f));
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    const first = await f.workspace.load({ blockId: id });
    expect(first.records.length).toBeGreaterThan(0);
    expect(first.records[0]!.text).toContain("<&历史>");
    expect(first).toMatchObject({ readonly: true, status: "historical-data" });
    expect(first.nextCursor).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThan(65000);
    const second = await f.workspace.load({ blockId: id, cursor: first.nextCursor });
    expect(second.pageId).not.toBe(first.pageId);
    await expect(f.workspace.load({ blockId: id, cursor: "forged" })).rejects.toThrow("InvalidCursor");
    expect(await f.workspace.release(id)).toMatchObject({ state: "held" });
    expect(await f.workspace.release(id)).toMatchObject({ alreadyReleased: true });
    expect(f.workspace.status().loadedBlocks).toBe(0);
    expect(JSON.stringify(await f.workspace.guard(context(f, "later")))).not.toContain("context_block");
  });
  it("bounds simultaneous expansions by one shared remaining request allowance", async () => {
    const f = await fixture(['\\"\\n'.repeat(8000), "other".repeat(4000)], { config: { contextWindow: 50000, outputReserveTokens: 1000 } });
    await f.workspace.guard(context(f, "turn", 0, [{ role: "assistant", content: "x".repeat(80000) }]));
    const blocks = (await f.workspace.blocks({})).blocks;
    const results = await Promise.allSettled(blocks.map((block) => f.workspace.load({ blockId: block.id })));
    const successful = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const available = f.workspace.status().inputBudget - f.workspace.status().estimatedInputTokens;
    expect(successful.length).toBeGreaterThan(0);
    expect(successful.reduce((sum, result) => sum + Buffer.byteLength(JSON.stringify(result), "utf8") * 0.25, 0)).toBeLessThanOrEqual(available);
  });
  it("reduces committed summaries at a request boundary without deleting source and expands them again", async () => {
    const aux = historian();
    const f = await fixture(many(), { continuityModel: aux.model });
    await f.workspace.guard(context(f));
    f.workspace.observeUsage("turn", 0, 100000);
    await aux.entered.promise;
    await settled(f);
    await f.workspace.guard(context(f, "turn", 1));
    const region = (await f.conversation.contextRegions())[0]!;
    expect(await f.workspace.release(region.id)).toMatchObject({ state: "pending" });
    const view = await f.workspace.guard(context(f, "turn", 2));
    expect(view.some((message) => String(message.content).includes(`source="${region.id}"`))).toBe(false);
    expect(await f.workspace.release(region.id)).toMatchObject({ state: "applied", alreadyReleased: true });
    const page = await f.workspace.load({ blockId: region.id });
    expect(JSON.stringify(page.records)).toContain("历史0:");
    expect((await f.conversation.contextRegions()).some((entry) => entry.id === region.id)).toBe(true);
  });
  it("does not revive a stopped workspace after delayed source reads", async () => {
    const f = await fixture();
    await f.workspace.guard(context(f));
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    const entered = latch();
    const blocked = latch();
    const original = f.conversation.contextSources.bind(f.conversation);
    vi.spyOn(f.conversation, "contextSources").mockImplementationOnce(async () => {
      entered.release();
      await blocked.promise;
      return original();
    });
    const pending = f.workspace.load({ blockId: id });
    await entered.promise;
    f.workspace.stop();
    blocked.release();
    await expect(pending).rejects.toThrow("StaleContextRead");
  });
  it("calibrates only a matching main request and updates output caps when the model limit changes", async () => {
    let limit = { context: 50000, output: 1000 };
    const f = await fixture(undefined, { modelLimit: limit, resolveModelLimit: () => limit });
    await f.workspace.guard(context(f));
    const estimate = f.workspace.status().estimatedInputTokens;
    f.workspace.observeUsage("other", 0, estimate * 2);
    expect(f.workspace.status().estimateMultiplier).toBe(0.25);
    f.workspace.observeUsage("turn", 0, estimate * 2);
    expect(f.workspace.status().estimateMultiplier).toBeCloseTo(0.5, 1);
    limit = { context: 40000, output: 500 };
    await f.workspace.guard(context(f, "changed"));
    expect(f.workspace.status()).toMatchObject({ contextWindow: 40000, outputReserveTokens: 500, estimateMultiplier: 0.25 });
  });
});

describe("real Agent provider boundary", () => {
  it("wires the actual Core Gemini pipeline, legacy summaries and single Magic controller", async () => {
    const f = await fixture(Array.from({ length: 100 }, (_, i) => `历史${i}:` + "x".repeat(600)));
    const channel = new Channel(
      { type: "guild", platform: "mock", channelId: "room", guildId: "room" },
      f.root,
      false,
      10000,
      { mode: "compartment", minMessages: 1, maxFailures: 3 },
      {},
      true,
    );
    await channel.conversation.init();
    await channel.conversation.storage.append(
      createEntry(
        "compact",
        {
          summary: "resident summary",
          mode: "compartment",
          compartmentId: "c1",
          lineageId: "c1",
          sourceSession: channel.conversation.currentSessionId(),
          firstEntryId: "old_0",
          lastEntryId: "old_49",
        },
        { id: "c1", timestamp: 101 },
      ),
    );
    const compact = vi.spyOn(channel.conversation, "compact");
    const scripted = mainModel([
      { name: "ctx_expand", input: () => '{"blockId":"c1"}', usage: 150001 },
      { name: "finish", input: () => "{}", usage: 150001 },
    ]);
    const aux = historian();
    const bot = { selfId: "bot", sendMessage: vi.fn() };
    const runtime = new ChannelRuntime(new Context(), {
      channel,
      bot: bot as never,
      will: { decide: async () => "trigger", observe: async () => {} } as never,
      model: scripted.model,
      compactModel: aux.model,
      readImagePolicy: { mode: "unavailable" },
      historyProjection: "gemini-native",
      config: Config({
        basePath: f.root,
        chatModel: "mock:main",
        logLevel: 0,
        modelRetries: 0,
        session: { compact: { mode: "compartment" }, archive: { maxKB: 0 }, magicContext: { enabled: true, contextWindow: 500000, outputReserveTokens: 1000 } },
      } as never),
      plugins: [
        {
          name: "mandatory-plugin",
          prepareStep(messages) {
            return [...messages, { role: "assistant", content: "PLUGIN mandatory" }];
          },
        },
      ],
    });
    try {
      await runtime.init();
      const result = await runtime.handle({
        platform: "mock",
        selfId: "bot",
        channel: { id: "room", type: 0 },
        user: { id: "u", name: "User" },
        messageId: "current",
        timestamp: 102,
        elements: [h.text("CURRENT new request")],
      });
      expect(result.kind).toBe("run");
      if (result.kind === "run") await result.done;
      expect(scripted.calls).toHaveLength(2);
      for (const request of scripted.calls) {
        expect(request.maxOutputTokens).toBe(1000);
        expect(JSON.stringify(request.prompt)).toContain("CURRENT new request");
        expect(JSON.stringify(request.prompt)).toContain("PLUGIN mandatory");
        expect(JSON.stringify(request.prompt)).toContain("resident summary");
        const start = request.prompt.findIndex((message) => message.role !== "system");
        expect(request.prompt.slice(start).some((message) => message.role === "system")).toBe(false);
        expect(request.tools?.filter((tool) => tool.type === "function" && tool.name === "ctx_expand")).toHaveLength(1);
      }
      expect(JSON.stringify(scripted.calls[1]!.prompt)).toContain("历史0:");
      expect(compact).not.toHaveBeenCalled();
      expect(bot.sendMessage).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
    }
  });
  it("returns safe tool bodies and preserves complete Gemini tool pairs in continuations", async () => {
    const f = await fixture(["older question"]);
    await f.conversation.storage.append(
      createEntry(
        "message",
        {
          id: "sent-call",
          timestamp: 2,
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "old-send", toolName: "send_message", input: { messages: ["older delivered reply"], inner_thought: "PRIVATE" } },
          ],
        },
        { id: "sent-call", timestamp: 2 },
      ),
      createEntry(
        "message",
        {
          id: "sent-result",
          timestamp: 3,
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "old-send",
              toolName: "send_message",
              output: { type: "json", value: { ok: true, count: 1, messageIds: ["platform-id"] } },
            },
          ],
        },
        { id: "sent-result", timestamp: 3 },
      ),
    );
    f.workspace.capture(await f.conversation.storage.read());
    await f.workspace.guard(context(f));
    const blockId = (await f.workspace.blocks({})).blocks[0]!.id;
    const scripted = mainModel([
      { name: "ctx_expand", input: () => JSON.stringify({ blockId }) },
      { name: "finish", input: () => "{}" },
    ]);
    const agent = createAgent({
      model: scripted.model,
      storage: f.conversation.storage,
      requestProjection: f.projection,
      beforeModelRequest: (request) => f.workspace.guard(request),
      onModelUsage: ({ turnId, stepNumber, inputTokens }) => f.workspace.observeUsage(turnId, stepNumber, inputTokens),
      tools: [...createContextWorkspaceTools(f.workspace), createFinishTool()],
      requireTerminalTool: true,
      plugins: [
        {
          name: "capture",
          enforce: "pre",
          transformEntries(entries) {
            f.workspace.capture(entries);
            return entries;
          },
        },
        createInternalHistoryProjectionPlugin("gemini-native", f.projection),
      ],
    });
    const events = await Array.fromAsync(agent.run(createUserMessage("current question")));
    expect(events.at(-1)).toMatchObject({ type: "turn.done" });
    expect(scripted.calls).toHaveLength(2);
    const continuation = scripted.calls[1]!.prompt;
    expect(JSON.stringify(continuation)).toContain("historical-data");
    expect(JSON.stringify(continuation)).toContain("older delivered reply");
    expect(JSON.stringify(continuation)).not.toContain("PRIVATE");
    const calls = continuation.flatMap((message) =>
      message.role === "assistant" ? message.content.filter((part) => part.type === "tool-call").map((part) => part.toolCallId) : [],
    );
    const results = continuation.flatMap((message) =>
      message.role === "tool" ? message.content.filter((part) => part.type === "tool-result").map((part) => part.toolCallId) : [],
    );
    expect(results).toEqual(calls);
    expect(calls).toContain("old-send");
    expect(calls).toContain("call_1");
    expect(JSON.stringify(await f.conversation.storage.read())).toContain("historical-data"); // bounded ordinary tool receipt, not a hidden second body cache
  });
  it("keeps default-provider delivered transcripts independently eligible and commits complete canonical tool units", async () => {
    const blocked = latch();
    const aux = historian(blocked);
    const f = await fixture([], { continuityModel: aux.model });
    for (let i = 0; i < 60; i++) {
      await f.conversation.storage.append(
        createEntry(
          "message",
          {
            id: `call_${i}`,
            timestamp: i * 2,
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: `send_${i}`, toolName: "send_message", input: { messages: [`reply ${i}:` + "x".repeat(7000)] } }],
          },
          { id: `source_call_${i}`, timestamp: i * 2 },
        ),
        createEntry(
          "message",
          {
            id: `result_${i}`,
            timestamp: i * 2 + 1,
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: `send_${i}`,
                toolName: "send_message",
                output: { type: "json", value: { ok: true, count: 1, messageIds: [`platform_${i}`] } },
              },
            ],
          },
          { id: `source_result_${i}`, timestamp: i * 2 + 1 },
        ),
      );
    }
    const scripted = mainModel([{ name: "finish", input: () => "{}", usage: 110000 }]);
    const agent = createAgent({
      model: scripted.model,
      storage: f.conversation.storage,
      requestProjection: f.projection,
      tools: [createFinishTool()],
      beforeModelRequest: (request) => f.workspace.guard(request),
      onModelUsage: ({ turnId, stepNumber, inputTokens }) => f.workspace.observeUsage(turnId, stepNumber, inputTokens),
      plugins: [
        {
          name: "capture",
          enforce: "pre",
          transformEntries(entries) {
            f.workspace.capture(entries);
          },
        },
        createInternalHistoryProjectionPlugin("default", f.projection),
        createModelInputPlugin("default", true),
      ],
    });
    expect((await Array.fromAsync(agent.run(createUserMessage("current")))).at(-1)).toMatchObject({ type: "turn.done" });
    await aux.entered.promise;
    expect(scripted.calls[0]!.prompt.filter((message) => message.role === "assistant").length).toBeGreaterThan(50);
    blocked.release();
    await settled(f);
    const region = (await f.conversation.contextRegions())[0]!;
    expect(region.data.sourceEntryIds).toContain("source_call_0");
    expect(region.data.sourceEntryIds).toContain("source_result_0");
  });
  it("projects archived region semantics after Magic is disabled without regenerating history", async () => {
    const f = await fixture(["archived raw goal"]);
    await f.conversation.commitContextRegion(await f.conversation.freezeContextRegion(["old_0"]), JSON.parse(draft));
    await f.conversation.archive(false);
    const channel = new Channel({ type: "guild", platform: "mock", channelId: "room", guildId: "room" }, f.root, false, 10000, {
      mode: "compartment",
      minMessages: 1,
      maxFailures: 3,
    });
    await channel.conversation.init();
    const scripted = mainModel([{ name: "finish", input: () => "{}" }]);
    const runtime = new ChannelRuntime(new Context(), {
      channel,
      bot: { selfId: "bot", sendMessage: vi.fn() } as never,
      will: { decide: async () => "trigger", observe: async () => {} } as never,
      model: scripted.model,
      readImagePolicy: { mode: "unavailable" },
      plugins: [],
      config: Config({
        basePath: f.root,
        chatModel: "mock:main",
        logLevel: 0,
        session: { compact: { mode: "compartment" }, archive: { maxKB: 0 }, magicContext: { enabled: false } },
      } as never),
    });
    try {
      await runtime.init();
      const result = await runtime.handle({
        platform: "mock",
        selfId: "bot",
        channel: { id: "room", type: 0 },
        user: { id: "u", name: "User" },
        messageId: "current",
        timestamp: 102,
        elements: [h.text("CURRENT request")],
      });
      if (result.kind === "run") await result.done;
      expect(scripted.calls).toHaveLength(1);
      expect(JSON.stringify(scripted.calls[0]!.prompt)).toContain("已确认目标和约束");
      expect(JSON.stringify(scripted.calls[0]!.prompt)).not.toContain("archived raw goal");
      expect(scripted.calls[0]!.maxOutputTokens).toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });
  it("keeps current input and system prefix when Gemini users merge after selection", async () => {
    const f = await fixture(
      Array.from({ length: 30 }, (_, index) => `历史${index}`),
      { mergeMessages: mergeAdjacentUserMessages },
    );
    const request = context(f);
    const system: ModelMessage = { role: "system", content: "protected" };
    const messages = await f.workspace.guard({ ...request, messages: [system, ...request.messages] });
    expect(messages[0]).toBe(system);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain("当前问题");
    expect(JSON.stringify(messages)).toContain("历史0");
  });
  it("does not count native media payload bytes as text capacity", async () => {
    const f = await fixture();
    const agent = createAgent({
      model: f.model,
      storage: f.conversation.storage,
      requestProjection: f.projection,
      beforeModelRequest: (request) => f.workspace.guard(request),
    });
    const events = await Array.fromAsync(agent.run(createUserMessage([{ type: "image", image: new Uint8Array(1000000), mediaType: "image/png" }])));
    expect(f.calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "turn.done" });
  });
  it("exposes one expand tool, retains old facade names and redacts filesystem failures", async () => {
    const f = await fixture();
    const tools = createContextWorkspaceTools(f.workspace);
    expect(tools.filter((tool) => tool.name === "ctx_expand")).toHaveLength(1);
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["ctx_search", "ctx_reduce", "ctx_blocks", "ctx_load", "ctx_release"]));
    vi.spyOn(f.workspace, "blocks").mockRejectedValue(new Error("ENOENT C:/private/token-source"));
    const result = await tools[0]!.execute!({}, {} as never);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result).toMatchObject({ ok: false, error: { code: "ContextReadFailed" } });
  });
});
