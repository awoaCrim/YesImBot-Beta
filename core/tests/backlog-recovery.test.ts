import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { Context, h } from "@koishijs/core";
import { AgentRequestProjection, createAgent, createEntry, createUserMessage, type AgentModelRequestContext } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));
import { Channel } from "../src/channels/index.js";
import { Config } from "../src/config.js";
import { createInternalHistoryProjectionPlugin } from "../src/conversations/internal-history.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import { ContextWorkspace } from "../src/runtimes/context-workspace.js";

const roots: string[] = [];
const workspaces: ContextWorkspace[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const workspace of workspaces.splice(0)) workspace.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}
const draft = JSON.stringify({ tiers: { P1: "Historical goals and constraints.", P2: "Goals and constraints.", P3: "Goals.", P4: "Goal." }, importance: 0.8 });
function historian(blocked?: ReturnType<typeof latch>, text = draft) {
  const entered = latch();
  const generate = vi.fn(async (_options: LanguageModelV3CallOptions) => {
    entered.release();
    await blocked?.promise;
    return {
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
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

async function fixture(count = 530, bytes = 4000, extra: Partial<ConstructorParameters<typeof ContextWorkspace>[2]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-backlog-"));
  roots.push(root);
  const channel = new Channel({ type: "guild", platform: "mock", channelId: "room", guildId: "room" }, root, false, 10000, { mode: "compartment" }, {}, true);
  const conversation = channel.conversation;
  await conversation.init();
  const entries = Array.from({ length: count }, (_, index) =>
    createEntry(
      "message",
      { id: `old_${index}`, role: "user", timestamp: index + 1, content: `HISTORY_${index}:` + "x".repeat(bytes) },
      { id: `old_${index}`, timestamp: index + 1 },
    ),
  );
  await conversation.storage.append(...entries);
  const projection = new AgentRequestProjection();
  const stream = vi.fn(async () => {
    throw new Error("unexpected main request");
  });
  const model: LanguageModelV3 = { specificationVersion: "v3", provider: "main", modelId: "main", supportedUrls: {}, doStream: stream, doGenerate: stream };
  const diagnostic = vi.fn();
  const workspace = new ContextWorkspace(conversation, projection, {
    config: { contextWindow: 147200, outputReserveTokens: 8192 },
    compactMode: "compartment",
    model,
    onDiagnostic: diagnostic,
    ...extra,
  });
  workspace.capture(entries);
  workspaces.push(workspace);
  return { channel, conversation, entries, projection, model, stream, diagnostic, workspace, root };
}

function context(f: Awaited<ReturnType<typeof fixture>>, turnId = "first", eventOnly = false): AgentModelRequestContext {
  const history: ModelMessage[] = f.entries.map((entry) => {
    const message: ModelMessage = { role: "user", content: entry.data.role === "user" ? String(entry.data.content) : "" };
    f.projection.register(message, { kind: "history", sourceEntryIds: [entry.id], timestamp: entry.timestamp });
    return message;
  });
  const live: ModelMessage = { role: "user", content: "CURRENT request" };
  f.projection.register(live, { kind: "live", sourceEntryIds: ["live"] });
  return {
    model: f.model,
    messages: eventOnly ? [live] : [...history, live],
    system: "system",
    tools: {},
    currentMessageIds: ["live"],
    projection: f.projection,
    historyMode: eventOnly ? "event" : "conversation",
    turnId,
    stepNumber: 0,
    signal: new AbortController().signal,
    rebuildMessages: async () => [],
  };
}

async function settled(f: Awaited<ReturnType<typeof fixture>>) {
  await vi.waitFor(() => expect(f.workspace.status().backgroundActive).toBe(false), { timeout: 30000 });
}

describe("frozen emergency backlog recovery", () => {
  it("drains a production-scale cold backlog beyond eight batches after one timeout without further input", async () => {
    const blocked = latch();
    const aux = historian(blocked);
    const f = await fixture(undefined, undefined, { continuityModel: aux.model });
    const freeze = vi.spyOn(f.conversation, "freezeContextRegion");
    vi.useFakeTimers();
    const outcome = f.workspace.guard(context(f)).then(
      () => "accepted",
      (error: Error) => error.message,
    );
    await aux.entered.promise;
    await vi.advanceTimersByTimeAsync(60000);
    expect(await outcome).toBe("ContextBudgetExceeded");
    expect(f.workspace.status().estimatedInputTokens).toBeGreaterThan(500000);
    expect(f.workspace.status().backgroundActive).toBe(true);
    f.workspace.finish({ turnId: "first" } as never);
    vi.useRealTimers();
    const late = createEntry("message", { id: "late", role: "user", content: "LATE unrelated input", timestamp: 10000 }, { id: "late", timestamp: 10000 });
    await f.conversation.storage.append(late);
    f.workspace.capture(await f.conversation.storage.read());
    await f.workspace.guard(context(f, "event-during-recovery", true));
    f.workspace.finish({ turnId: "event-during-recovery" } as never);
    blocked.release();
    await settled(f); // No guard, usage, message, or timer can fund another batch.
    expect(aux.generate.mock.calls.length).toBeGreaterThan(30);
    const sources = freeze.mock.calls.flatMap(([ids]) => [...ids]);
    expect(new Set(sources).size).toBe(sources.length);
    expect(sources).not.toContain("live");
    expect(sources).not.toContain("late");
    expect(JSON.stringify(await f.conversation.storage.read())).toContain("LATE unrelated input");
    const count = aux.generate.mock.calls.length;
    const next = await f.workspace.guard(context(f, "next"));
    expect(f.workspace.status().estimatedInputTokens).toBeLessThanOrEqual(124288);
    expect(JSON.stringify(next)).toContain("CURRENT request");
    expect(JSON.stringify(next)).toContain("HISTORY_529:");
    expect(aux.generate).toHaveBeenCalledTimes(count);
    expect(f.stream).not.toHaveBeenCalled();
  }, 30000);

  it("preserves the ordinary measured eight-batch cap when the soft target is unreachable", async () => {
    const aux = historian(
      undefined,
      JSON.stringify({ tiers: { P1: "A".repeat(16000), P2: "B".repeat(8000), P3: "C".repeat(4000), P4: "D".repeat(2000) }, importance: 1 }),
    );
    const f = await fixture(530, 4000, { continuityModel: aux.model, config: { contextWindow: 1000000, outputReserveTokens: 8192 } });
    await f.workspace.guard(context(f));
    f.workspace.observeUsage("first", 0, 800000);
    await aux.entered.promise;
    await settled(f);
    expect(aux.generate).toHaveBeenCalledTimes(8);
    await f.workspace.guard(context(f, "next"));
    expect(aux.generate).toHaveBeenCalledTimes(8);
  }, 30000);

  it("isolates unavailable source batches without retrying them or hiding their uncovered raw", async () => {
    const aux = historian();
    const f = await fixture(530, 4000, { continuityModel: aux.model });
    const original = f.conversation.freezeContextRegion.bind(f.conversation);
    const freeze = vi.spyOn(f.conversation, "freezeContextRegion").mockImplementation((ids) => {
      if (ids.includes("old_0")) return Promise.reject(new Error("ContextRegionSourceUnavailable"));
      return original(ids);
    });
    const result = await f.workspace.guard(context(f));
    await settled(f);
    expect(aux.generate.mock.calls.length).toBeGreaterThan(8);
    expect(freeze.mock.calls.filter(([ids]) => ids.includes("old_0"))).toHaveLength(1);
    expect(JSON.stringify(result)).toContain("HISTORY_0:");
    expect(JSON.stringify(result)).toContain("CURRENT request");
  }, 30000);

  it("summarizes a tool-heavy real Agent history using public source bytes without exposing private results", async () => {
    const aux = historian();
    const f = await fixture(0, 0, { continuityModel: aux.model });
    for (let index = 0; index < 40; index++) {
      await f.conversation.storage.append(
        createEntry(
          "message",
          { id: `public_${index}`, timestamp: index * 3, role: "user", content: `Public history ${index}` },
          { id: `public_${index}`, timestamp: index * 3 },
        ),
        createEntry(
          "message",
          {
            id: `call_${index}`,
            timestamp: index * 3 + 1,
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: `lookup_${index}`, toolName: "lookup", input: { query: "old lookup" } }],
          },
          { id: `call_${index}`, timestamp: index * 3 + 1 },
        ),
        createEntry(
          "message",
          {
            id: `result_${index}`,
            timestamp: index * 3 + 2,
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: `lookup_${index}`,
                toolName: "lookup",
                output: { type: "text", value: "PRIVATE_TOOL_BODY" + "x".repeat(60000) },
              },
            ],
          },
          { id: `result_${index}`, timestamp: index * 3 + 2 },
        ),
      );
    }
    const stream = vi.fn(async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "text" });
          controller.enqueue({ type: "text-delta", id: "text", delta: "done" });
          controller.enqueue({ type: "text-end", id: "text" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          });
          controller.close();
        },
      }),
    }));
    const agent = createAgent({
      model: { ...f.model, doStream: stream },
      storage: f.conversation.storage,
      requestProjection: f.projection,
      beforeModelRequest: (request) => f.workspace.guard(request),
      plugins: [
        {
          name: "capture",
          enforce: "pre",
          transformEntries: (entries) => {
            f.workspace.capture(entries);
          },
        },
        createInternalHistoryProjectionPlugin("default", f.projection),
      ],
    });
    const events = await Array.fromAsync(agent.run(createUserMessage("CURRENT request")));
    await settled(f);
    expect(events.at(-1)).toMatchObject({ type: "turn.done" });
    expect(stream).toHaveBeenCalledOnce();
    expect(aux.generate).toHaveBeenCalledOnce();
    const sourcePrompt = JSON.stringify(aux.generate.mock.calls[0]![0].prompt);
    expect(sourcePrompt).toContain("Public history");
    expect(sourcePrompt).not.toContain("PRIVATE_TOOL_BODY");
    expect((await f.conversation.contextRegions())[0]!.data.sourceEntryIds.length).toBeGreaterThan(100);
    expect(JSON.stringify(await f.conversation.storage.read())).toContain("PRIVATE_TOOL_BODY");
  }, 30000);

  it("defers automatic archive during timed-out recovery and runs it once recovery settles", async () => {
    const blocked = latch();
    const aux = historian(blocked);
    const f = await fixture();
    const archive = vi.spyOn(f.conversation, "archiveIfOversize");
    const runtime = new ChannelRuntime(new Context(), {
      channel: f.channel,
      bot: { selfId: "bot", sendMessage: vi.fn() } as never,
      will: { decide: vi.fn().mockResolvedValueOnce("trigger").mockResolvedValue("wait"), observe: vi.fn() } as never,
      model: f.model,
      compactModel: aux.model,
      readImagePolicy: { mode: "unavailable" },
      archiveMaxBytes: 1,
      config: Config({
        basePath: f.root,
        chatModel: "main:main",
        logLevel: 0,
        modelRetries: 0,
        session: { compact: { mode: "compartment" }, archive: { maxKB: 1 }, magicContext: { enabled: true, contextWindow: 147200, outputReserveTokens: 8192 } },
      } as never),
      plugins: [],
    });
    const record = (id: string) => ({
      platform: "mock",
      selfId: "bot",
      channel: { id: "room", type: 0 },
      user: { id: "u", name: "User" },
      messageId: id,
      timestamp: 10000,
      elements: [h.text(id)],
    });
    try {
      await runtime.init();
      vi.useFakeTimers();
      const started = await runtime.handle(record("initial-request"));
      expect(started.kind).toBe("run");
      await aux.entered.promise;
      const session = f.conversation.currentSessionId();
      archive.mockClear();
      await vi.advanceTimersByTimeAsync(60000);
      if (started.kind === "run") await started.done;
      await runtime.handle(record("late-during-recovery"));
      expect(archive).not.toHaveBeenCalled();
      expect(f.conversation.currentSessionId()).toBe(session);
      vi.useRealTimers();
      blocked.release();
      await vi.waitFor(() => expect(f.conversation.currentSessionId()).not.toBe(session), { timeout: 30000 });
      expect(archive).toHaveBeenCalledOnce();
      expect(aux.generate.mock.calls.length).toBeGreaterThan(8);
      expect(f.stream).not.toHaveBeenCalled();
      expect(JSON.stringify(await f.conversation.storage.read())).toContain("late-during-recovery");
    } finally {
      vi.useRealTimers();
      blocked.release();
      await runtime.stop();
    }
  }, 30000);

  it("preserves captured source costs when a model capacity change starts emergency recovery", async () => {
    let limit = { context: 1000000, output: 8192 };
    const aux = historian();
    const f = await fixture(undefined, undefined, {
      continuityModel: aux.model,
      config: { contextWindow: 1000000, outputReserveTokens: 8192 },
      resolveModelLimit: () => limit,
    });
    await f.workspace.guard(context(f));
    expect(aux.generate).not.toHaveBeenCalled();
    limit = { context: 147200, output: 8192 };
    await f.workspace.guard(context(f, "smaller-model"));
    await settled(f);
    expect(aux.generate.mock.calls.length).toBeGreaterThan(8);
    expect(f.workspace.status().estimatedInputTokens).toBeLessThanOrEqual(124288);
  }, 30000);

  it("isolates explicit archive from an old in-flight recovery without publishing or scheduling maintenance", async () => {
    const blocked = latch();
    const aux = historian(blocked);
    const maintenance = vi.fn();
    const f = await fixture(undefined, undefined, { continuityModel: aux.model, onBackgroundSettled: maintenance });
    const session = f.conversation.currentSessionId();
    const outcome = f.workspace.guard(context(f)).catch((cause: Error) => cause.message);
    await aux.entered.promise;
    await f.conversation.archive(true);
    blocked.release();
    expect(await outcome).toBe("StaleContextRead");
    expect(await f.conversation.contextRegions()).toHaveLength(0);
    expect(maintenance).not.toHaveBeenCalled();
    await f.conversation.switch(session);
    expect(await f.conversation.contextRegions()).toHaveLength(0);
    expect(aux.generate).toHaveBeenCalledOnce();
  }, 30000);

  it("backs off systemic generation failures instead of trying every remaining cohort", async () => {
    const aux = historian(undefined, "invalid JSON");
    const f = await fixture(undefined, undefined, { continuityModel: aux.model });
    await expect(f.workspace.guard(context(f))).rejects.toThrow("ContextBudgetExceeded");
    await settled(f);
    await expect(f.workspace.guard(context(f, "retry"))).rejects.toThrow("ContextBudgetExceeded");
    expect(aux.generate).toHaveBeenCalledOnce();
    expect(f.workspace.status()).toMatchObject({ historian: "failed", backgroundActive: false });
    expect(await f.conversation.contextRegions()).toHaveLength(0);
    expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ event: "guard.estimate", reason: "unresolved-unsafe" }));
  });
});
