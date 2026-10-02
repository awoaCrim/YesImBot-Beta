import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { Context, h } from "@koishijs/core";
import { AgentRequestProjection, createAgent, createEntry, createUserMessage, type AgentModelRequestContext, type TurnResult } from "@yesimbot/agent-runtime";
import { jsonSchema, type ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));
import { createContextWorkspaceTools, createFinishTool } from "../src/agents/tools.js";
import { Channel } from "../src/channels/index.js";
import { Config } from "../src/config.js";
import { Conversation } from "../src/conversations/index.js";
import { ChannelRuntime, mergeAdjacentUserMessages } from "../src/runtimes/channel.js";
import { ContextWorkspace } from "../src/runtimes/context-workspace.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function modelWithScript(script: readonly { toolName: string; input: () => string }[] = []) {
  const calls: LanguageModelV3CallOptions[] = [];
  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "mock",
    modelId: "model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("unused");
    },
    async doStream(options) {
      const action = script[calls.length];
      calls.push(structuredClone(options));
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (action) controller.enqueue({ type: "tool-call", toolCallId: `call_${calls.length}`, toolName: action.toolName, input: action.input() });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: action ? "tool-calls" : "stop", raw: undefined },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            });
            controller.close();
          },
        }),
      };
    },
  };
  return { model, calls };
}

function modelWithText(text: string): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "mock-continuity",
    modelId: "continuity",
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    },
    async doStream() {
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "continuity-text" });
            controller.enqueue({ type: "text-delta", id: "continuity-text", delta: text });
            controller.enqueue({ type: "text-end", id: "continuity-text" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            });
            controller.close();
          },
        }),
      };
    },
  };
}

