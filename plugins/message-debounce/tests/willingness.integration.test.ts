import { Context, h, type Universal } from "@koishijs/core";
import { createMessage, type Event, type Message, type MessageBatchInput } from "koishi-plugin-yesimbot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { createMemoryWillingnessStore } from "../../will-policy/src/store.js";
import { defaultWillingnessConfig } from "../../will-policy/src/types.js";
import { PolicyWillingnessEngine } from "../../will-policy/src/willingness.js";
import { MessageDebounceController } from "../src/index.js";

const NOW = 1_000_000;

function message(id: string, userId: string): Message {
  return createMessage({
    platform: "test",
    selfId: "bot",
    timestamp: NOW,
    channel: { id: "room", type: 0 as Universal.Channel.Type },
    user: { id: userId },
    messageId: id,
    elements: [h.text("hello")],
  });
}

function poke(): Event {
  return {
    id: "poke",
    timestamp: NOW,
    role: "custom",
    type: "yesimbot.event",
    data: {
      eventType: "notice.poke",
      platform: "test",
      selfId: "bot",
      channel: { id: "room", type: 0 },
      actorId: "bob",
      targetId: "bot",
      action: "拍了拍",
      text: "typed poke",
    },
  } as Event;
}

describe("real debounce and willingness integration", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("forms one message-poke-message batch, samples once, and creates one durable-style reservation", async () => {
    const random = vi.fn(() => 0);
    const store = createMemoryWillingnessStore();
    const engine = new PolicyWillingnessEngine(
      {
        ...defaultWillingnessConfig(),
        batchDecision: "highest-candidate",
        decayMode: "half-life",
        maxScore: 100,
        probabilityThreshold: 54.2,
        probabilityAmplifier: 0.0355,
        replyCost: 35,
        textGain: 12,
        imageGain: 0,
        directGain: 66,
        mentionGain: 66,
        quoteGain: 66,
        pokeGain: 66,
        keywords: ["MyGO", "乐队", "吉他", "练习", "演出"],
        keywordMultiplier: 1.5,
        defaultMultiplier: 1,
      },
      { debug: vi.fn(), warn: vi.fn() },
      { selfId: "bot", store, random, now: () => NOW },
    );
    await engine.initialize();
    const decisions: Awaited<ReturnType<NonNullable<typeof engine.decideBatch>>>[] = [];
    const controller = new MessageDebounceController(
      new Context(),
      15_000,
      vi.fn(async () => undefined),
      async (inputs: readonly MessageBatchInput[]) => {
        decisions.push(await engine.decideBatch!(inputs, { activeTurnId: null }));
      },
      { debug: vi.fn(), warn: vi.fn() } as never,
      vi.fn(),
    );

    controller.enqueue(message("before", "alice"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.enqueueEvent(poke())).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    controller.enqueue(message("after", "carol"));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: "trigger", candidate: { authorId: "bob" }, reservationId: expect.any(String) });
    expect(random).toHaveBeenCalledOnce();
    const bot = store.readBot("bot");
    expect(Object.keys(bot.authors).sort()).toEqual(["alice", "bob", "carol"]);
    expect(Object.values(bot.reservations)).toEqual([expect.objectContaining({ authorId: "bob", amount: 12 })]);
  });
});
