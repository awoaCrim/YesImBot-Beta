import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import type { ChannelContext, Event, Message, MessageBatchInput, MessageBatchPlugin } from "koishi-plugin-yesimbot";

import MessageDebouncePlugin, { Config } from "../src/index.js";

const groupContext: ChannelContext = { type: "guild", platform: "test", channelId: "room", guildId: "room" };
const directContext: ChannelContext = { type: "direct", platform: "test", channelId: "private", selfId: "bot", userId: "user" };

function message(messageId: string, userId: string, timestamp = Date.now()): Message {
  return {
    id: `entry-${messageId}`,
    role: "custom",
    type: "yesimbot.message",
    timestamp,
    data: {
      platform: "test",
      selfId: "bot",
      channel: { id: "room", type: 0 },
      user: { id: userId, name: userId },
      messageId,
      elements: [],
    },
  } as Message;
}

function event(eventType: string, overrides: Record<string, unknown> = {}): Event {
  return {
    id: `event-${eventType}`,
    role: "custom",
    type: "yesimbot.event",
    timestamp: Date.now(),
    data: {
      eventType,
      platform: "test",
      selfId: "bot",
      channel: { id: "room", type: 0 },
      text: eventType,
      ...overrides,
    },
  } as Event;
}

function createHarness(config: { quietSeconds?: number } = {}) {
  const registered: MessageBatchPlugin[] = [];
  const disposeRegistration = vi.fn();
  const use = vi.fn((plugin: MessageBatchPlugin) => {
    registered.push(plugin);
    return disposeRegistration;
  });
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const ctx = {
    logger: vi.fn(() => logger),
    on: vi.fn(),
    setTimeout: vi.fn((callback: () => void, delay: number) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    }),
    yesimbot: { message: { use } },
  };
  const plugin = new MessageDebouncePlugin(ctx as never, config as never);
  return { ctx, disposeRegistration, logger, plugin, registered, use };
}

async function setupController(
  context: ChannelContext = groupContext,
  config: { quietSeconds?: number } = {},
  flush = vi.fn(async (_messages: readonly Message[]) => undefined),
) {
  const harness = createHarness(config);
  const controller = await harness.registered[0]!.setup(context, flush);
  return { ...harness, controller, flush };
}