async function fixture(texts = ["已结束的历史原文"], extra: Partial<ConstructorParameters<typeof ContextWorkspace>[2]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-workspace-"));
  roots.push(root);
  const conversation = new Conversation(root, { minMessages: 1, maxFailures: 3, mode: "compartment" });
  await conversation.init();
  const entries = texts.map((text, index) =>
    createEntry("message", { id: `old_${index}`, timestamp: index + 1, role: "user", content: text }, { id: `old_${index}`, timestamp: index + 1 }),
  );
  await conversation.storage.append(...entries);
  const projection = new AgentRequestProjection();
  const { model, calls } = modelWithScript();
  const workspace = new ContextWorkspace(conversation, projection, {
    config: { contextWindow: 50_000, outputReserveTokens: 1000 },
    compactMode: "compartment",
    model,
    ...extra,
  });
  workspace.capture(entries);
  return { conversation, entries, projection, model, calls, workspace };
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
    const message: ModelMessage = { role: "user", content: entry.type === "message" && entry.data.role === "user" ? String(entry.data.content) : "" };
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
const done = (turnId: string, status: "done" | "failed" = "done") => ({ turnId, status }) as TurnResult;
const loadedBody = (messages: readonly ModelMessage[]) =>
  messages
    .filter((message) => typeof message.content === "string" && message.content.includes("<context_block"))
    .map((message) => String(message.content))
    .join("\n");

// These use real JSONL Conversation sources but never contact an external provider.
describe("context workspace", () => {
  it("loads without a summary, returns metadata only, deduplicates a page and releases idempotently", async () => {
    const f = await fixture();
    await f.workspace.guard(context(f));
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    const first = await f.workspace.load({ blockId: id });
    expect(JSON.stringify(first)).not.toContain("已结束的历史原文");
    expect((await f.workspace.load({ blockId: id })).pageId).toBe(first.pageId);
    const messages = await f.workspace.guard(context(f, "turn", 1));
    expect(loadedBody(messages)).toContain("已结束的历史原文");
    expect(messages.filter((message) => String(message.content).includes("已结束的历史原文"))).toHaveLength(1);
    expect(await f.workspace.release(id)).toMatchObject({ released: true });
    expect(await f.workspace.release(id)).toMatchObject({ alreadyReleased: true });
    expect(loadedBody(await f.workspace.guard(context(f, "turn", 2)))).toBe("");
    expect((await f.workspace.blocks({})).blocks[0]).toMatchObject({ state: "released" });
  });
  it("replaces the old page with its continuation, safely escaping historical instruction text", async () => {
    const text = "🙂<&历史>".repeat(1000);
    const f = await fixture([text]);
    await f.workspace.guard(context(f));
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    const first = await f.workspace.load({ blockId: id });
    expect(first.nextCursor).toBeDefined();
    const body = loadedBody(await f.workspace.guard(context(f, "turn", 1)));
    expect(body).toContain("&lt;&amp;历史&gt;");
    const second = await f.workspace.load({ blockId: id, cursor: first.nextCursor });
    expect(second.pageId).not.toBe(first.pageId);
    expect(f.workspace.status().loadedBlocks).toBe(1);
    expect(loadedBody(await f.workspace.guard(context(f, "turn", 2)))).not.toBe(body);
  });
  it("retains current plus two later normal turns, while event-only neither injects nor ages pages", async () => {
    const f = await fixture();
    await f.workspace.guard(context(f));
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    await f.workspace.load({ blockId: id });
    f.workspace.finish(done("turn"));
    expect(loadedBody(await f.workspace.guard(context(f, "event", 0, [], "event")))).toBe("");
    await expect(f.workspace.load({ blockId: id })).rejects.toThrow("EventHistoryIsolated");
    f.workspace.finish(done("event"));
    for (const turn of ["next1", "next2"]) {
      expect(loadedBody(await f.workspace.guard(context(f, turn)))).not.toBe("");
      f.workspace.finish(done(turn));
    }
    expect(loadedBody(await f.workspace.guard(context(f, "next3")))).toBe("");
    expect((await f.workspace.blocks({})).blocks[0]).toMatchObject({ state: "expired" });
  });
  it("evicts least recently used pages at four blocks and under request pressure", async () => {
    const f = await fixture(Array.from({ length: 5 }, (_, i) => `原文${i}`));
    await f.workspace.guard(context(f));
    const ids = (await f.workspace.blocks({})).blocks.map((block) => block.id);
    for (const id of ids) await f.workspace.load({ blockId: id });
    expect(f.workspace.status().loadedBlocks).toBe(4);
    expect((await f.workspace.blocks({})).blocks.find((block) => block.id === ids[0])).toMatchObject({ state: "evicted" });
    const extra: ModelMessage = { role: "assistant", content: "x".repeat(42_300) };
    await f.workspace.guard(context(f, "turn", 1, [extra]));
    expect(f.workspace.status().loadedBlocks).toBeLessThan(4);
  });
  it("automatically persists and injects a read-only continuity card before evicting old history", async () => {
    const f = await fixture(
      Array.from({ length: 30 }, (_, index) => `历史${index}:` + "x".repeat(1800)),
      {
        continuityModel: modelWithText(
          JSON.stringify({
            goal: "保持长期任务目标",
            decisions: ["使用结构化连续性"],
            constraints: ["只读历史资料"],
            facts: ["来源可核对"],
            unresolved: ["仍有问题待处理"],
            completed: ["已保存历史窗口"],
            pending: ["继续下一轮"],
          }),
        ),
      },
    );
    const messages = await f.workspace.guard(context(f));
    const continuity = (await f.conversation.storage.read()).filter((entry) => entry.type === "continuity");
    expect(continuity).toHaveLength(1);
    expect(messages.some((message) => String(message.content).includes("<continuity_state"))).toBe(true);
    expect(JSON.stringify(messages)).toContain("historical-data");
    expect(JSON.stringify(messages)).not.toContain("sourceEntryIds");
    expect(f.workspace.status().loadedBlocks).toBe(0);
  });

  it("keeps a loaded page resident when continuity admission fails", async () => {
    const f = await fixture(["需要保留的原文".repeat(500)], {
      continuityModel: modelWithText("not-json"),
    });
    await f.workspace.guard(context(f));
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    await f.workspace.load({ blockId: id });

    const oversized: ModelMessage = { role: "assistant", content: "x".repeat(43_500) };
    await expect(f.workspace.guard(context(f, "pressure", 1, [oversized]))).rejects.toThrow("ContextContinuityUnavailable");
    expect(f.workspace.status().loadedBlocks).toBe(1);
  });

  it("uses matching provider usage as the calibration source in either direction", async () => {
    const f = await fixture();
    await f.workspace.guard(context(f));
    const raw = f.workspace.status().estimatedInputTokens;
    f.workspace.observeUsage("other", 0, raw * 3);
    expect(f.workspace.status().estimateMultiplier).toBe(1);
    f.workspace.observeUsage("turn", 0, raw / 2);
    expect(f.workspace.status().estimateMultiplier).toBeCloseTo(0.5);
    expect(f.workspace.status().providerInputTokens).toBe(raw / 2);
  });
  it("restores the latest provider usage from persisted assistant history", async () => {
    const f = await fixture();
    const measured = createEntry(
      "message",
      {
        id: "measured",
        timestamp: 10,
        role: "assistant",
        content: "measured response",
        usage: { inputTokens: 1234 },
      } as never,
      { id: "measured", timestamp: 10 },
    );
    f.workspace.capture([...f.entries, measured]);
    expect(f.workspace.status().providerInputTokens).toBe(1234);
  });
  it("does not reject a provider request solely because the local estimate overflows", async () => {
    const f = await fixture();
    const oversized: ModelMessage = { role: "assistant", content: "x".repeat(60_000) };
    const messages = await f.workspace.guard(context(f, "turn", 0, [oversized]));
    expect(messages).toContain(oversized);
    expect(f.workspace.status().estimatedInputTokens).toBeGreaterThan(f.workspace.status().inputBudget);
  });
  it("restart rebuilds the catalogue but not bodies; empty archive and failures clear residency", async () => {
    const f = await fixture();
    await f.workspace.guard(context(f));
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    await f.workspace.load({ blockId: id });
    const restart = new ContextWorkspace(f.conversation, f.projection, {
      config: { contextWindow: 50_000, outputReserveTokens: 1000 },
      compactMode: "compartment",
      model: f.model,
    });
    restart.capture(f.entries);
    await restart.guard(context(f));
    expect((await restart.blocks({})).blocks).toHaveLength(1);
    expect(restart.status().loadedBlocks).toBe(0);
    f.workspace.finish(done("turn", "failed"));
    expect(f.workspace.status().loadedBlocks).toBe(0);
    await f.workspace.guard(context(f, "second"));
    await f.workspace.load({ blockId: id });
    await f.conversation.archive(true);
    f.workspace.capture([]);
    expect((await f.workspace.blocks({})).blocks).toHaveLength(0);
    expect(f.workspace.status().loadedBlocks).toBe(0);
  });
  it("clears pages even when a failed turn never reached the guard", async () => {
    const f = await fixture();
    await f.workspace.guard(context(f));
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    await f.workspace.load({ blockId: id });
    f.workspace.finish(done("turn"));
    expect(f.workspace.status().loadedBlocks).toBe(1);
    f.workspace.finish(done("failed-before-guard", "failed"));
    expect(f.workspace.status().loadedBlocks).toBe(0);
  });
  it("does not revive a stopped cache after a delayed disk read", async () => {
    const f = await fixture();
    await f.workspace.guard(context(f));
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    const original = f.conversation.contextSources.bind(f.conversation);
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(f.conversation, "contextSources").mockImplementation(async () => {
      entered();
      await blocked;
      return original();
    });
    const pending = f.workspace.load({ blockId: id });
    await ready;
    f.workspace.stop();
    release();
    await expect(pending).rejects.toThrow("StaleContextRead");
    expect(f.workspace.status().loadedBlocks).toBe(0);
  });
  it("invalidates a delayed read on archive and restores only the target catalogue after switching back", async () => {
    const f = await fixture();
    await f.workspace.guard(context(f));
    const session = f.conversation.currentSessionId();
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    const original = f.conversation.contextSources.bind(f.conversation);
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(f.conversation, "contextSources").mockImplementationOnce(async () => {
      const snapshot = await original();
      entered();
      await blocked;
      return snapshot;
    });
    const pending = f.workspace.load({ blockId: id });
    await ready;
    await f.conversation.archive(true);
    release();
    await expect(pending).rejects.toThrow("StaleContextRead");
    expect(f.workspace.status().loadedBlocks).toBe(0);
    spy.mockRestore();
    f.workspace.capture([]);
    await f.workspace.guard(context(f, "empty"));
    expect((await f.workspace.blocks({})).blocks).toEqual([]);
    await f.conversation.switch(session);
    f.workspace.capture(f.entries);
    await f.workspace.guard(context(f, "switched"));
    expect((await f.workspace.blocks({})).blocks).toHaveLength(1);
    expect(f.workspace.status().loadedBlocks).toBe(0);
  });
  it("keeps same-session compacted raw pages addressable and their residency/release status visible", async () => {
    const f = await fixture(["long raw history".repeat(400)]);
    await f.workspace.guard(context(f));
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    const page = await f.workspace.load({ blockId: id });
    expect(page.nextCursor).toBeDefined();
    const compact = createEntry(
      "compact",
      {
        summary: "now summarized",
        mode: "compartment",
        compartmentId: "c1",
        lineageId: "c1",
        sourceSession: f.conversation.currentSessionId(),
        firstEntryId: "old_0",
        lastEntryId: "old_0",
      },
      { id: "c1", timestamp: 2 },
    );
    await f.conversation.storage.append(compact);
    f.workspace.capture([...f.entries, compact]);
    await f.workspace.guard(context(f, "turn", 1));
    const catalogue = await f.workspace.blocks({});
    expect(catalogue.blocks.some((block) => block.id === id)).toBe(false);
    expect(catalogue.loadedPages).toEqual([expect.objectContaining({ blockId: id })]);
    await f.workspace.load({ blockId: id, cursor: page.nextCursor });
    await f.workspace.release(id);
    expect((await f.workspace.blocks({})).recentStates).toContainEqual({ blockId: id, state: "released" });
  });
  it("rebuilds the view on actual model limit changes and clamps the output cap", async () => {
    let limit = { context: 50_000, output: 1000 };
    const f = await fixture(undefined, { modelLimit: limit, resolveModelLimit: () => limit });
    await f.workspace.guard(context(f));
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    await f.workspace.load({ blockId: id });
    limit = { context: 40_000, output: 500 };
    await f.workspace.guard(context(f, "changed"));
    expect(f.workspace.status()).toMatchObject({ contextWindow: 40_000, outputReserveTokens: 500, loadedBlocks: 0, estimateMultiplier: 1 });
    expect(f.workspace.outputLimit(f.model)).toBe(500);
  });
  it("keeps escaped content under page budget and an unsuccessful replacement leaves the existing page intact", async () => {
    const f = await fixture(["<&>".repeat(3000)]);
    await f.workspace.guard(context(f));
    const id = (await f.workspace.blocks({})).blocks[0]!.id;
    const loaded = await f.workspace.load({ blockId: id });
    expect(loaded.estimatedTokens).toBeLessThanOrEqual(4096);
    await expect(f.workspace.load({ blockId: id, cursor: "forged" })).rejects.toThrow("InvalidCursor");
    expect(f.workspace.status().loadedBlocks).toBe(1);
  });
});

describe("real AgentRuntime provider boundary", () => {
  it("runs the actual Core capture/summary/internal/Gemini pipeline with all system content before dialogue", async () => {
    const f = await fixture(Array.from({ length: 100 }, (_, i) => `历史${i}:` + "x".repeat(600)));
    const channel = new Channel({ type: "guild", platform: "mock", channelId: "room", guildId: "room" }, f.conversation.root, false, 10_000, {
      mode: "compartment",
      minMessages: 1,
      maxFailures: 3,
    });
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
    const scripted = modelWithScript([
      { toolName: "ctx_load", input: () => '{"blockId":"c1"}' },
      { toolName: "ctx_release", input: () => '{"blockId":"c1"}' },
      { toolName: "finish", input: () => "{}" },
    ]);
    const bot = { selfId: "bot", sendMessage: vi.fn() };
    const runtime = new ChannelRuntime(new Context(), {
      channel,
      bot: bot as never,
      will: { decide: async () => "trigger", observe: async () => {} } as never,
      model: scripted.model,
      compactModel: modelWithText(
        JSON.stringify({
          goal: "保留历史目标",
          decisions: ["继续当前任务"],
          constraints: ["遵守来源边界"],
          facts: ["历史请求包含已确认事实"],
          unresolved: ["仍需核对原文"],
          completed: ["已保存连续性卡片"],
          pending: ["等待下一步请求"],
        }),
      ),
      readImagePolicy: { mode: "unavailable" },
      historyProjection: "gemini-native",
      config: Config({
        basePath: f.conversation.root,
        chatModel: "mock:model",
        logLevel: 0,
        modelRetries: 0,
        session: { compact: { mode: "compartment" }, archive: { maxKB: 0 }, magicContext: { enabled: true, contextWindow: 50_000, outputReserveTokens: 1000 } },
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
      expect(scripted.calls).toHaveLength(3);
      for (const request of scripted.calls) {
        expect(request.maxOutputTokens).toBe(1000);
        expect(JSON.stringify(request.prompt)).toContain("CURRENT new request");
        expect(JSON.stringify(request.prompt)).toContain("PLUGIN mandatory");
        expect(JSON.stringify(request.prompt)).toContain("resident summary");
        const start = request.prompt.findIndex((message) => message.role !== "system");
        expect(request.prompt.slice(start).some((message) => message.role === "system")).toBe(false);
        expect(JSON.stringify(request)).not.toContain("sourceEntryIds");
      }
      expect(JSON.stringify(scripted.calls[1]!.prompt)).toContain("context_block");
      expect(JSON.stringify(scripted.calls[1]!.prompt)).toContain("历史0:");
      expect(JSON.stringify(scripted.calls[2]!.prompt)).not.toContain("context_block");
      expect(bot.sendMessage).not.toHaveBeenCalled();
      expect(JSON.stringify(await channel.conversation.storage.read())).not.toContain("context_block");
    } finally {
      await runtime.stop();
    }
  });
  it("checks the first request, tools and every continuation; ctx_load body is request-only, ctx_release removes it", async () => {
    const f = await fixture(Array.from({ length: 100 }, (_, i) => `历史${i}:` + "x".repeat(600)));
    let id = "";
    const scripted = modelWithScript([
      { toolName: "ctx_load", input: () => JSON.stringify({ blockId: id }) },
      { toolName: "ctx_release", input: () => JSON.stringify({ blockId: id }) },
      { toolName: "finish", input: () => "{}" },
    ]);
    f.model = scripted.model;
    const guard = vi.fn((request: AgentModelRequestContext) => f.workspace.guard(request));
    const agent = createAgent({
      model: scripted.model,
      storage: f.conversation.storage,
      requestProjection: f.projection,
      tools: [...createContextWorkspaceTools(f.workspace), createFinishTool()],
      requireTerminalTool: true,
      maxOutputTokens: (model) => f.workspace.outputLimit(model),
      beforeModelRequest: guard,
      plugins: [
        {
          name: "capture",
          transformEntries(entries) {
            f.workspace.capture(entries);
            return entries;
          },
          onTurnFinish(result) {
            f.workspace.finish(result);
          },
        },
      ],
    });
    await f.workspace.guard(context(f));
    id = (await f.workspace.blocks({})).blocks[0]!.id;
    const events = await Array.fromAsync(agent.run(createUserMessage("新请求")));
    expect(events.at(-1)).toMatchObject({ type: "turn.done" });
    expect(scripted.calls).toHaveLength(3);
    expect(guard).toHaveBeenCalledTimes(3);
    for (const request of scripted.calls) {
      expect(request.maxOutputTokens).toBe(1000);
      expect(JSON.stringify(request.prompt)).toContain("新请求");
      expect(JSON.stringify(request)).not.toContain("sourceEntryIds");
    }
    expect(JSON.stringify(scripted.calls[0]!.prompt)).not.toContain("历史0:");
    expect(JSON.stringify(scripted.calls[1]!.prompt)).toContain("context_block");
    expect(JSON.stringify(scripted.calls[2]!.prompt)).not.toContain("context_block");
    expect(JSON.stringify(scripted.calls[1]!.prompt)).toContain("call_1");
    expect(JSON.stringify(scripted.calls[2]!.prompt)).toContain("call_2");
    const entries = await agent.storage.read();
    const results = entries.filter((entry) => entry.type === "message" && entry.data.role === "tool");
    expect(JSON.stringify(results)).not.toContain("context_block");
    expect(f.workspace.status().estimatedInputTokens).toBeLessThanOrEqual(f.workspace.status().inputBudget);
  });
  it.each(["current", "plugin", "schema"])("lets the provider measure %s estimate overflow", async (source) => {
    const f = await fixture();
    const agent = createAgent({
      model: f.model,
      storage: f.conversation.storage,
      requestProjection: f.projection,
      beforeModelRequest: (request) => f.workspace.guard(request),
      tools:
        source === "schema"
          ? [{ name: "large", description: "x".repeat(50_000), inputSchema: jsonSchema({ type: "object", properties: {} }), execute: () => ({}) }]
          : [],
      plugins:
        source === "plugin"
          ? [
              {
                name: "untracked",
                prepareStep(messages) {
                  return [...messages, { role: "assistant", content: "x".repeat(50_000) }];
                },
              },
            ]
          : [],
    });
    const events = await Array.fromAsync(agent.run(createUserMessage(source === "current" ? "x".repeat(50_000) : "current")));
    expect(f.calls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "turn.done" });
    expect(JSON.stringify(events)).not.toContain("ContextBudgetExceeded");
  });
  it("passes image input without a local media budget restriction", async () => {
    const f = await fixture();
    const agent = createAgent({
      model: f.model,
      storage: f.conversation.storage,
      requestProjection: f.projection,
      beforeModelRequest: (request) => f.workspace.guard(request),
    });
    const events = await Array.fromAsync(agent.run(createUserMessage([{ type: "image", image: new Uint8Array([1]), mediaType: "image/png" }])));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.prompt).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user" })]));
    expect(events.at(-1)).toMatchObject({ type: "turn.done" });
  });
  it("applies Gemini merge only after selection, preserving the current input and system prefix", async () => {
    const f = await fixture(
      Array.from({ length: 30 }, (_, i) => `历史${i}`),
      { mergeMessages: mergeAdjacentUserMessages },
    );
    const request = context(f);
    const system: ModelMessage = { role: "system", content: "protected" };
    const messages = await f.workspace.guard({ ...request, messages: [system, ...request.messages] });
    expect(messages[0]).toBe(system);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain("当前问题");
    expect(JSON.stringify(messages)).not.toContain("历史0");
  });
  it("redacts unexpected filesystem errors from tool receipts", async () => {
    const f = await fixture();
    vi.spyOn(f.workspace, "blocks").mockRejectedValue(new Error("ENOENT C:/private/token-source"));
    const result = await createContextWorkspaceTools(f.workspace)[0]!.execute!({}, {} as never);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result).toMatchObject({ ok: false, error: { code: "ContextReadFailed" } });
  });
});
