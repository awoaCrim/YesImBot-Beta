import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Bot, Context } from "@koishijs/core";
import type { ToolSet } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  active: null as string | null,
  append: vi.fn(),
  send: vi.fn(),
  run: vi.fn(),
  decide: vi.fn(),
  decideBatch: vi.fn(),
  settleReservation: vi.fn(),
  observe: vi.fn(),
  wait: vi.fn(() => Promise.resolve()),
}));

vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("@yesimbot/agent-runtime", async (original) => {
  const actual = await original<typeof import("@yesimbot/agent-runtime")>();
  return {
    ...actual,
    createAgent: vi.fn(() => ({
      init: vi.fn(),
      append: state.append,
      send: state.send,
      run: state.run,
      getActiveTurnId: () => state.active,
      wait: state.wait,
      interrupt: vi.fn(),
      stop: vi.fn(),
      isIdle: () => state.active === null,
    })),
  };
});

import { createAgent, createEntry, EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";

import { Agents } from "../src/agents/index.js";
import { PolisherRegistry, type MessagePolisherCapability } from "../src/agents/polisher.js";
import { Channel, Channels, type ChannelContext } from "../src/channels/index.js";
import type { Config } from "../src/config.js";
import { createDeliveredTranscriptMessage } from "../src/conversations/delivered-transcript.js";
import { MessageBatchRegistry, type MessageBatchInput, type MessageBatchPlugin } from "../src/message-batches/index.js";
import { createMessage, type Event, type MessageRecord } from "../src/messages/index.js";
import { ChannelRuntime, type ChannelRuntimeOptions } from "../src/runtimes/channel.js";
import { resolveReadImagePolicy, Runtimes } from "../src/runtimes/index.js";

const config: Config = {
  basePath: "/tmp",
  chatModel: "test:model",
  auxiliaryModel: undefined,
  visionModel: undefined,
  logLevel: 2,
  allowedChannels: [],
  imageInput: false,
  modelRetries: 0,
  resourceReadTimeout: 1,
  pacing: { charactersPerSecond: 1, maxTotalDelayMs: 1 },
  customInnerThought: true,
  session: {
    compact: {
      responseIdleMinutes: 0,
      checkIntervalMinutes: 30,
      turnThreshold: 50,
      minMessages: 1,
      maxFailures: 1,
      inlineFragments: 3,
      model: undefined,
    },
    archive: { maxKB: 0 },
  },
};

const event = {
  eventType: "delivery.failed",
  platform: "test",
  selfId: "bot",
  timestamp: 1,
  channel: { id: "room", type: 0 },
  text: "failure",
  delivery: { turnId: "t", messageId: "m", segmentIndex: 0, segmentTotal: 1, error: { name: "Error", message: "x" } },
} as const;

const pokeEvent = {
  eventType: "notice.poke",
  platform: "test",
  selfId: "bot",
  timestamp: 2,
  channel: { id: "room", type: 0 },
  text: "typed poke",
  actorId: "user-2",
  targetId: "bot",
  action: "拍了拍",
} as never;

function message(messageId: string, userId: string, timestamp: number): MessageRecord {
  return {
    platform: "test",
    selfId: "bot",
    timestamp,
    channel: { id: "room", type: 0 },
    user: { id: userId, name: userId },
    messageId,
    elements: [],
  };
}

function batchPlugin(options: { acceptEvents?: boolean } = {}) {
  let flush: ((messages: readonly import("../src/messages/index.js").Message[]) => Promise<void>) | undefined;
  let flushInputs: ((inputs: readonly MessageBatchInput[]) => Promise<void>) | undefined;
  const queuedEvents: Event[] = [];
  const controller = {
    enqueue: vi.fn(),
    enqueueEvent: options.acceptEvents
      ? vi.fn((input: Event) => {
          queuedEvents.push(input);
          return true;
        })
      : undefined,
    stop: vi.fn(),
  };
  const plugin: MessageBatchPlugin = {
    priority: 0,
    match: () => true,
    setup: vi.fn(async (_context, callback, extensions) => {
      flush = callback;
      flushInputs = extensions?.flushInputs;
      return controller;
    }),
  };
  return {
    controller,
    plugin,
    queuedEvents,
    flush: (messages: readonly import("../src/messages/index.js").Message[]) => flush!(messages),
    flushInputs: (inputs: readonly MessageBatchInput[]) => flushInputs!(inputs),
  };
}

// ---------------------------------------------------------------------------
// Read image routing
// ---------------------------------------------------------------------------

describe("read image routing", () => {
  const primary = (imageInput: boolean, imageToolResult: "native" | "unsupported" | "unknown") =>
    ({
      entry: { modalities: imageInput ? { input: ["image"] } : undefined },
      capabilities: { imageToolResult },
      model: { id: "primary" },
    }) as never;
  const vision = () => ({ entry: { modalities: { input: ["image"] } }, model: { id: "vision" } }) as never;

  it("uses native projection only when config, model, and transport all allow it", () => {
    expect(resolveReadImagePolicy(primary(true, "native"), vision(), true)).toMatchObject({ mode: "native" });
  });

  it.each(["unsupported", "unknown"] as const)("uses vision fallback for %s transports", (capability) => {
    expect(resolveReadImagePolicy(primary(true, capability), vision(), true)).toMatchObject({ mode: "vision", visionModel: { id: "vision" } });
  });

  it("uses vision fallback when direct image input is disabled", () => {
    expect(resolveReadImagePolicy(primary(true, "native"), vision(), false)).toMatchObject({ mode: "vision", visionModel: { id: "vision" } });
  });

  it("fails closed when neither native projection nor vision is available", () => {
    expect(resolveReadImagePolicy(primary(true, "unknown"), undefined, true)).toEqual({ mode: "unavailable" });
  });
});

// ---------------------------------------------------------------------------
// ChannelRuntime scheduling
// ---------------------------------------------------------------------------

async function runtime(
  providerTools?: ToolSet,
  configOverrides: Partial<Config> = {},
  bot: { selfId: string; sendMessage: unknown } = { selfId: "bot", sendMessage: vi.fn() },
  context: ChannelContext = { type: "guild", platform: "test", channelId: "room", guildId: "room" },
  messageBatch?: MessageBatchPlugin,
  will: Record<string, unknown> = { decide: state.decide, observe: state.observe },
  polisher?: MessagePolisherCapability,
  polish?: ChannelRuntimeOptions["polish"],
  compactFragments?: ChannelRuntimeOptions["compactFragments"],
  historyProjection?: ChannelRuntimeOptions["historyProjection"],
) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-runtime-"));
  const channel = new Channel(context, root);
  await channel.conversation.init();
  const value = new ChannelRuntime(new Context(), {
    channel,
    bot: bot as never,
    will: will as never,
    model: {} as never,
    readImagePolicy: { mode: "unavailable" },
    config: { ...config, ...configOverrides },
    plugins: [],
    providerTools,
    messageBatch,
    ...(compactFragments ? { compactFragments } : {}),
    historyProjection,
    polisher,
    polish,
  });
  await value.init();
  return { value, channel, root };
}