describe("MessageDebouncePlugin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses a 15-second default and flushes the first message only after the quiet window", async () => {
    expect((Config({}) as { quietSeconds: number }).quietSeconds).toBe(15);
    const { controller, flush, plugin } = await setupController();

    controller.enqueue(message("one", "user-1"));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith([expect.objectContaining({ data: expect.objectContaining({ messageId: "one" }) })]);
    plugin.stop();
  });

  it("refreshes the trailing edge on every message and can extend waiting indefinitely", async () => {
    const { controller, flush, plugin } = await setupController();
    controller.enqueue(message("one", "user-1"));

    for (let index = 2; index <= 4; index += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      controller.enqueue(message(String(index), `user-${index}`));
      expect(flush).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(14_999);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.calls[0]?.[0].map((input) => input.data.messageId)).toEqual(["one", "2", "3", "4"]);
    plugin.stop();
  });

  it("batches a typed targeted poke with surrounding messages and refreshes the same trailing edge", async () => {
    const harness = createHarness();
    const flushInputs = vi.fn(async (_inputs: readonly MessageBatchInput[]) => undefined);
    const controller = await harness.registered[0]!.setup(groupContext, vi.fn(), { flushInputs });

    controller.enqueue(message("before", "alice"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.enqueueEvent?.(event("notice.poke", { actorId: "bob", targetId: "bot" }))).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    controller.enqueue(message("after", "carol"));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(flushInputs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(flushInputs).toHaveBeenCalledOnce();
    expect(flushInputs.mock.calls[0]?.[0].map((input) => input.id)).toEqual(["entry-before", "event-notice.poke", "entry-after"]);
    harness.plugin.stop();
  });

  it("rejects non-poke, missing-actor, and wrong-target events without refreshing the timer", async () => {
    const harness = createHarness();
    const flushInputs = vi.fn(async (_inputs: readonly MessageBatchInput[]) => undefined);
    const controller = await harness.registered[0]!.setup(groupContext, vi.fn(), { flushInputs });
    controller.enqueue(message("only", "alice"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(controller.enqueueEvent?.(event("other.event", { actorId: "bob", targetId: "bot" }))).toBe(false);
    expect(controller.enqueueEvent?.(event("notice.poke", { targetId: "bot" }))).toBe(false);
    expect(controller.enqueueEvent?.(event("notice.poke", { actorId: "bob", targetId: "someone-else" }))).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(flushInputs).toHaveBeenCalledOnce();
    expect(flushInputs.mock.calls[0]?.[0].map((input) => input.id)).toEqual(["entry-only"]);
    harness.plugin.stop();
  });

  it("does not admit events when Core did not provide the batch-input extension", async () => {
    const { controller, plugin } = await setupController();
    expect(controller.enqueueEvent?.(event("notice.poke", { actorId: "bob", targetId: "bot" }))).toBe(false);
    plugin.stop();
  });

  it("shares one group batch across authors and behaves the same for direct messages", async () => {
    const harness = createHarness();
    const groupFlush = vi.fn(async () => undefined);
    const directFlush = vi.fn(async () => undefined);
    const group = await harness.registered[0]!.setup(groupContext, groupFlush);
    const direct = await harness.registered[0]!.setup(directContext, directFlush);

    group.enqueue(message("group-1", "alice"));
    group.enqueue(message("group-2", "bob"));
    direct.enqueue(message("direct-1", "carol"));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(groupFlush.mock.calls[0]?.[0].map((input) => input.data.user.id)).toEqual(["alice", "bob"]);
    expect(directFlush.mock.calls[0]?.[0].map((input) => input.data.messageId)).toEqual(["direct-1"]);
    harness.plugin.stop();
  });

  it("keeps different conversations independent", async () => {
    const harness = createHarness();
    const firstFlush = vi.fn(async () => undefined);
    const secondFlush = vi.fn(async () => undefined);
    const first = await harness.registered[0]!.setup(groupContext, firstFlush);
    const second = await harness.registered[0]!.setup({ ...groupContext, channelId: "room-2", guildId: "room-2" }, secondFlush);

    first.enqueue(message("first", "user-1"));
    await vi.advanceTimersByTimeAsync(5_000);
    second.enqueue(message("second", "user-2"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(firstFlush).toHaveBeenCalledOnce();
    expect(secondFlush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(secondFlush).toHaveBeenCalledOnce();
    harness.plugin.stop();
  });

  it("detaches the timed-out snapshot so later messages start a new batch", async () => {
    const { controller, flush, plugin } = await setupController();
    controller.enqueue(message("first", "user-1"));
    await vi.advanceTimersByTimeAsync(15_000);
    controller.enqueue(message("second", "user-2"));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls.map(([inputs]) => inputs.map((input) => input.data.messageId))).toEqual([["first"], ["second"]]);
    plugin.stop();
  });

  it("cancels pending work when the plugin is disposed", async () => {
    const { controller, disposeRegistration, flush, plugin } = await setupController();
    controller.enqueue(message("pending", "user-1"));

    plugin.stop();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(disposeRegistration).toHaveBeenCalledOnce();
    expect(flush).not.toHaveBeenCalled();
  });

  it("rejects stale timer callbacks and cannot flush one snapshot twice", async () => {
    const harness = createHarness();
    const callbacks: Array<() => void> = [];
    vi.spyOn(harness.ctx, "setTimeout").mockImplementation((callback) => {
      callbacks.push(callback);
      return vi.fn();
    });
    const flush = vi.fn(async () => undefined);
    const controller = await harness.registered[0]!.setup(groupContext, flush);

    controller.enqueue(message("first", "user-1"));
    controller.enqueue(message("second", "user-2"));
    callbacks[0]?.();
    callbacks[1]?.();
    await Promise.resolve();

    expect(flush).toHaveBeenCalledOnce();
    expect(flush.mock.calls[0]?.[0].map((input) => input.data.messageId)).toEqual(["first", "second"]);
    harness.plugin.stop();
  });

  it("contains a flush rejection and still accepts later batches", async () => {
    const flush = vi.fn().mockRejectedValueOnce(new Error("flush failed")).mockResolvedValue(undefined);
    const { controller, logger, plugin } = await setupController(groupContext, {}, flush);

    controller.enqueue(message("first", "user-1"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(logger.warn).toHaveBeenCalledWith("message_debounce.flush_failed", expect.objectContaining({ cause: "flush failed" }));

    controller.enqueue(message("second", "user-2"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(flush).toHaveBeenCalledTimes(2);
    plugin.stop();
  });
});
