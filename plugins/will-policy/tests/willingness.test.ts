import type { Universal } from "koishi";
import { createMessage, type Event, type Message } from "koishi-plugin-yesimbot";
import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { defaultWillingnessConfig } from "../src/types.js";
import { PolicyWillingnessEngine } from "../src/willingness.js";

const state = { activeTurnId: null };
const logger = { debug: vi.fn() };

function message(elements: unknown[], channelType = 0 as Universal.Channel.Type, userId = "user-1"): Message {
  return createMessage({
    platform: "test",
    selfId: "bot-1",
    timestamp: 1,
    channel: { id: "room-1", type: channelType },
    user: { id: userId },
    messageId: "m-1",
    elements: elements as never,
  });
}

function pokeEvent(): Event {
  return {
    id: "event-1",
    timestamp: 1,
    role: "custom",
    type: "yesimbot.event",
    data: {
      eventType: "notice.poke",
      platform: "test",
      selfId: "bot-1",
      timestamp: 1,
      channel: { id: "room-1", type: 0 },
      targetId: "user-1",
      action: "拍了拍",
      text: "user-1 拍了拍 bot-1",
    },
  };
}

describe("PolicyWillingnessEngine", () => {
  it("forces mention triggers when configured", async () => {
    const engine = new PolicyWillingnessEngine({ ...defaultWillingnessConfig(), probabilityThreshold: 100, mentionForce: true }, logger);

    await expect(engine.decide(message([{ type: "at", attrs: { id: "bot-1" }, children: [] }]), state)).resolves.toBe("trigger");
    expect(engine.getCurrentWillingness("user-1")).toBe(0);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("will_policy.willingness"), expect.any(Object));
  });

  it("samples probability from the willingness score", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.9);
    try {
      const engine = new PolicyWillingnessEngine({ ...defaultWillingnessConfig(), probabilityThreshold: 0, textGain: 100, maxScore: 100 }, logger);

      await expect(engine.decide(message([]), state)).resolves.toBe("trigger");
    } finally {
      random.mockRestore();
    }
  });

  it("adds image gain when a message contains an image", async () => {
    const engine = new PolicyWillingnessEngine({ ...defaultWillingnessConfig(), probabilityThreshold: 0, imageGain: 60, textGain: 0, maxScore: 100 }, logger);

    await expect(engine.decide(message([{ type: "img", attrs: { id: "asset-1" }, children: [] }]), state)).resolves.toBe("trigger");
    expect(engine.getCurrentWillingness()).toBeGreaterThan(0);
  });

  it("adds poke gain for poke events", async () => {
    const engine = new PolicyWillingnessEngine({ ...defaultWillingnessConfig(), probabilityThreshold: 0, pokeGain: 80, maxScore: 100 }, logger);

    await expect(engine.decide(pokeEvent(), state)).resolves.toBe("trigger");
    expect(engine.getCurrentWillingness()).toBeGreaterThan(0);
  });

  it("does not carry a mention boost into later plain messages", async () => {
    const engine = new PolicyWillingnessEngine({ ...defaultWillingnessConfig(), mentionForce: true }, logger);

    await expect(engine.decide(message([{ type: "at", attrs: { id: "bot-1" }, children: [] }]), state)).resolves.toBe("trigger");
    await expect(engine.decide(message([{ type: "text", attrs: { content: "?" }, children: [] }]), state)).resolves.toBe("wait");
  });

  it("isolates accumulated willingness by message author", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const engine = new PolicyWillingnessEngine(
        { ...defaultWillingnessConfig(), probabilityThreshold: 30, probabilityAmplifier: 1, replyCost: 0, mentionForce: true },
        logger,
      );

      await expect(engine.decide(message([], 0, "user-a"), state)).resolves.toBe("wait");
      await expect(engine.decide(message([], 0, "user-a"), state)).resolves.toBe("wait");
      await expect(engine.decide(message([{ type: "at", attrs: { id: "bot-1" }, children: [] }], 0, "user-a"), state)).resolves.toBe("trigger");

      await expect(engine.decide(message([], 0, "user-b"), state)).resolves.toBe("wait");
      await expect(engine.decide(message([], 0, "user-a"), state)).resolves.toBe("trigger");
    } finally {
      random.mockRestore();
    }
  });

  it("does not treat at-all or at-here as a mention of the bot", async () => {
    const engine = new PolicyWillingnessEngine({ ...defaultWillingnessConfig(), probabilityThreshold: 100, mentionForce: true }, logger);

    await expect(engine.decide(message([{ type: "at", attrs: { type: "all" }, children: [] }]), state)).resolves.toBe("wait");
    await expect(engine.decide(message([{ type: "at", attrs: { type: "here" }, children: [] }]), state)).resolves.toBe("wait");
  });

  it("charges reply cost immediately when a message triggers", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const engine = new PolicyWillingnessEngine(
        {
          ...defaultWillingnessConfig(),
          initialScore: 50,
          probabilityThreshold: 0,
          probabilityAmplifier: 1,
          replyCost: 30,
          textGain: 0,
          mentionGain: 0,
          quoteGain: 0,
          directGain: 0,
          imageGain: 0,
        },
        logger,
      );

      await expect(engine.decide(message([]), state)).resolves.toBe("trigger");
      expect(engine.getCurrentWillingness("user-1")).toBe(20);

      await expect(engine.decide(message([]), state)).resolves.toBe("trigger");
      expect(engine.getCurrentWillingness("user-1")).toBe(0);
    } finally {
      random.mockRestore();
    }
  });
});