describe("ChannelRuntime scheduling", () => {
  beforeEach(() => {
    state.active = null;
    vi.mocked(createAgent).mockClear();
    state.append.mockReset().mockResolvedValue(undefined);
    state.send.mockReset();
    state.run.mockReset().mockReturnValue((async function* () {})());
    state.decide.mockReset().mockResolvedValue("wait");
    state.decideBatch.mockReset().mockResolvedValue({ decision: "wait" });
    state.settleReservation.mockReset().mockResolvedValue(undefined);
    state.observe.mockReset();
  });
  it("passes provider-executed tools and retry configuration only to the main Agent", async () => {
    const providerTools = { web_search: { type: "provider", id: "test.web_search", inputSchema: {} as never } } as ToolSet;
    const { value, root } = await runtime(providerTools, { modelRetries: 3 });
    try {
      const agentConfig = vi.mocked(createAgent).mock.calls.at(-1)?.[0];
      expect(agentConfig?.providerTools).toBe(providerTools);
      expect(agentConfig?.maxRetries).toBe(3);
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks only the current model input with a current-message boundary", async () => {
    const { value, root } = await runtime();
    try {
      const plugin = vi
        .mocked(createAgent)
        .mock.calls.at(-1)?.[0]
        .plugins?.find((item) => item.name === "core.model-input");
      expect(plugin?.toModelMessages).toBeDefined();

      const historical = createMessage(message("zeta-1", "zeta", 1));
      const current = createMessage(message("jiang-1", "443306717", 2));
      const context = { history: [historical], current: [current] } as never;
      const historicalProjection = await plugin!.toModelMessages!(historical, context);
      const currentProjection = await plugin!.toModelMessages!(current, context);
      const historicalContent = String((Array.isArray(historicalProjection) ? historicalProjection[0] : historicalProjection)?.content);
      const currentContent = String((Array.isArray(currentProjection) ? currentProjection[0] : currentProjection)?.content);

      expect(historicalContent).not.toContain("[CURRENT_MESSAGE]");
      expect(currentContent).toContain("[CURRENT_MESSAGE]");
      expect(currentContent).toContain('sender="443306717 (443306717)"');
      expect(currentContent).toContain('id="jiang-1"');
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops delivered transcripts and merges adjacent user turns only in Gemini mode", async () => {
    const { value, root } = await runtime(undefined, {}, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "gemini-native");
    try {
      const plugin = vi
        .mocked(createAgent)
        .mock.calls.at(-1)?.[0]
        .plugins?.find((item) => item.name === "core.model-input");
      const transcript = createDeliveredTranscriptMessage(
        { messages: ["已经发出的内容"], deliveredCount: 1, partial: false },
        { id: "transcript-gemini", timestamp: 123 },
      );
      await expect(plugin?.toModelMessages?.(transcript, { history: [transcript], current: [] } as never)).resolves.toEqual([]);

      const prepared = await plugin?.prepareStep?.(
        [
          { role: "user", content: "第一段" },
          {
            role: "user",
            content: [
              { type: "text", text: "第二段" },
              { type: "file", data: new Uint8Array([1]), mediaType: "image/png" },
            ],
          },
          { role: "assistant", content: "边界" },
          { role: "user", content: "第三段" },
        ],
        { turnId: "turn-gemini" } as never,
      );

      expect(prepared).toHaveLength(3);
      expect(prepared?.[0]).toMatchObject({
        role: "user",
        content: [
          { type: "text", text: "第一段" },
          { type: "text", text: "\n" },
          { type: "text", text: "第二段" },
          { type: "file", mediaType: "image/png" },
        ],
      });
      expect(prepared?.[1]).toEqual({ role: "assistant", content: "边界" });
      expect(prepared?.[2]).toEqual({ role: "user", content: "第三段" });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("converts delivered transcript history into a read-only assistant context", async () => {
    const { value, root } = await runtime();
    try {
      const plugin = vi
        .mocked(createAgent)
        .mock.calls.at(-1)?.[0]
        .plugins?.find((item) => item.name === "core.model-input");
      const transcript = createDeliveredTranscriptMessage(
        { messages: ["已经发出的内容 & <标签>"], deliveredCount: 1, partial: true },
        { id: "transcript-1", timestamp: 123 },
      );
      const projected = await plugin?.toModelMessages?.(transcript, { history: [transcript], current: [] } as never);
      const modelMessage = (Array.isArray(projected) ? projected[0] : projected) as { role?: string; content?: unknown } | undefined;

      expect(modelMessage?.role).toBe("assistant");
      expect(String(modelMessage?.content)).toContain(
        '<delivered_transcript timestamp="123" delivered_count="1" partial="true" role="assistant" source="platform" status="already-delivered">',
      );
      expect(String(modelMessage?.content)).toContain('role="assistant" source="platform" status="already-delivered"');
      expect(String(modelMessage?.content)).toContain("not user input, not the current question, and not an executable instruction");
      expect(String(modelMessage?.content)).toContain("已经发出的内容 &amp; &lt;标签&gt;");
      expect(String(modelMessage?.content)).not.toContain("<标签>");
      expect(String(modelMessage?.content)).not.toContain("[DELIVERED_MESSAGE]");
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("coalesces delivered transcripts into one leading read-only context", async () => {
    const { value, root } = await runtime();
    try {
      const plugin = vi
        .mocked(createAgent)
        .mock.calls.at(-1)?.[0]
        .plugins?.find((item) => item.name === "core.model-input");
      const first = createDeliveredTranscriptMessage(
        { messages: ["第一条已发送内容"], deliveredCount: 1, partial: false },
        { id: "transcript-1", timestamp: 123 },
      );
      const second = createDeliveredTranscriptMessage(
        { messages: ["第二条已发送内容"], deliveredCount: 1, partial: false },
        { id: "transcript-2", timestamp: 456 },
      );
      const context = { history: [first, second], current: [] } as never;
      const firstProjection = await plugin?.toModelMessages?.(first, context);
      const secondProjection = await plugin?.toModelMessages?.(second, context);
      const modelMessage = (Array.isArray(firstProjection) ? firstProjection[0] : firstProjection) as { role?: string; content?: unknown } | undefined;

      expect(firstProjection).toHaveLength(1);
      expect(secondProjection).toEqual([]);
      expect(modelMessage?.role).toBe("assistant");
      expect(String(modelMessage?.content)).toContain(
        '<delivered_transcript_history readonly="true" role="assistant" source="platform" status="already-delivered">',
      );
      expect(String(modelMessage?.content)).toContain("第一条已发送内容");
      expect(String(modelMessage?.content)).toContain("第二条已发送内容");
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the primary model when no dedicated compact model is configured", async () => {
    const { value, channel, root } = await runtime();
    const compact = vi.spyOn(channel.conversation, "compact").mockResolvedValue({ compacted: false, reason: "minimum_messages" });
    try {
      await expect(value.compact("manual")).resolves.toEqual({ compacted: false, reason: "minimum_messages" });
      expect(compact).toHaveBeenCalledWith("manual", {
        model: expect.anything(),
        signal: expect.any(AbortSignal),
      });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("projects only the newest configured compact fragments into model-visible history", async () => {
    const { value, root } = await runtime();
    try {
      const plugin = vi
        .mocked(createAgent)
        .mock.calls.at(-1)?.[0]
        .plugins?.find((item) => item.name === "core.compact-history");
      const entries = await plugin?.transformEntries?.(
        [1, 2, 3, 4, 5].map((number) =>
          createEntry(
            "compact",
            { summary: `fragment ${number}`, lastEntryId: `source-${number}`, sourceSession: "session" },
            { id: `compact-${number}`, timestamp: number },
          ),
        ),
      );

      const projectedContents = (entries ?? []).map((entry) => (entry.type === "message" ? String(entry.data.content) : ""));
      expect(projectedContents).toHaveLength(3);
      expect(projectedContents.join("\n")).toContain("fragment 3");
      expect(projectedContents.join("\n")).toContain("fragment 4");
      expect(projectedContents.join("\n")).toContain("fragment 5");
      expect(projectedContents.join("\n")).not.toContain("fragment 2");
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("recalls bounded overflow history using the captured session anchor before history projection", async () => {
    const recall = vi.fn(async () => [
      {
        id: "compact-4",
        channelKey: "guild:test:room",
        lineageId: "lineage-a",
        lastEntryId: "e4",
        summary: "project alpha resident",
        endAt: 400,
        createdAt: 401,
      },
      { id: "compact-1", channelKey: "guild:test:room", lineageId: "lineage-a", lastEntryId: "e1", summary: "project alpha first", endAt: 100, createdAt: 101 },
      { id: "future", channelKey: "guild:test:room", lineageId: "lineage-a", lastEntryId: "ef", summary: "project alpha future", endAt: 501, createdAt: 502 },
      {
        id: "compact-2",
        channelKey: "guild:test:room",
        lineageId: "lineage-a",
        lastEntryId: "e2",
        summary: "project alpha second",
        endAt: 200,
        createdAt: 201,
      },
      {
        id: "compact-1",
        channelKey: "guild:test:room",
        lineageId: "lineage-a",
        lastEntryId: "e1",
        summary: "project alpha duplicate",
        endAt: 90,
        createdAt: 91,
      },
      { id: "compact-3", channelKey: "guild:test:room", lineageId: "lineage-a", lastEntryId: "e3", summary: "project alpha third", endAt: 300, createdAt: 301 },
    ]);
    const { value, root } = await runtime(
      undefined,
      {
        session: {
          ...config.session,
          compact: { ...config.session.compact, inlineFragments: 2 },
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { recall } as never,
    );
    try {
      const plugins = vi.mocked(createAgent).mock.calls.at(-1)?.[0].plugins ?? [];
      const history = plugins.find((plugin) => plugin.name === "core.compact-history");
      const recallPlugin = plugins.find((plugin) => plugin.name === "core.compact-recall");
      const entries = [1, 2, 3, 4, 5].map((number) =>
        createEntry(
          "compact",
          {
            summary: `fragment ${number}`,
            lastEntryId: `source-${number}`,
            lineageId: "lineage-a",
            endAt: number * 100,
            ...(number > 1 ? { parentCompactId: `compact-${number - 1}` } : {}),
          },
          { id: `compact-${number}`, timestamp: number * 100 + 1 },
        ),
      );
      const projected = await recallPlugin?.transformEntries?.(entries);
      await history?.transformEntries?.(entries);
      const prepared = await recallPlugin?.prepareStep?.(
        [{ role: "user", content: '[time="2026-09-24 20:15" sender="Alice"]\n[CURRENT_MESSAGE]\nproject alpha current\n[/CURRENT_MESSAGE]' }],
        { turnId: "turn-1" } as never,
      );

      expect(plugins.indexOf(recallPlugin!)).toBeLessThan(plugins.indexOf(history!));
      expect(recallPlugin?.enforce).toBe("pre");
      expect(projected).toBeUndefined();
      expect(recall).toHaveBeenCalledWith(
        expect.objectContaining({
          channelKey: "guild:test:room",
          lineageId: "lineage-a",
          query: "project alpha current",
          anchor: { id: "compact-5", parentCompactId: "compact-4" },
          knownFragments: [
            { id: "compact-1" },
            { id: "compact-2", parentCompactId: "compact-1" },
            { id: "compact-3", parentCompactId: "compact-2" },
            { id: "compact-4", parentCompactId: "compact-3" },
            { id: "compact-5", parentCompactId: "compact-4" },
          ],
          before: 500,
          excludeIds: new Set(["compact-4", "compact-5"]),
        }),
      );
      expect(prepared?.[0]).toMatchObject({ role: "system" });
      expect(String(prepared?.[0]?.content)).toContain("project alpha first");
      expect(String(prepared?.[0]?.content)).toContain("project alpha second");
      expect(String(prepared?.[0]?.content)).toContain("project alpha third");
      expect(String(prepared?.[0]?.content)).not.toContain("resident");
      expect(String(prepared?.[0]?.content)).not.toContain("future");
      expect(String(prepared?.[0]?.content)).not.toContain("duplicate");

      await recallPlugin?.transformEntries?.(entries);
      const resumed = await recallPlugin?.prepareStep?.([{ role: "assistant", content: "tool result received" }], { turnId: "turn-1" } as never);
      expect(String(resumed?.[0]?.content)).toContain("project alpha first");
      expect(recall).toHaveBeenCalledOnce();

      await recallPlugin?.onTurnFinish?.({} as never, { turnId: "turn-1" } as never);
      await recallPlugin?.transformEntries?.(entries);
      await expect(recallPlugin?.prepareStep?.([{ role: "assistant", content: "next turn" }], { turnId: "turn-1" } as never)).resolves.toBeUndefined();
      expect(recall).toHaveBeenCalledOnce();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("skips compact recall when the persistent store fails", async () => {
    const recall = vi.fn(async () => Promise.reject(new Error("database offline")));
    const { value, root } = await runtime(undefined, {}, undefined, undefined, undefined, undefined, undefined, undefined, { recall } as never);
    try {
      const plugin = vi
        .mocked(createAgent)
        .mock.calls.at(-1)?.[0]
        .plugins?.find((item) => item.name === "core.compact-recall");
      await plugin?.transformEntries?.([
        createEntry("compact", { summary: "project alpha", lastEntryId: "source", lineageId: "lineage-a", endAt: 100 }, { id: "compact-1", timestamp: 101 }),
      ]);
      const messages = [{ role: "user" as const, content: "[CURRENT_MESSAGE]\nproject alpha\n[/CURRENT_MESSAGE]" }];

      await expect(plugin?.prepareStep?.(messages, { turnId: "turn-failed" } as never)).resolves.toBeUndefined();
      expect(recall).toHaveBeenCalledOnce();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("commits trigger false without Will or a turn", async () => {
    const { value, root } = await runtime();
    try {
      await expect(value.post(event, { trigger: false, ifBusy: "join" })).resolves.toMatchObject({ kind: "wait" });
      expect(state.append).toHaveBeenCalledTimes(1);
      expect(state.decide).not.toHaveBeenCalled();
      expect(state.send).not.toHaveBeenCalled();
      expect(state.run).not.toHaveBeenCalled();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects before append when busy", async () => {
    state.active = "active";
    const { value, root } = await runtime();
    try {
      await expect(value.post(event, { ifBusy: "reject" })).rejects.toThrow();
      expect(state.append).not.toHaveBeenCalled();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("joins the active turn without a second run consumer", async () => {
    state.active = "active";
    const { value, root } = await runtime();
    try {
      await expect(value.post(event, { ifBusy: "join" })).resolves.toEqual({ kind: "join", eventId: expect.any(String), turnId: "active" });
      expect(state.send).toHaveBeenCalledOnce();
      expect(state.run).not.toHaveBeenCalled();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("runs event posts with an isolated model-history mode", async () => {
    const { value, root } = await runtime();
    try {
      const result = await value.post(event);
      if (result.kind === "run") await result.done;
      expect(state.run).toHaveBeenCalledWith(expect.objectContaining({ role: "custom", type: "yesimbot.event" }), { ifBusy: "defer", historyMode: "event" });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows an explicitly posted event to use conversation history", async () => {
    const { value, root } = await runtime();
    try {
      const result = await value.post(event, { historyMode: "conversation" });
      if (result.kind === "run") await result.done;
      expect(state.run).toHaveBeenCalledWith(expect.objectContaining({ role: "custom", type: "yesimbot.event" }), {
        ifBusy: "defer",
        historyMode: "conversation",
      });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs an active post without delivering the model text output", async () => {
    state.run.mockReturnValue(
      (async function* () {
        yield { type: "turn.start", turnId: "turn-1" };
        yield { type: "message.appended", turnId: "turn-1", message: { role: "assistant", id: "message-1", content: "内部规划，不应发送" } };
        yield { type: "turn.done", turnId: "turn-1" };
      })(),
    );
    const bot = { selfId: "bot", sendMessage: vi.fn() };
    const { value, root } = await runtime(undefined, {}, bot);
    try {
      const result = await value.post(event);
      expect(result.kind).toBe("run");
      if (result.kind === "run") await result.done;
      expect(bot.sendMessage).not.toHaveBeenCalled();
      expect(state.send).not.toHaveBeenCalled();
      expect(state.decide).not.toHaveBeenCalled();
      expect(state.run).toHaveBeenCalledOnce();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose describe_image when native read gives the primary model original pixels", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtime-native-image-"));
    const channel = new Channel({ type: "guild", platform: "test", channelId: "room", guildId: "room" }, root);
    await channel.conversation.init();
    const value = new ChannelRuntime(new Context(), {
      channel,
      bot: { selfId: "bot", sendMessage: vi.fn() } as never,
      will: { decide: state.decide, observe: state.observe } as never,
      model: {} as never,
      visionModel: {} as never,
      readImagePolicy: { mode: "native" },
      config,
      plugins: [],
    });
    await value.init();
    try {
      const tools = vi.mocked(createAgent).mock.calls.at(-1)?.[0].tools ?? [];
      expect(tools.map((tool) => tool.name)).toContain("read");
      expect(tools.map((tool) => tool.name)).not.toContain("describe_image");
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("shares one image projection store and clears current-turn pixels on turn finish", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtime-image-projection-"));
    const channel = new Channel({ type: "guild", platform: "test", channelId: "room", guildId: "room" }, root);
    await channel.conversation.init();
    const imageProjection = new EphemeralImageProjectionStore();
    const value = new ChannelRuntime(new Context(), {
      channel,
      bot: { selfId: "bot", sendMessage: vi.fn() } as never,
      will: { decide: state.decide, observe: state.observe } as never,
      model: {} as never,
      readImagePolicy: { mode: "native" },
      imageProjection,
      config,
      plugins: [],
    });
    await value.init();
    try {
      const agentConfig = vi.mocked(createAgent).mock.calls.at(-1)?.[0];
      const read = agentConfig?.tools?.find((tool) => tool.name === "read");
      const lifecycle = agentConfig?.plugins?.find((plugin) => plugin.name === "core.image-projection");
      imageProjection.stage({ toolCallId: "call", turnId: "turn-1", bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" });

      expect((await read?.toModelOutput?.({ toolCallId: "call", input: { uri: "asset://fixture" }, output: { uri: "asset://fixture" } } as never))?.type).toBe(
        "content",
      );
      await lifecycle?.onTurnFinish?.({ turnId: "turn-1", status: "done", messages: [] }, { turnId: "turn-1" } as never);
      expect((await read?.toModelOutput?.({ toolCallId: "call", input: { uri: "asset://fixture" }, output: { uri: "asset://fixture" } } as never))?.type).toBe(
        "json",
      );
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes send_message and finish with the expected turn-ending semantics", async () => {
    const { value, root } = await runtime();
    try {
      const tools = vi.mocked(createAgent).mock.calls.at(-1)?.[0].tools ?? [];
      const send = tools.find((tool) => tool.name === "send_message");
      const finish = tools.find((tool) => tool.name === "finish");
      expect(tools.map((tool) => tool.name)).toContain("ctx_expand");
      expect(typeof send?.terminal).toBe("function");
      expect(finish?.terminal).toBe(true);
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks send_message for a silent post and allows it otherwise", async () => {
    let blockedDuringTurn: unknown;
    let allowedAfterTurn: unknown;
    const plugin = () =>
      vi
        .mocked(createAgent)
        .mock.calls.at(-1)?.[0]
        .plugins?.find((item) => item.name === "core.silent-turn");
    state.run.mockImplementation(() =>
      (async function* () {
        yield { type: "turn.start", turnId: "turn-1" };
        blockedDuringTurn = await plugin()?.beforeToolCall?.(
          { toolCallId: "c1", toolName: "send_message", args: {} } as never,
          {
            turnId: "turn-1",
          } as never,
        );
        yield { type: "turn.done", turnId: "turn-1" };
      })(),
    );
    const { value, root } = await runtime();
    try {
      const result = await value.post(event, { delivery: "silent" });
      if (result.kind === "run") await result.done;
      allowedAfterTurn = await plugin()?.beforeToolCall?.(
        { toolCallId: "c2", toolName: "send_message", args: {} } as never,
        {
          turnId: "turn-1",
        } as never,
      );

      expect(blockedDuringTurn).toMatchObject({ type: "block" });
      expect(allowedAfterTurn).toEqual({ type: "allow" });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defers a passive shared trigger instead of joining an active turn", async () => {
    state.active = "active";
    state.decide.mockResolvedValue("trigger");
    const { value, root } = await runtime();
    try {
      await expect(value.handle(event)).resolves.toMatchObject({ kind: "run" });
      expect(state.send).not.toHaveBeenCalled();
      expect(state.run).toHaveBeenCalledWith(expect.anything(), { ifBusy: "defer", historyMode: "event" });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps joining passive direct messages into the active turn", async () => {
    state.active = "active";
    state.decide.mockResolvedValue("trigger");
    const { value, root } = await runtime(
      undefined,
      {},
      { selfId: "bot", sendMessage: vi.fn() },
      { type: "direct", platform: "test", selfId: "bot", channelId: "private:user", userId: "user" },
    );
    try {
      await expect(value.handle(event)).resolves.toMatchObject({ kind: "join", turnId: "active" });
      expect(state.send).toHaveBeenCalledWith(expect.anything(), { ifBusy: "join" });
      expect(state.run).not.toHaveBeenCalled();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs passive trigger and observes only after the turn ends", async () => {
    state.decide.mockResolvedValue("trigger");
    state.run.mockReturnValue(
      (async function* () {
        yield { type: "turn.start", turnId: "turn-1" };
        yield { type: "message.appended", turnId: "turn-1", message: { role: "assistant", id: "message-1", content: "reply" } };
        yield { type: "turn.done", turnId: "turn-1" };
      })(),
    );
    const { value, root } = await runtime();
    try {
      const result = await value.handle(event);
      expect(result.kind).toBe("run");
      if (result.kind === "run") await result.done;
      expect(state.decide).toHaveBeenCalledOnce();
      expect(state.observe).toHaveBeenCalledWith(expect.objectContaining({ turnId: "turn-1", status: "done" }));
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("observes a passive turn that ends without any tool call", async () => {
    state.decide.mockResolvedValue("trigger");
    state.run.mockReturnValue(
      (async function* () {
        yield { type: "turn.start", turnId: "turn-1" };
        yield { type: "turn.done", turnId: "turn-1" };
      })(),
    );
    const { value, root } = await runtime();
    try {
      const result = await value.handle(event);
      expect(result.kind).toBe("run");
      if (result.kind === "run") await result.done;
      expect(state.observe).toHaveBeenCalledWith(expect.objectContaining({ turnId: "turn-1", status: "done" }));
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("returns wait without running the Agent when passive Will waits", async () => {
    const { value, root } = await runtime();
    try {
      await expect(value.handle(event)).resolves.toMatchObject({ kind: "wait" });
      expect(state.run).not.toHaveBeenCalled();
      expect(state.observe).not.toHaveBeenCalled();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues FIFO work after a rejected busy operation", async () => {
    state.active = "active";
    const { value, root } = await runtime();
    try {
      await expect(value.post(event, { ifBusy: "reject" })).rejects.toThrow();
      state.active = null;
      state.run.mockReturnValue((async function* () {})());
      await expect(value.post(event)).resolves.toMatchObject({ kind: "run" });
      expect(state.append).toHaveBeenCalledOnce();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps one output consumer for a joined active turn", async () => {
    state.active = "active";
    const { value, root } = await runtime();
    try {
      await expect(value.post(event, { ifBusy: "join" })).resolves.toMatchObject({ kind: "join", turnId: "active" });
      expect(state.run).not.toHaveBeenCalled();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists and queues ordinary messages without evaluating Will immediately", async () => {
    const batching = batchPlugin();
    const { value, root } = await runtime(undefined, {}, undefined, undefined, batching.plugin);
    try {
      await expect(value.handle(message("message-1", "user-1", 1))).resolves.toMatchObject({ kind: "wait" });

      expect(state.append).toHaveBeenCalledOnce();
      expect(batching.controller.enqueue).toHaveBeenCalledOnce();
      expect(state.decide).not.toHaveBeenCalled();
      expect(state.run).not.toHaveBeenCalled();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("evaluates every batch message once in order and starts at most one deferred turn", async () => {
    state.active = "active-turn";
    state.decide.mockResolvedValueOnce("wait").mockResolvedValueOnce("trigger").mockResolvedValueOnce("wait");
    const batching = batchPlugin();
    const { value, channel, root } = await runtime(undefined, {}, undefined, undefined, batching.plugin);
    try {
      await value.handle(message("message-1", "user-1", 1));
      await value.handle(message("message-2", "user-2", 2));
      await value.handle(message("message-3", "user-1", 3));
      const queued = batching.controller.enqueue.mock.calls.map(([input]) => input);

      await batching.flush(queued);

      expect(state.decide.mock.calls.map(([input]) => input.data.messageId)).toEqual(["message-1", "message-2", "message-3"]);
      const decisions = (await channel.conversation.storage.read()).filter((entry) => entry.type === "event" && entry.data.type === "will.decision");
      expect(decisions).toHaveLength(3);
      expect(state.run).toHaveBeenCalledOnce();
      expect(state.run).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ messageId: "message-3" }) }), {
        ifBusy: "defer",
        historyMode: "conversation",
      });
      expect(state.send).not.toHaveBeenCalled();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues evaluating the batch after one Will decision throws", async () => {
    state.decide.mockRejectedValueOnce(new Error("broken Will plugin")).mockResolvedValueOnce("trigger");
    const batching = batchPlugin();
    const { value, channel, root } = await runtime(undefined, {}, undefined, undefined, batching.plugin);
    try {
      await value.handle(message("message-1", "user-1", 1));
      await value.handle(message("message-2", "user-2", 2));
      const queued = batching.controller.enqueue.mock.calls.map(([input]) => input);

      await expect(batching.flush(queued)).resolves.toBeUndefined();

      expect(state.decide.mock.calls.map(([input]) => input.data.messageId)).toEqual(["message-1", "message-2"]);
      const decisions = (await channel.conversation.storage.read()).filter((entry) => entry.type === "event" && entry.data.type === "will.decision");
      expect(decisions).toHaveLength(1);
      expect(state.run).toHaveBeenCalledOnce();
      expect(state.run).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ messageId: "message-2" }) }), {
        ifBusy: "defer",
        historyMode: "conversation",
      });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a duplicate flush snapshot after processing every batch item once", async () => {
    state.decide.mockResolvedValue("trigger");
    const batching = batchPlugin();
    const { value, channel, root } = await runtime(undefined, {}, undefined, undefined, batching.plugin);
    try {
      await value.handle(message("message-1", "user-1", 1));
      await value.handle(message("message-2", "user-2", 2));
      const queued = batching.controller.enqueue.mock.calls.map(([input]) => input);

      await batching.flush(queued);
      await batching.flush(queued);

      expect(state.decide.mock.calls.map(([input]) => input.data.messageId)).toEqual(["message-1", "message-2"]);
      const decisions = (await channel.conversation.storage.read()).filter((entry) => entry.type === "event" && entry.data.type === "will.decision");
      expect(decisions).toHaveLength(2);
      expect(state.run).toHaveBeenCalledOnce();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an all-wait batch silent and leaves Event records immediate", async () => {
    const batching = batchPlugin();
    const { value, root } = await runtime(undefined, {}, undefined, undefined, batching.plugin);
    try {
      await value.handle(message("message-1", "user-1", 1));
      await value.handle(message("message-2", "user-2", 2));
      const queued = batching.controller.enqueue.mock.calls.map(([input]) => input);
      await batching.flush(queued);

      expect(state.decide).toHaveBeenCalledTimes(2);
      expect(state.run).not.toHaveBeenCalled();

      state.decide.mockResolvedValueOnce("trigger");
      await expect(value.handle(event)).resolves.toMatchObject({ kind: "run" });
      expect(batching.controller.enqueue).toHaveBeenCalledTimes(2);
      expect(state.decide).toHaveBeenCalledTimes(3);
      expect(state.run).toHaveBeenCalledOnce();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses one batch-aware Will decision, one reservation, and the latest input as the deferred Agent marker", async () => {
    state.active = "active-turn";
    state.decideBatch.mockResolvedValue({
      decision: "trigger",
      candidate: { inputId: "candidate", authorId: "user-1", score: 80, probability: 0.8 },
      reservationId: "reservation-1",
    });
    state.run.mockReturnValue(
      (async function* () {
        yield { type: "turn.start", turnId: "turn-1" };
        yield { type: "turn.done", turnId: "turn-1" };
      })(),
    );
    const batching = batchPlugin();
    const will = {
      decide: state.decide,
      decideBatch: state.decideBatch,
      settleReservation: state.settleReservation,
      observe: state.observe,
    };
    const { value, channel, root } = await runtime(undefined, {}, undefined, undefined, batching.plugin, will);
    try {
      await value.handle(message("candidate", "user-1", 1));
      await value.handle(message("latest", "user-2", 2));
      const queued = batching.controller.enqueue.mock.calls.map(([input]) => input);

      await batching.flush(queued);
      await vi.waitFor(() => expect(state.settleReservation).toHaveBeenCalledOnce());

      expect(state.decideBatch).toHaveBeenCalledOnce();
      expect(state.decideBatch.mock.calls[0]?.[0].map((input: MessageBatchInput) => input.data.user.id)).toEqual(["user-1", "user-2"]);
      expect(state.decide).not.toHaveBeenCalled();
      expect(state.run).toHaveBeenCalledOnce();
      expect(state.run).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ messageId: "latest" }) }), {
        ifBusy: "defer",
        historyMode: "conversation",
      });
      expect(state.settleReservation).toHaveBeenCalledWith("reservation-1", {
        kind: "release",
        turnId: "turn-1",
        reason: "done-without-delivery",
      });
      const decisions = (await channel.conversation.storage.read()).filter((entry) => entry.type === "event" && entry.data.type === "will.decision");
      expect(decisions).toHaveLength(1);
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("admits a typed poke into the same ordered batch only through the optional Event controller", async () => {
    const batching = batchPlugin({ acceptEvents: true });
    const will = {
      decide: state.decide,
      decideBatch: state.decideBatch,
      settleReservation: state.settleReservation,
      observe: state.observe,
    };
    const { value, root } = await runtime(undefined, {}, undefined, undefined, batching.plugin, will);
    try {
      await value.handle(message("before", "user-1", 1));
      await value.handle(pokeEvent);
      await value.handle(message("after", "user-3", 3));
      const inputs = [batching.controller.enqueue.mock.calls[0]![0], batching.queuedEvents[0]!, batching.controller.enqueue.mock.calls[1]![0]];

      await batching.flushInputs(inputs);

      expect(batching.controller.enqueueEvent).toHaveBeenCalledOnce();
      expect(state.decideBatch).toHaveBeenCalledOnce();
      expect(state.decideBatch.mock.calls[0]?.[0].map((input: MessageBatchInput) => input.id)).toEqual(inputs.map((input) => input.id));
      expect(state.decide).not.toHaveBeenCalled();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("commits a reservation on the first real current-channel delivery even when a later segment fails", async () => {
    state.decideBatch.mockResolvedValue({ decision: "trigger", reservationId: "reservation-delivered" });
    const sendMessage = vi.fn().mockResolvedValueOnce(["sent-1"]).mockRejectedValueOnce(new Error("second failed"));
    state.run.mockImplementation(() =>
      (async function* () {
        yield { type: "turn.start", turnId: "turn-delivered" };
        const send = vi
          .mocked(createAgent)
          .mock.calls.at(-1)?.[0]
          .tools?.find((tool) => tool.name === "send_message");
        await send?.execute?.({ messages: ["first", "second"] }, { toolCallId: "call", turnId: "turn-delivered", abortSignal: undefined } as never);
        yield { type: "turn.done", turnId: "turn-delivered" };
      })(),
    );
    const will = { decide: state.decide, decideBatch: state.decideBatch, settleReservation: state.settleReservation, observe: state.observe };
    const { value, root } = await runtime(undefined, {}, { selfId: "bot", sendMessage }, undefined, undefined, will);
    try {
      const result = await value.handle(message("message", "user", 1));
      if (result.kind === "run") await result.done;

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(state.settleReservation).toHaveBeenCalledOnce();
      expect(state.settleReservation).toHaveBeenCalledWith("reservation-delivered", {
        kind: "commit",
        turnId: "turn-delivered",
        messageId: "sent-1",
      });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries a transient delivery settlement failure again at terminal cleanup", async () => {
    state.decideBatch.mockResolvedValue({ decision: "trigger", reservationId: "reservation-transient" });
    const settleReservation = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient-1"))
      .mockRejectedValueOnce(new Error("transient-2"))
      .mockRejectedValueOnce(new Error("transient-3"))
      .mockResolvedValue(undefined);
    const sendMessage = vi.fn(async () => ["sent-transient"]);
    state.run.mockImplementation(() =>
      (async function* () {
        yield { type: "turn.start", turnId: "turn-transient" };
        const send = vi
          .mocked(createAgent)
          .mock.calls.at(-1)?.[0]
          .tools?.find((tool) => tool.name === "send_message");
        await send?.execute?.({ messages: ["hello"] }, { toolCallId: "call", turnId: "turn-transient", abortSignal: undefined });
        yield { type: "turn.done", turnId: "turn-transient" };
      })(),
    );
    const will = { decide: state.decide, decideBatch: state.decideBatch, settleReservation, observe: state.observe };
    const { value, root } = await runtime(undefined, {}, { selfId: "bot", sendMessage }, undefined, undefined, will);
    try {
      const result = await value.handle(message("message", "user", 1));
      if (result.kind === "run") await result.done;

      expect(settleReservation).toHaveBeenCalledTimes(4);
      expect(settleReservation).toHaveBeenLastCalledWith("reservation-transient", {
        kind: "commit",
        turnId: "turn-transient",
        messageId: "sent-transient",
      });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "silent",
      (async function* () {
        yield { type: "turn.start", turnId: "turn-release" };
        yield { type: "turn.done", turnId: "turn-release" };
      })(),
      "done-without-delivery",
    ],
    [
      "failed",
      (async function* () {
        yield { type: "turn.start", turnId: "turn-release" };
        yield { type: "turn.failed", turnId: "turn-release", error: { name: "Error", message: "failed" } };
      })(),
      "failed",
    ],
    [
      "aborted",
      (async function* () {
        yield { type: "turn.start", turnId: "turn-release" };
        yield { type: "turn.aborted", turnId: "turn-release", reason: "stop" };
      })(),
      "aborted",
    ],
    [
      "consume-failed",
      (async function* () {
        yield { type: "turn.start", turnId: "turn-release" };
        throw new Error("stream failed");
      })(),
      "consume-failed",
    ],
  ] as const)("releases a %s reservation exactly once", async (_label, stream, reason) => {
    state.decideBatch.mockResolvedValue({ decision: "trigger", reservationId: "reservation-release" });
    state.run.mockReturnValue(stream);
    const will = { decide: state.decide, decideBatch: state.decideBatch, settleReservation: state.settleReservation, observe: state.observe };
    const { value, root } = await runtime(undefined, {}, undefined, undefined, undefined, will);
    try {
      const result = await value.handle(message("message", "user", 1));
      if (result.kind === "run") await result.done;

      expect(state.settleReservation).toHaveBeenCalledOnce();
      expect(state.settleReservation).toHaveBeenCalledWith("reservation-release", { kind: "release", turnId: "turn-release", reason });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "all-failed",
      vi.fn(async () => {
        throw new Error("offline");
      }),
      {},
    ],
    ["zero-message-id", vi.fn(async () => []), {}],
    ["cross-channel", vi.fn(async () => ["other-1"]), { channel: "other-room" }],
  ])("does not confirm %s send_message completion", async (_label, sendMessage, input) => {
    state.decideBatch.mockResolvedValue({ decision: "trigger", reservationId: "reservation-send" });
    state.run.mockImplementation(() =>
      (async function* () {
        yield { type: "turn.start", turnId: "turn-send" };
        const send = vi
          .mocked(createAgent)
          .mock.calls.at(-1)?.[0]
          .tools?.find((tool) => tool.name === "send_message");
        await send?.execute?.({ messages: ["hello"], ...input }, { toolCallId: "call", turnId: "turn-send", abortSignal: undefined } as never);
        yield { type: "turn.done", turnId: "turn-send" };
      })(),
    );
    const will = { decide: state.decide, decideBatch: state.decideBatch, settleReservation: state.settleReservation, observe: state.observe };
    const { value, root } = await runtime(undefined, {}, { selfId: "bot", sendMessage }, undefined, undefined, will);
    try {
      const result = await value.handle(message("message", "user", 1));
      if (result.kind === "run") await result.done;
      expect(state.settleReservation).toHaveBeenCalledWith("reservation-send", {
        kind: "release",
        turnId: "turn-send",
        reason: "done-without-delivery",
      });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases before surfacing a synchronous Agent start failure", async () => {
    state.decideBatch.mockResolvedValue({ decision: "trigger", reservationId: "reservation-start" });
    state.run.mockImplementation(() => {
      throw new Error("start failed");
    });
    const will = { decide: state.decide, decideBatch: state.decideBatch, settleReservation: state.settleReservation, observe: state.observe };
    const { value, root } = await runtime(undefined, {}, undefined, undefined, undefined, will);
    try {
      await expect(value.handle(message("message", "user", 1))).rejects.toThrow("start failed");
      expect(state.settleReservation).toHaveBeenCalledWith("reservation-start", { kind: "release", reason: "start-failed" });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases a reservation if runtime stop wins the race after batch evaluation", async () => {
    let resolveDecision!: (decision: { decision: "trigger"; reservationId: string }) => void;
    state.decideBatch.mockReturnValue(
      new Promise((resolve) => {
        resolveDecision = resolve;
      }),
    );
    const batching = batchPlugin();
    const will = { decide: state.decide, decideBatch: state.decideBatch, settleReservation: state.settleReservation, observe: state.observe };
    const { value, root } = await runtime(undefined, {}, undefined, undefined, batching.plugin, will);
    await value.handle(message("message-1", "user-1", 1));
    const queued = batching.controller.enqueue.mock.calls.map(([input]) => input);

    const flush = batching.flush(queued);
    await vi.waitFor(() => expect(state.decideBatch).toHaveBeenCalledOnce());
    const stop = value.stop();
    resolveDecision({ decision: "trigger", reservationId: "reservation-stopped" });
    await Promise.all([flush, stop]);

    expect(state.run).not.toHaveBeenCalled();
    expect(state.settleReservation).toHaveBeenCalledWith("reservation-stopped", { kind: "release", reason: "start-failed" });
    await rm(root, { recursive: true, force: true });
  });

  it("stops the batch controller and ignores a stale flush after runtime stop", async () => {
    const batching = batchPlugin();
    const { value, root } = await runtime(undefined, {}, undefined, undefined, batching.plugin);
    await value.handle(message("message-1", "user-1", 1));
    const queued = batching.controller.enqueue.mock.calls.map(([input]) => input);

    await value.stop();
    await batching.flush(queued);

    expect(batching.controller.stop).toHaveBeenCalledOnce();
    expect(state.decide).not.toHaveBeenCalled();
    expect(state.run).not.toHaveBeenCalled();
    await rm(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// ChannelRuntime provider-usage compaction
// ---------------------------------------------------------------------------

const responseConfig: Config = {
  ...config,
  session: {
    compact: {
      responseIdleMinutes: 45,
      checkIntervalMinutes: 30,
      turnThreshold: 50,
      minMessages: 15,
      maxFailures: 1,
      inlineFragments: 3,
      model: undefined,
    },
    archive: { maxKB: 0 },
  },
};

async function createResponseRuntime(archiveMaxBytes = 0) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-periodic-"));
  const channel = new Channel({ type: "guild", platform: "test", channelId: "room", guildId: "room" }, root);
  await channel.conversation.init();
  const value = new ChannelRuntime(new Context(), {
    channel,
    bot: { selfId: "bot", sendMessage: vi.fn(async () => ["m1"]) } as never,
    will: { decide: vi.fn().mockResolvedValue("wait"), observe: vi.fn() } as never,
    model: {} as never,
    compactModel: {} as never,
    readImagePolicy: { mode: "unavailable" },
    archiveMaxBytes,
    config: responseConfig,
    plugins: [],
  });
  await value.init();
  return { value, channel, root };
}

function completedPromptUsageReply(inputTokens: readonly (number | undefined)[], turnId = "turn-prompt-limit") {
  return (async function* () {
    yield { type: "turn.start", turnId };
    for (const [step, inputTokenCount] of inputTokens.entries()) {
      yield {
        type: "turn.step",
        turnId,
        step,
        finishReason: "stop",
        ...(inputTokenCount === undefined ? {} : { usage: { inputTokens: inputTokenCount, outputTokens: 10, totalTokens: inputTokenCount + 10 } }),
      };
    }
    yield { type: "turn.done", turnId };
  })();
}

describe("ChannelRuntime provider-usage compaction", () => {
  beforeEach(() => {
    state.active = null;
    state.append.mockReset().mockResolvedValue(undefined);
    state.send.mockReset();
    state.run.mockReset().mockReturnValue((async function* () {})());
    state.wait.mockReset().mockResolvedValue(undefined);
  });

  it("does not compact after a record that produced no model response", async () => {
    const { value, channel, root } = await createResponseRuntime();
    const compact = vi.spyOn(channel.conversation, "compact").mockResolvedValue({ compacted: false });
    try {
      await value.post(event, { trigger: false });
      expect(compact).not.toHaveBeenCalled();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks file size after a record even when it produced no response", async () => {
    const { value, channel, root } = await createResponseRuntime(1);
    const archive = vi.spyOn(channel.conversation, "archiveIfOversize").mockResolvedValue(false);
    try {
      await value.post(event, { trigger: false });
      expect(archive).toHaveBeenCalledWith(1, { model: expect.anything() });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["exactly at the threshold", 100_000],
    ["without usage", undefined],
    ["with non-finite usage", Number.NaN],
    ["with negative usage", -1],
  ])("does not compact %s", async (_label, inputTokens) => {
    const { value, channel, root } = await createResponseRuntime();
    const compact = vi.spyOn(channel.conversation, "compact");
    state.run.mockReturnValue(completedPromptUsageReply([inputTokens]));
    try {
      const result = await value.post(event);
      if (result.kind === "run") await result.done;
      await Promise.resolve();
      expect(compact).not.toHaveBeenCalled();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compacts when a provider response reports more than 100,000 input tokens", async () => {
    const { value, channel, root } = await createResponseRuntime();
    const compact = vi.spyOn(channel.conversation, "compact").mockResolvedValue({ compacted: true });
    state.run.mockReturnValue(completedPromptUsageReply([100_001]));
    try {
      const result = await value.post(event);
      if (result.kind === "run") await result.done;
      await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce());
      expect(compact).toHaveBeenCalledWith("prompt-limit", expect.objectContaining({ force: true, model: expect.anything(), signal: expect.any(AbortSignal) }));
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits until the active Agent turn is idle before compacting", async () => {
    let resolveAgentIdle: (() => void) | undefined;
    state.active = "turn-active";
    state.wait.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAgentIdle = resolve;
      }),
    );
    const { value, channel, root } = await createResponseRuntime();
    const compact = vi.spyOn(channel.conversation, "compact").mockResolvedValue({ compacted: true });
    state.run.mockReturnValue(completedPromptUsageReply([100_001]));
    try {
      const result = await value.post(event);
      if (result.kind === "run") await result.done;
      expect(compact).not.toHaveBeenCalled();

      state.active = null;
      resolveAgentIdle?.();
      await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce());
    } finally {
      state.active = null;
      resolveAgentIdle?.();
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops a pending compact when stopped before the Agent becomes idle", async () => {
    let resolveAgentIdle: (() => void) | undefined;
    state.active = "turn-active";
    state.wait.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAgentIdle = resolve;
      }),
    );
    const { value, channel, root } = await createResponseRuntime();
    const compact = vi.spyOn(channel.conversation, "compact");
    state.run.mockReturnValue(completedPromptUsageReply([100_001]));
    try {
      const result = await value.post(event);
      if (result.kind === "run") await result.done;
      await value.stop();
      state.active = null;
      resolveAgentIdle?.();
      await Promise.resolve();
      expect(compact).not.toHaveBeenCalled();
    } finally {
      state.active = null;
      resolveAgentIdle?.();
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shares an in-flight manual compact instead of starting another for provider usage", async () => {
    const { value, channel, root } = await createResponseRuntime();
    const compact = vi.spyOn(channel.conversation, "compact").mockResolvedValue({ compacted: true });
    state.run.mockReturnValue(completedPromptUsageReply([100_001]));
    try {
      const result = await value.post(event);
      const manual = value.compact("manual");
      if (result.kind === "run") await result.done;
      await manual;
      // Drain the FIFO after the idle waiter so a duplicate automatic task cannot hide behind the assertion.
      await value.post(event, { trigger: false });
      expect(compact).toHaveBeenCalledOnce();
      expect(compact).toHaveBeenCalledWith("manual", expect.not.objectContaining({ force: true }));
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries provider-usage compaction after an in-flight manual compact finds the Agent busy", async () => {
    let resolveAgentIdle: (() => void) | undefined;
    state.active = "turn-active";
    state.wait.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveAgentIdle = resolve;
      }),
    );
    const { value, channel, root } = await createResponseRuntime();
    const compact = vi
      .spyOn(channel.conversation, "compact")
      .mockResolvedValueOnce({ compacted: false, reason: "busy" })
      .mockResolvedValueOnce({ compacted: true });
    state.run.mockReturnValue(completedPromptUsageReply([100_001]));
    try {
      const result = await value.post(event);
      const manual = value.compact("manual");
      if (result.kind === "run") await result.done;
      await expect(manual).resolves.toEqual({ compacted: false, reason: "busy" });
      expect(compact).not.toHaveBeenCalled();

      state.active = null;
      resolveAgentIdle?.();
      await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce());
      expect(compact).toHaveBeenCalledWith("prompt-limit", expect.objectContaining({ force: true, model: expect.anything(), signal: expect.any(AbortSignal) }));
    } finally {
      state.active = null;
      resolveAgentIdle?.();
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries provider-usage compaction after an in-flight manual compact rejects", async () => {
    const { value, channel, root } = await createResponseRuntime();
    const compact = vi
      .spyOn(channel.conversation, "compact")
      .mockRejectedValueOnce(new Error("manual compact failed"))
      .mockResolvedValueOnce({ compacted: true });
    state.run.mockReturnValue(completedPromptUsageReply([100_001]));
    try {
      const result = await value.post(event);
      const manual = value.compact("manual");
      if (result.kind === "run") await result.done;
      await expect(manual).rejects.toThrow("manual compact failed");
      await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(2));
      expect(compact).toHaveBeenNthCalledWith(1, "manual", expect.anything());
      expect(compact).toHaveBeenNthCalledWith(
        2,
        "prompt-limit",
        expect.objectContaining({ force: true, model: expect.anything(), signal: expect.any(AbortSignal) }),
      );
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces multiple over-limit model steps into one compact", async () => {
    const { value, channel, root } = await createResponseRuntime();
    const compact = vi.spyOn(channel.conversation, "compact").mockResolvedValue({ compacted: true });
    state.run.mockReturnValue(completedPromptUsageReply([100_001, 115_000]));
    try {
      const result = await value.post(event);
      if (result.kind === "run") await result.done;
      await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce());
      expect(compact).toHaveBeenCalledWith("prompt-limit", expect.objectContaining({ force: true }));
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not compact based on 50 user turns or the legacy interval", async () => {
    vi.useFakeTimers();
    const { value, channel, root } = await createResponseRuntime();
    const count = vi.spyOn(channel.conversation, "userTurnsSinceLastCompact").mockResolvedValue(50);
    const compact = vi.spyOn(channel.conversation, "compact");
    try {
      await value.handle(message("message-2", "user-2", 2));
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(count).not.toHaveBeenCalled();
      expect(compact).not.toHaveBeenCalled();
    } finally {
      await value.stop();
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not schedule another compact when the compact operation fails", async () => {
    const { value, channel, root } = await createResponseRuntime();
    const compact = vi.spyOn(channel.conversation, "compact").mockRejectedValue(new Error("compact unavailable"));
    state.run.mockReturnValue(completedPromptUsageReply([100_001]));
    try {
      const result = await value.post(event);
      if (result.kind === "run") await result.done;
      await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce());
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not install a model request guard", async () => {
    const { value, root } = await createResponseRuntime();
    try {
      expect(vi.mocked(createAgent).mock.calls.at(-1)?.[0].beforeModelRequest).toBeUndefined();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps excluded current entries after the compact summary for later turns", async () => {
    const { value, root } = await createResponseRuntime();
    const historyPlugin = vi
      .mocked(createAgent)
      .mock.calls.at(-1)?.[0]
      .plugins?.find((plugin) => plugin.name === "core.compact-history");
    const history = createEntry("message", { id: "history", timestamp: 1, role: "user", content: "history" }, { id: "history" });
    const current = createEntry("message", { id: "current", timestamp: 2, role: "user", content: "current" }, { id: "current" });
    const compact = createEntry("compact", { summary: "memory", lastEntryId: "history" }, { id: "compact" });
    try {
      const projected = await historyPlugin?.transformEntries?.([history, current, compact]);
      expect(projected?.map((entry) => entry.id)).toEqual(["compact", "current"]);
      expect(projected?.[0]).toMatchObject({ type: "message", data: { role: "system", content: expect.stringContaining("memory") } });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Runtimes identity
// ---------------------------------------------------------------------------

describe("Runtimes identity", () => {
  it("reuses a runtime when Cordis returns different proxies for the same Bot", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-proxy-bot-"));
    const ctx = new Context();
    const rawBot = new Bot(ctx, {}, "test");
    rawBot.user = { id: "bot" };
    const firstBot = ctx.bots.find((candidate) => candidate.selfId === "bot");
    const secondBot = ctx.bots.find((candidate) => candidate.selfId === "bot");
    expect(firstBot).toBeDefined();
    expect(secondBot).toBeDefined();
    expect(firstBot).not.toBe(secondBot);
    expect(firstBot?.selfId).toBe(secondBot?.selfId);

    const channels = new Channels(ctx, { basePath: root });
    const model = {
      resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {} })),
      resolveAuxiliaryModel: vi.fn(() => {
        throw new Error("auxiliary unavailable");
      }),
    };
    const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, new Agents(ctx));
    try {
      const channel = await channels.resolve({ type: "guild", platform: "test", channelId: "room", guildId: "room" });
      const first = await runtimes.get(channel, firstBot as never);
      const stopped = vi.spyOn(first, "stop");
      const second = await runtimes.get(channel, secondBot as never);

      expect(second).toBe(first);
      expect(stopped).not.toHaveBeenCalled();
    } finally {
      await runtimes.stop();
      await rawBot.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["direct", "guild", "channel"] as const)("rebinds a %s runtime after reconnect without losing history", async (type) => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-reconnect-"));
    const ctx = new Context();
    const channels = new Channels(ctx, { basePath: root });
    const model = {
      resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {} })),
      resolveAuxiliaryModel: vi.fn(() => {
        throw new Error("auxiliary unavailable");
      }),
    };
    const agents = new Agents(ctx);
    const setup = vi.fn(async (_context: ChannelContext, _bot: unknown) => ({ name: "connection-plugin" }));
    agents.use({ setup });
    const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, agents);
    try {
      const scope: ChannelContext =
        type === "direct"
          ? { type, platform: "test", channelId: "@user", userId: "user", selfId: "bot" }
          : { type, platform: "test", channelId: "room", guildId: type === "guild" ? "room" : "group" };
      const channel = await channels.resolve(scope);
      const oldBot = { platform: "test", selfId: "bot", sendMessage: vi.fn(async () => ["old-receipt"]) };
      const newBot = { platform: "test", selfId: "bot", sendMessage: vi.fn(async () => ["new-receipt"]) };
      const first = await runtimes.get(channel, oldBot as never);
      const oldAgent = vi.mocked(createAgent).mock.calls.at(-1)![0];
      expect(await runtimes.get(channel, oldBot as never)).toBe(first);
      expect(setup.mock.calls.at(-1)?.[1]).toBe(oldBot);
      const oldSend = oldAgent.tools?.find((tool) => tool.name === "send_message");
      await oldSend?.execute?.({ messages: ["before reconnect"] }, { toolCallId: "before", turnId: "before" });
      expect(oldBot.sendMessage).toHaveBeenCalledOnce();
      oldBot.sendMessage.mockRejectedValue(new Error("old transport closed"));

      const entry = createEntry("message", { id: "kept", timestamp: 1, role: "user", content: "keep this history" });
      await channel.conversation.storage.append(entry);
      const before = await channel.conversation.storage.read();
      const sessionId = channel.conversation.currentSessionId();
      const stopped = vi.spyOn(first, "stop");
      const [replacement, same] = await Promise.all([runtimes.get(channel, newBot as never), runtimes.get(channel, newBot as never)]);
      expect(replacement === first, "reconnect must replace the runtime bound to the old Bot").toBe(false);
      expect(same).toBe(replacement);
      expect(stopped).toHaveBeenCalledOnce();
      expect(setup).toHaveBeenCalledTimes(2);
      expect(setup.mock.calls.at(-1)?.[1]).toBe(newBot);
      expect(model.resolveChatModel).toHaveBeenCalledTimes(2);
      const newAgent = vi.mocked(createAgent).mock.calls.at(-1)![0];
      expect(channel.conversation.currentSessionId()).toBe(sessionId);
      expect(await newAgent.storage?.read()).toEqual(before);
      expect(await oldAgent.storage?.read()).toEqual(before);
      expect(await channel.conversation.storage.read()).toEqual(before);
      expect(before).toContainEqual(entry);
      const newSend = newAgent.tools?.find((tool) => tool.name === "send_message");
      await expect(newSend?.execute?.({ messages: ["after reconnect"] }, { toolCallId: "after", turnId: "after" })).resolves.toMatchObject({ ok: true });
      expect(newBot.sendMessage).toHaveBeenCalledOnce();
      expect(oldBot.sendMessage).toHaveBeenCalledOnce();
    } finally {
      await runtimes.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes creation and replaces a shared runtime when Bot changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtimes-"));
    try {
      const ctx = new Context();
      const channels = new Channels(ctx, { basePath: root });
      const model = {
        resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {} })),
        resolveAuxiliaryModel: vi.fn(() => {
          throw new Error("auxiliary unavailable");
        }),
      };
      const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, new Agents(ctx));
      const channel = await channels.resolve({ type: "guild", platform: "test", channelId: "room", guildId: "room" });
      const botOne = { selfId: "one", platform: "test", sendMessage: vi.fn() };
      const botTwo = { selfId: "two", platform: "test", sendMessage: vi.fn() };
      const [first, same] = await Promise.all([runtimes.get(channel, botOne as never), runtimes.get(channel, botOne as never)]);
      expect(first).toBe(same);
      const replacement = await runtimes.get(channel, botTwo as never);
      expect(replacement).not.toBe(first);
      expect(replacement.context).toEqual({ type: "guild", platform: "test", channelId: "room", guildId: "room" });
      await runtimes.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("recreates a cached runtime after channel plugin registrations change", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtimes-"));
    try {
      const ctx = new Context();
      const channels = new Channels(ctx, { basePath: root });
      const model = {
        resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {} })),
        resolveAuxiliaryModel: vi.fn(() => {
          throw new Error("auxiliary unavailable");
        }),
      };
      const agents = new Agents(ctx);
      const oldSetup = vi.fn(async () => ({ name: "old-image-tools" }));
      const disposeOld = agents.use({ setup: oldSetup });
      const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, agents);
      const scope = { type: "direct", platform: "test", selfId: "bot", userId: "user", channelId: "room" } as const;
      const channel = await channels.resolve(scope);
      const bot = { platform: "test", selfId: "bot" };

      const first = await runtimes.get(channel, bot as never);
      expect(oldSetup).toHaveBeenCalledOnce();

      disposeOld();
      const newSetup = vi.fn(async () => ({ name: "new-image-tools" }));
      agents.use({ setup: newSetup });
      const replacement = await runtimes.get(channel, bot as never);

      expect(replacement).not.toBe(first);
      expect(newSetup).toHaveBeenCalledOnce();
      await runtimes.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recreates and stops a cached runtime after message-batch registrations change", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtimes-"));
    try {
      const ctx = new Context();
      const channels = new Channels(ctx, { basePath: root });
      const model = {
        resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {} })),
        resolveAuxiliaryModel: vi.fn(() => {
          throw new Error("auxiliary unavailable");
        }),
      };
      const batches = new MessageBatchRegistry();
      const controller = { enqueue: vi.fn(), stop: vi.fn() };
      const dispose = batches.use({ priority: 0, match: () => true, setup: vi.fn(async () => controller) });
      const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, new Agents(ctx), batches);
      const scope = { type: "direct", platform: "test", selfId: "bot", userId: "user", channelId: "room" } as const;
      const channel = await channels.resolve(scope);
      const bot = { platform: "test", selfId: "bot" };
      const first = await runtimes.get(channel, bot as never);

      dispose();
      await vi.waitFor(() => expect(controller.stop).toHaveBeenCalledOnce());
      const replacement = await runtimes.get(channel, bot as never);

      expect(replacement).not.toBe(first);
      await runtimes.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("proactively retires a cached runtime when polisher registration changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtimes-polisher-invalidate-"));
    try {
      vi.mocked(createAgent).mockClear();
      const ctx = new Context();
      const channels = new Channels(ctx, { basePath: root });
      const model = {
        resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {} })),
        resolveAuxiliaryModel: vi.fn(() => {
          throw new Error("auxiliary unavailable");
        }),
      };
      const polishers = new PolisherRegistry();
      const dispose = polishers.use({ name: "test", polish: vi.fn(async () => undefined) });
      const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, new Agents(ctx), new MessageBatchRegistry(), polishers);
      const channel = await channels.resolve({ type: "direct", platform: "test", channelId: "user", userId: "user", selfId: "bot" });
      const bot = { platform: "test", selfId: "bot" };

      const first = await runtimes.get(channel, bot as never);
      const firstAgent = vi.mocked(createAgent).mock.results.at(-1)?.value;
      const firstConfig = vi.mocked(createAgent).mock.calls.at(-1)?.[0];
      if (!firstConfig || typeof firstConfig.systemPrompt !== "function") throw new Error("Initial Agent prompt was not captured");
      const firstPrompt = (await firstConfig.systemPrompt()).map((block) => String(block.content)).join("\n");
      expect(firstPrompt).not.toContain("<persona>");

      dispose();
      await vi.waitFor(() => expect(firstAgent?.stop).toHaveBeenCalledOnce());
      const replacement = await runtimes.get(channel, bot as never);
      const replacementConfig = vi.mocked(createAgent).mock.calls.at(-1)?.[0];
      if (!replacementConfig || typeof replacementConfig.systemPrompt !== "function") throw new Error("Replacement Agent prompt was not captured");
      const replacementPrompt = (await replacementConfig.systemPrompt()).map((block) => String(block.content)).join("\n");

      expect(replacement).not.toBe(first);
      expect(replacementPrompt).toContain("<persona>");
      await runtimes.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not publish a runtime whose message-batch plugin was removed during setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtimes-"));
    try {
      const ctx = new Context();
      const channels = new Channels(ctx, { basePath: root });
      const model = {
        revision: 0,
        resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {} })),
        resolveAuxiliaryModel: vi.fn(() => {
          throw new Error("auxiliary unavailable");
        }),
      };
      const batches = new MessageBatchRegistry();
      const controller = { enqueue: vi.fn(), stop: vi.fn() };
      let markSetupStarted!: () => void;
      let releaseSetup!: () => void;
      const setupStarted = new Promise<void>((resolve) => {
        markSetupStarted = resolve;
      });
      const setupRelease = new Promise<void>((resolve) => {
        releaseSetup = resolve;
      });
      const dispose = batches.use({
        priority: 0,
        match: () => true,
        setup: vi.fn(async () => {
          markSetupStarted();
          await setupRelease;
          return controller;
        }),
      });
      const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, new Agents(ctx), batches);
      const scope = { type: "direct", platform: "test", selfId: "bot", userId: "user", channelId: "room" } as const;
      const channel = await channels.resolve(scope);
      const bot = { platform: "test", selfId: "bot" };
      const pending = runtimes.get(channel, bot as never);

      await setupStarted;
      dispose();
      releaseSetup();
      const current = await pending;
      await current.handle(message("message-1", "user", 1));

      expect(controller.stop).toHaveBeenCalledOnce();
      expect(controller.enqueue).not.toHaveBeenCalled();
      await runtimes.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recreates a cached runtime after the model registry revision changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtimes-"));
    try {
      const ctx = new Context();
      const channels = new Channels(ctx, { basePath: root });
      const model = {
        revision: 1,
        resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {} })),
        resolveAuxiliaryModel: vi.fn(() => {
          throw new Error("auxiliary unavailable");
        }),
      };
      const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, new Agents(ctx));
      const scope = { type: "direct", platform: "test", selfId: "bot", userId: "user", channelId: "room" } as const;
      const channel = await channels.resolve(scope);
      const bot = { platform: "test", selfId: "bot" };
      const first = await runtimes.get(channel, bot as never);

      model.revision += 1;
      const replacement = await runtimes.get(channel, bot as never);

      expect(replacement).not.toBe(first);
      await runtimes.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("proactively retires a cached runtime when the model registry changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtimes-"));
    try {
      vi.mocked(createAgent).mockClear();
      const ctx = new Context();
      const channels = new Channels(ctx, { basePath: root });
      const model = {
        revision: 1,
        resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {} })),
        resolveAuxiliaryModel: vi.fn(() => {
          throw new Error("auxiliary unavailable");
        }),
      };
      const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, new Agents(ctx));
      const scope = { type: "direct", platform: "test", selfId: "bot", userId: "user", channelId: "room" } as const;
      const channel = await channels.resolve(scope);
      const bot = { platform: "test", selfId: "bot" };
      const first = await runtimes.get(channel, bot as never);
      const firstAgent = vi.mocked(createAgent).mock.results.at(-1)?.value;

      model.revision = 2;
      ctx.emit("yesimbot/model-registry-changed", 2);
      await vi.waitFor(() => expect(firstAgent?.stop).toHaveBeenCalledOnce());
      const replacement = await runtimes.get(channel, bot as never);

      expect(replacement).not.toBe(first);
      await runtimes.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes unsupported primary image tool results through the configured vision model", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtimes-"));
    try {
      vi.mocked(createAgent).mockClear();
      const ctx = new Context();
      const channels = new Channels(ctx, { basePath: root });
      const chat = {
        fullId: "test:model",
        providerId: "test",
        modelId: "model",
        model: {} as never,
        entry: { modalities: { input: ["image"] } },
        capabilities: { imageToolResult: "unsupported" },
      };
      const vision = {
        fullId: "vision:model",
        providerId: "vision",
        modelId: "model",
        model: {} as never,
        entry: { modalities: { input: ["image"] } },
      };
      const model = {
        resolveChatModel: vi.fn((fullId: string) => (fullId === "vision:model" ? vision : chat)),
      };
      const runtimes = new Runtimes(
        ctx,
        channels,
        model as never,
        { ...config, basePath: root, visionModel: "vision:model", imageInput: true },
        new Agents(ctx),
      );
      const scope = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
      const channel = await channels.resolve(scope);
      const runtime = await runtimes.get(channel, { platform: "test", selfId: "bot" } as never);
      const agentConfig = vi.mocked(createAgent).mock.calls.at(-1)?.[0];
      const tools = (agentConfig?.tools ?? []) as Array<{ name?: string; description?: string }>;
      const read = tools.find((tool) => tool.name === "read");

      expect(model.resolveChatModel).toHaveBeenNthCalledWith(1, "test:model", scope);
      expect(model.resolveChatModel).toHaveBeenNthCalledWith(2, "vision:model", scope);
      expect(tools.map((tool) => tool.name)).toContain("describe_image");
      expect(read?.description).toContain("自动调用视觉模型");
      expect(read?.description).toContain("主模型不会接收原始图片字节");
      expect(read?.description).not.toContain("图片字节将随结果返回");

      await runtime.stop();
      await runtimes.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("does not register describe_image when the configured visionModel lacks image input", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtimes-"));
    try {
      vi.mocked(createAgent).mockClear();
      const ctx = new Context();
      const channels = new Channels(ctx, { basePath: root });
      const model = {
        resolveChatModel: vi.fn((fullId: string) => ({
          fullId,
          providerId: fullId.split(":", 1)[0],
          modelId: fullId.split(":", 2)[1],
          model: {} as never,
          entry: { modalities: { input: ["text"] } },
        })),
        resolveAuxiliaryModel: vi.fn(() => {
          throw new Error("auxiliary unavailable");
        }),
      };
      const runtimes = new Runtimes(
        ctx,
        channels,
        model as never,
        { ...config, basePath: root, visionModel: "vision:model", imageInput: false },
        new Agents(ctx),
      );
      const scope = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
      const runtime = await runtimes.get(await channels.resolve(scope), { platform: "test", selfId: "bot" } as never);
      const agentConfig = vi.mocked(createAgent).mock.calls.at(-1)?.[0];
      const tools = (agentConfig?.tools ?? []) as Array<{ name?: string }>;

      expect(tools.map((tool) => tool.name)).not.toContain("describe_image");

      await runtime.stop();
      await runtimes.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps direct runtimes isolated by selfId", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtimes-"));
    try {
      const ctx = new Context();
      const channels = new Channels(ctx, { basePath: root });
      const model = {
        resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {} })),
        resolveAuxiliaryModel: vi.fn(() => {
          throw new Error("auxiliary unavailable");
        }),
      };
      const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, new Agents(ctx));
      const scopeOne = { type: "direct", platform: "test", selfId: "one", userId: "user-1", channelId: "room" } as const;
      const scopeTwo = { type: "direct", platform: "test", selfId: "two", userId: "user-1", channelId: "room" } as const;
      const [first, second] = await Promise.all([
        runtimes.get(await channels.resolve(scopeOne), { platform: "test", selfId: "one" } as never),
        runtimes.get(await channels.resolve(scopeTwo), { platform: "test", selfId: "two" } as never),
      ]);
      expect(first).not.toBe(second);
      expect(first.context).toEqual(scopeOne);
      expect(second.context).toEqual(scopeTwo);
      await runtimes.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recreates a runtime after reset and rejects new admission after stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtimes-"));
    try {
      const ctx = new Context();
      const channels = new Channels(ctx, { basePath: root });
      const model = {
        resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {} })),
        resolveAuxiliaryModel: vi.fn(() => {
          throw new Error("auxiliary unavailable");
        }),
      };
      const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, new Agents(ctx));
      const scope = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
      const bot = { platform: "test", selfId: "one" };
      const first = await runtimes.get(await channels.resolve(scope), bot as never);
      await runtimes.reset(scope);
      const second = await runtimes.get(await channels.resolve(scope), bot as never);
      expect(second).not.toBe(first);
      await runtimes.stop();
      await expect(runtimes.get(await channels.resolve(scope), bot as never)).rejects.toThrow("stopped");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("keeps different shared channel identities isolated", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtimes-"));
    try {
      const ctx = new Context();
      const channels = new Channels(ctx, { basePath: root });
      const model = {
        resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {} })),
        resolveAuxiliaryModel: vi.fn(() => {
          throw new Error("auxiliary unavailable");
        }),
      };
      const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, new Agents(ctx));
      const one = { type: "guild", platform: "test", channelId: "one", guildId: "one" } as const;
      const two = { type: "guild", platform: "test", channelId: "two", guildId: "two" } as const;
      const first = await runtimes.get(await channels.resolve(one), { platform: "test", selfId: "bot" } as never);
      const second = await runtimes.get(await channels.resolve(two), { platform: "test", selfId: "bot" } as never);
      expect(first).not.toBe(second);
      expect(first.context).toEqual(one);
      expect(second.context).toEqual(two);
      await runtimes.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Runtimes status", () => {
  it("reports active session details from its persisted entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtimes-"));
    try {
      const ctx = new Context();
      const channels = new Channels(ctx, { basePath: root });
      const model = {
        resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {} })),
        resolveAuxiliaryModel: vi.fn(() => {
          throw new Error("auxiliary unavailable");
        }),
      };
      const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, new Agents(ctx));
      const scope = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
      const conversation = (await channels.resolve(scope)).conversation;
      await conversation.storage.append(
        createEntry("message", { id: "before", timestamp: 1, role: "user", content: "before" }),
        createEntry("compact", { summary: "summary", lastEntryId: "before", sourceSession: "old" }),
        createEntry("message", { id: "after", timestamp: 1_723_456_789_000, role: "assistant", content: "after" }),
      );

      const status = await runtimes.status(scope);
      expect(status).toMatch(/^活动会话：\d{8}T\d{6}Z\.jsonl/m);
      expect(status).toContain("消息：2");
      expect(status).toContain("压缩：1");
      expect(status).toContain("自上次压缩以来消息：1");
      expect(status).toContain("连续失败：0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Agent message protocol enforcement
// ---------------------------------------------------------------------------

async function protocolRuntime(overrides: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-protocol-"));
  const ctx = new Context();
  const channels = new Channels(ctx, { basePath: root });
  const model = {
    resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {}, ...overrides })),
    resolveAuxiliaryModel: vi.fn(() => {
      throw new Error("auxiliary unavailable");
    }),
  };
  const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, new Agents(ctx));
  const channel = await channels.resolve({ type: "guild", platform: "test", channelId: "room", guildId: "room" });
  await runtimes.get(channel, { platform: "test", selfId: "bot" } as never);
  return { root, runtimes };
}

describe("agent message protocol enforcement", () => {
  beforeEach(() => {
    state.active = null;
    vi.mocked(createAgent).mockClear();
    state.append.mockReset().mockResolvedValue(undefined);
    state.send.mockReset();
    state.run.mockReset().mockReturnValue((async function* () {})());
    state.decide.mockReset().mockResolvedValue("wait");
    state.decideBatch.mockReset().mockResolvedValue({ decision: "wait" });
    state.settleReservation.mockReset().mockResolvedValue(undefined);
    state.observe.mockReset();
  });

  it("requires a terminal tool and forces the tool choice only for a declared function-calling model", async () => {
    const { root, runtimes } = await protocolRuntime({ entry: { toolCall: true } });
    try {
      const agentConfig = vi.mocked(createAgent).mock.calls.at(-1)?.[0];
      expect(agentConfig?.requireTerminalTool).toBe(true);
      expect(agentConfig?.toolChoice).toBe("required");
    } finally {
      await runtimes.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["an unknown capability", {}],
    ["a disabled capability", { toolCall: false }],
  ])("requires a terminal tool without forcing for %s", async (_label, entry) => {
    const { root, runtimes } = await protocolRuntime({ entry });
    try {
      const agentConfig = vi.mocked(createAgent).mock.calls.at(-1)?.[0];
      expect(agentConfig?.requireTerminalTool).toBe(true);
      expect(agentConfig?.toolChoice).toBeUndefined();
    } finally {
      await runtimes.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not force a tool choice when provider-defined tools are mixed in", async () => {
    const { root, runtimes } = await protocolRuntime({
      entry: { toolCall: true },
      tools: { web_search: { type: "provider", id: "test.web_search", inputSchema: {} } },
    });
    try {
      const agentConfig = vi.mocked(createAgent).mock.calls.at(-1)?.[0];
      expect(agentConfig?.requireTerminalTool).toBe(true);
      expect(agentConfig?.toolChoice).toBeUndefined();
      expect(agentConfig?.providerTools).toBeDefined();
    } finally {
      await runtimes.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes an argument-free finish tool", async () => {
    const { value, root } = await runtime();
    try {
      const finish = vi
        .mocked(createAgent)
        .mock.calls.at(-1)?.[0]
        .tools?.find((tool) => tool.name === "finish");
      const schema = (finish?.inputSchema as { jsonSchema?: { properties?: Record<string, unknown>; required?: string[] } } | undefined)?.jsonSchema;
      expect(finish?.terminal).toBe(true);
      expect(schema?.properties).toEqual({});
      expect(schema?.required ?? []).not.toContain("reason");
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a protocol violation, including a delivered marker, as a failed turn that never sends platform text", async () => {
    state.run.mockReturnValue(
      (async function* () {
        yield { type: "turn.start", turnId: "turn-protocol" };
        yield {
          type: "message.appended",
          turnId: "turn-protocol",
          message: { role: "assistant", id: "message-1", content: "[DELIVERED_MESSAGE]\n模型误输出\n[/DELIVERED_MESSAGE]" },
        };
        yield {
          type: "turn.failed",
          turnId: "turn-protocol",
          error: { name: "AgentProtocolError", message: "Agent turn ended without a terminal tool call (text-only)" },
        };
      })(),
    );
    const bot = { selfId: "bot", sendMessage: vi.fn() };
    const { value, root } = await runtime(undefined, {}, bot);
    try {
      const result = await value.post(event);
      expect(result.kind).toBe("run");
      if (result.kind === "run") await result.done;

      expect(bot.sendMessage).not.toHaveBeenCalled();
      expect(state.send).not.toHaveBeenCalled();
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases the reservation when a protocol violation ends the turn without delivery", async () => {
    state.decideBatch.mockResolvedValue({ decision: "trigger", reservationId: "reservation-protocol" });
    const sendMessage = vi.fn();
    state.run.mockImplementation(() =>
      (async function* () {
        yield { type: "turn.start", turnId: "turn-protocol" };
        yield { type: "message.appended", turnId: "turn-protocol", message: { role: "assistant", id: "message-1", content: "只有文本" } };
        yield {
          type: "turn.failed",
          turnId: "turn-protocol",
          error: { name: "AgentProtocolError", message: "Agent turn ended without a terminal tool call (text-only)" },
        };
      })(),
    );
    const will = { decide: state.decide, decideBatch: state.decideBatch, settleReservation: state.settleReservation, observe: state.observe };
    const { value, root } = await runtime(undefined, {}, { selfId: "bot", sendMessage }, undefined, undefined, will);
    try {
      const result = await value.handle(message("message", "user", 1));
      if (result.kind === "run") await result.done;

      expect(sendMessage).not.toHaveBeenCalled();
      expect(state.settleReservation).toHaveBeenCalledWith("reservation-protocol", { kind: "release", turnId: "turn-protocol", reason: "failed" });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat an empty delivery receipt as platform delivery", async () => {
    state.decideBatch.mockResolvedValue({ decision: "trigger", reservationId: "reservation-empty" });
    const sendMessage = vi.fn(async () => []);
    state.run.mockImplementation(() =>
      (async function* () {
        yield { type: "turn.start", turnId: "turn-empty" };
        const send = vi
          .mocked(createAgent)
          .mock.calls.at(-1)?.[0]
          .tools?.find((tool) => tool.name === "send_message");
        await send?.execute?.({ messages: ["这条没有拿到 messageId"] }, { toolCallId: "call", turnId: "turn-empty", abortSignal: undefined } as never);
        yield { type: "turn.done", turnId: "turn-empty" };
      })(),
    );
    const will = { decide: state.decide, decideBatch: state.decideBatch, settleReservation: state.settleReservation, observe: state.observe };
    const { value, root } = await runtime(undefined, {}, { selfId: "bot", sendMessage }, undefined, undefined, will);
    try {
      const result = await value.handle(message("message", "user", 1));
      if (result.kind === "run") await result.done;

      expect(sendMessage).toHaveBeenCalledOnce();
      expect(state.settleReservation).toHaveBeenCalledWith("reservation-empty", { kind: "release", turnId: "turn-empty", reason: "done-without-delivery" });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("commits the reservation only on a real current-channel delivery callback", async () => {
    state.decideBatch.mockResolvedValue({ decision: "trigger", reservationId: "reservation-delivered" });
    const sendMessage = vi.fn(async () => ["platform-1"]);
    state.run.mockImplementation(() =>
      (async function* () {
        yield { type: "turn.start", turnId: "turn-delivered" };
        const send = vi
          .mocked(createAgent)
          .mock.calls.at(-1)?.[0]
          .tools?.find((tool) => tool.name === "send_message");
        const outcome = await send?.execute?.({ messages: ["真实送达"] }, { toolCallId: "call", turnId: "turn-delivered", abortSignal: undefined } as never);
        expect(outcome).toMatchObject({ ok: true, messageIds: ["platform-1"] });
        yield { type: "turn.done", turnId: "turn-delivered" };
      })(),
    );
    const will = { decide: state.decide, decideBatch: state.decideBatch, settleReservation: state.settleReservation, observe: state.observe };
    const { value, root } = await runtime(undefined, {}, { selfId: "bot", sendMessage }, undefined, undefined, will);
    try {
      const result = await value.handle(message("message", "user", 1));
      if (result.kind === "run") await result.done;

      expect(sendMessage).toHaveBeenCalledWith("room", expect.anything());
      expect(state.settleReservation).toHaveBeenCalledWith("reservation-delivered", { kind: "commit", turnId: "turn-delivered", messageId: "platform-1" });
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ChannelRuntime polisher wiring", () => {
  it("delegates the main prompt and requires facts while a polisher is active", async () => {
    const polisher = { name: "test", polish: vi.fn() };
    const { value, root } = await runtime(undefined, {}, { selfId: "bot", sendMessage: vi.fn() }, undefined, undefined, undefined, polisher, async () => [
      "draft",
    ]);
    try {
      const agentConfig = vi.mocked(createAgent).mock.calls.at(-1)?.[0];
      if (!agentConfig || typeof agentConfig.systemPrompt !== "function") throw new Error("Agent system prompt was not captured");
      const systemPrompt = agentConfig.systemPrompt as () => Promise<Array<{ content: unknown }>>;
      const all = (await systemPrompt()).map((block) => String(block.content)).join("\n");
      expect(all).not.toContain("<persona>");
      expect(all).toContain("facts");

      const send = agentConfig.tools?.find((tool) => tool.name === "send_message");
      if (!send) throw new Error("send_message tool was not captured");
      expect((send.inputSchema as { jsonSchema: { required?: string[] } }).jsonSchema.required).toEqual(["facts", "messages"]);
      expect(send.description).not.toContain("persona");
      expect(send.description).not.toContain("语域");
      expect(send.description).toContain("事实、判断和交流动作");
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the baseline prompt and schema when no polisher is active", async () => {
    const { value, root } = await runtime();
    try {
      const agentConfig = vi.mocked(createAgent).mock.calls.at(-1)?.[0];
      if (!agentConfig || typeof agentConfig.systemPrompt !== "function") throw new Error("Agent system prompt was not captured");
      const systemPrompt = agentConfig.systemPrompt as () => Promise<Array<{ content: unknown }>>;
      const all = (await systemPrompt()).map((block) => String(block.content)).join("\n");
      expect(all).toContain("<persona>");

      const send = agentConfig.tools?.find((tool) => tool.name === "send_message");
      if (!send) throw new Error("send_message tool was not captured");
      expect((send.inputSchema as { jsonSchema: { required?: string[] } }).jsonSchema.required).toEqual(["messages"]);
      expect(send.description).toContain("用当前 persona");
      expect(send.description).toContain("语域");
    } finally {
      await value.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Runtimes polisher revisions", () => {
  it("retries runtime creation when the polisher registration changes during setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-runtimes-polisher-race-"));
    try {
      const ctx = new Context();
      const channels = new Channels(ctx, { basePath: root });
      const model = {
        resolveChatModel: vi.fn(() => ({ model: {} as never, entry: {} })),
        resolveAuxiliaryModel: vi.fn(() => {
          throw new Error("auxiliary unavailable");
        }),
      };
      const agents = new Agents(ctx);
      const polishers = new PolisherRegistry();
      const capability: MessagePolisherCapability = { name: "test", polish: vi.fn(async () => undefined) };
      const disposePolisher = polishers.use(capability);
      let setupCount = 0;
      let markSetupStarted!: () => void;
      let releaseSetup!: () => void;
      const setupStarted = new Promise<void>((resolve) => {
        markSetupStarted = resolve;
      });
      const setupRelease = new Promise<void>((resolve) => {
        releaseSetup = resolve;
      });
      const activeStates: boolean[] = [];
      agents.use({
        setup: vi.fn(async (_context, _bot, runtimeContext) => {
          activeStates.push(runtimeContext?.polisherActive ?? false);
          setupCount += 1;
          if (setupCount === 1) {
            markSetupStarted();
            await setupRelease;
          }
          return { name: "setup-gate" };
        }),
      });
      const runtimes = new Runtimes(ctx, channels, model as never, { ...config, basePath: root }, agents, new MessageBatchRegistry(), polishers);
      const channel = await channels.resolve({ type: "guild", platform: "test", channelId: "room", guildId: "room" });
      const before = vi.mocked(createAgent).mock.calls.length;
      const pending = runtimes.get(channel, { platform: "test", selfId: "bot" } as never);

      await setupStarted;
      disposePolisher();
      releaseSetup();
      const runtime = await pending;

      expect(vi.mocked(createAgent).mock.calls.length - before).toBe(2);
      expect(activeStates).toEqual([true, false]);
      const discarded = vi.mocked(createAgent).mock.calls.at(-2)?.[0];
      const current = vi.mocked(createAgent).mock.calls.at(-1)?.[0];
      if (!discarded || !current) throw new Error("Runtime Agent configurations were not captured");
      const promptOf = (agentConfig: NonNullable<typeof current>) => {
        if (typeof agentConfig.systemPrompt !== "function") throw new Error("Agent system prompt was not captured");
        return agentConfig.systemPrompt as () => Promise<Array<{ content: unknown }>>;
      };
      const discardedPrompt = (await promptOf(discarded)()).map((block) => String(block.content)).join("\n");
      const currentPrompt = (await promptOf(current)()).map((block) => String(block.content)).join("\n");
      const currentSend = current.tools?.find((tool) => tool.name === "send_message");
      if (!currentSend) throw new Error("send_message tool was not captured");

      expect(discardedPrompt).not.toContain("<persona>");
      expect(currentPrompt).toContain("<persona>");
      expect((currentSend.inputSchema as { jsonSchema: { required?: string[] } }).jsonSchema.required).toEqual(["messages"]);
      expect(runtime).toBeDefined();
      await runtimes.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
