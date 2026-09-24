import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { h, type Element, type Universal } from "koishi";
import { createMessage, type Event, type Message, type MessageBatchInput } from "koishi-plugin-yesimbot";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { createDurableWillingnessStore, createMemoryWillingnessStore, type WillingnessBotState, type WillingnessStore } from "../src/store.js";
import { defaultWillingnessConfig, type PolicyWillingnessConfig } from "../src/types.js";
import { addGain, PolicyWillingnessEngine } from "../src/willingness.js";

const roots: string[] = [];
const logger = { debug: vi.fn(), warn: vi.fn() };
const state = { activeTurnId: null };
const NOW = 1_800_000;

const calibrated: PolicyWillingnessConfig = {
  ...defaultWillingnessConfig(),
  batchDecision: "highest-candidate",
  decayMode: "half-life",
  persistState: false,
  maxScore: 100,
  initialScore: 0,
  textGain: 12,
  imageGain: 0,
  probabilityThreshold: 54.2,
  probabilityAmplifier: 0.0355,
  directGain: 66,
  mentionGain: 66,
  quoteGain: 66,
  pokeGain: 66,
  replyCost: 35,
  decayHalfLifeSeconds: 600,
  keywords: ["MyGO", "乐队", "吉他", "练习", "演出"],
  keywordMultiplier: 1.5,
  defaultMultiplier: 1,
  mentionForce: false,
  quoteForce: false,
  directForce: false,
};

function message(
  options: {
    id?: string;
    userId?: string;
    timestamp?: number;
    channelType?: Universal.Channel.Type;
    elements?: readonly Element[];
    quote?: Message["data"]["quote"];
  } = {},
): Message {
  const id = options.id ?? "m-1";
  return createMessage({
    platform: "test",
    selfId: "bot-1",
    timestamp: options.timestamp ?? NOW,
    channel: { id: "room-1", type: options.channelType ?? (0 as Universal.Channel.Type) },
    user: { id: options.userId ?? "user-1" },
    messageId: id,
    elements: options.elements ?? [h.text("hello")],
    ...(options.quote ? { quote: options.quote } : {}),
  });
}

function poke(options: { id?: string; actorId?: string; targetId?: string; timestamp?: number } = {}): Event {
  return {
    id: options.id ?? "poke-1",
    timestamp: options.timestamp ?? NOW,
    role: "custom",
    type: "yesimbot.event",
    data: {
      eventType: "notice.poke",
      platform: "test",
      selfId: "bot-1",
      channel: { id: "room-1", type: 0 },
      text: "typed poke",
      ...(options.actorId === undefined ? { actorId: "user-1" } : { actorId: options.actorId }),
      targetId: options.targetId ?? "bot-1",
      action: "拍了拍",
    },
  } as Event;
}

async function createEngine(
  overrides: Partial<PolicyWillingnessConfig> = {},
  options: { random?: () => number; now?: () => number; store?: WillingnessStore; selfId?: string } = {},
) {
  const store = options.store ?? createMemoryWillingnessStore();
  const engine = new PolicyWillingnessEngine({ ...calibrated, ...overrides }, logger, {
    store,
    selfId: options.selfId ?? "bot-1",
    random: options.random,
    now: options.now ?? (() => NOW),
  });
  await engine.initialize();
  return { engine, store };
}

afterEach(async () => {
  logger.debug.mockReset();
  logger.warn.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("highest-candidate willingness", () => {
  it("keeps the legacy default on the required single-input API", () => {
    const engine = new PolicyWillingnessEngine(defaultWillingnessConfig(), logger);
    expect(engine.decideBatch).toBeUndefined();
    expect(engine.settleReservation).toBeUndefined();
  });

  it("matches the approved ordinary-message calibration and samples once per batch", async () => {
    const random = vi.fn(() => 1);
    const { engine } = await createEngine({}, { random });
    const expectedScores = [12, 23.8272, 43.36323632135509, 62.67867936202102, 76.78153418162537];
    const expectedProbabilities = [0, 0, 0, 0.30099311735174616, 0.8016444634477007];

    for (let index = 0; index < 5; index += 1) {
      const result = await engine.decideBatch!([message({ id: `m-${index + 1}` })], state);
      expect(result.decision).toBe("wait");
      expect(result.candidate?.score).toBeCloseTo(expectedScores[index]!, 10);
      expect(result.candidate?.probability).toBeCloseTo(expectedProbabilities[index]!, 10);
    }
    expect(random).toHaveBeenCalledTimes(5);
  });

  it.each([
    ["direct", () => message({ channelType: 1 as Universal.Channel.Type })],
    ["self mention", () => message({ elements: [h.at("bot-1")] })],
    ["self quote", () => message({ quote: { messageId: "quoted", elements: [h.text("old")], author: { id: "bot-1" } } })],
    ["targeted poke", () => poke()],
  ])("gives a first %s input the calibrated probabilistic strong score", async (_label, createInput) => {
    const random = vi.fn(() => 0.9);
    const { engine } = await createEngine({}, { random });

    const result = await engine.decideBatch!([createInput()], state);

    expect(result.decision).toBe("wait");
    expect(result.candidate?.score).toBeCloseTo(77.0496, 10);
    expect(result.candidate?.probability).toBeCloseTo(0.8111608, 10);
    expect(random).toHaveBeenCalledOnce();
  });

  it("uses only the strongest directed signal and never persists the temporary boost", async () => {
    const { engine, store } = await createEngine({}, { random: () => 1 });
    const strong = message({
      channelType: 1 as Universal.Channel.Type,
      elements: [h.at("bot-1")],
      quote: { messageId: "quoted", elements: [h.text("old")], author: { id: "bot-1" } },
    });

    const first = await engine.decideBatch!([strong], state);
    const second = await engine.decideBatch!([message({ id: "ordinary-2" })], state);

    expect(first.candidate?.score).toBeCloseTo(77.0496, 10);
    expect(store.readBot("bot-1").authors["user-1"]?.confirmedScore).toBeCloseTo(23.8272, 10);
    expect(second.candidate?.score).toBeCloseTo(23.8272, 10);
  });

  it("treats images, @all, @here, other-user quotes, and missing-author quotes as ordinary", async () => {
    const inputs = [
      message({ elements: [h("img", { id: "asset" })] }),
      message({ elements: [h("at", { type: "all" })] }),
      message({ elements: [h("at", { type: "here" })] }),
      message({ quote: { messageId: "other", elements: [h.text("old")], author: { id: "other-bot", isBot: true } } }),
      message({ quote: { messageId: "unknown", elements: [h.text("old")] } }),
    ];

    for (const input of inputs) {
      const { engine } = await createEngine({ imageGain: 99 }, { random: () => 1 });
      const result = await engine.decideBatch!([input], state);
      expect(result.candidate?.score).toBeCloseTo(12, 10);
    }
  });

  it("normalizes keyword case and width while excluding quote and reply subtrees", async () => {
    const { engine: matching } = await createEngine({}, { random: () => 1 });
    const matched = await matching.decideBatch!([message({ elements: [h.text("ＭｙＧＯ 乐队")] })], state);
    expect(matched.candidate?.score).toBeCloseTo(18, 10);

    const { engine: quoted } = await createEngine({}, { random: () => 1 });
    const excluded = await quoted.decideBatch!(
      [
        message({
          elements: [h("quote", {}, [h.text("MyGO")]), h("reply", {}, [h.text("吉他")]), h.text("ordinary")],
          quote: { messageId: "quoted", elements: [h.text("演出")], author: { id: "someone" } },
        }),
      ],
      state,
    );
    expect(excluded.candidate?.score).toBeCloseTo(12, 10);
  });

  it("updates every author independently, chooses the highest, and reserves only that author", async () => {
    const random = vi.fn(() => 0);
    const { engine, store } = await createEngine({}, { random });
    const inputs: MessageBatchInput[] = [
      message({ id: "alice-1", userId: "alice" }),
      message({ id: "alice-2", userId: "alice" }),
      message({ id: "alice-3", userId: "alice" }),
      message({ id: "bob-mention", userId: "bob", elements: [h.at("bot-1")] }),
      message({ id: "latest-marker", userId: "carol" }),
    ];

    const result = await engine.decideBatch!(inputs, state);
    const bot = store.readBot("bot-1");

    expect(result).toMatchObject({ decision: "trigger", candidate: { authorId: "bob", inputId: inputs[3]!.id } });
    expect(random).toHaveBeenCalledOnce();
    expect(bot.authors.alice?.confirmedScore).toBeCloseTo(43.36323632135509, 10);
    expect(bot.authors.bob?.confirmedScore).toBeCloseTo(12, 10);
    expect(bot.authors.carol?.confirmedScore).toBeCloseTo(12, 10);
    expect(Object.values(bot.reservations)).toEqual([expect.objectContaining({ authorId: "bob", amount: 12, sourceEventIds: [inputs[3]!.id] })]);
  });

  it("keeps an author with a pending reservation ineligible while still accumulating base score", async () => {
    const random = vi.fn(() => 0);
    const { engine, store } = await createEngine({}, { random });
    const first = await engine.decideBatch!([message({ id: "direct-1", channelType: 1 as Universal.Channel.Type })], state);
    const second = await engine.decideBatch!([message({ id: "ordinary-2" })], state);

    expect(first.decision).toBe("trigger");
    expect(second).toEqual({ decision: "wait" });
    expect(random).toHaveBeenCalledOnce();
    expect(store.readBot("bot-1").authors["user-1"]?.confirmedScore).toBeCloseTo(23.8272, 10);
  });

  it("commits or releases the recorded amount idempotently", async () => {
    const { engine, store } = await createEngine({}, { random: () => 0 });
    const committed = await engine.decideBatch!([message({ channelType: 1 as Universal.Channel.Type })], state);
    await engine.settleReservation!(committed.reservationId!, { kind: "commit", turnId: "turn-1", messageId: "sent-1" });
    const afterCommit = store.readBot("bot-1").authors["user-1"]?.confirmedScore;
    await engine.settleReservation!(committed.reservationId!, { kind: "commit", turnId: "turn-1", messageId: "sent-1" });
    await engine.settleReservation!(committed.reservationId!, { kind: "release", turnId: "turn-1", reason: "failed" });
    expect(afterCommit).toBe(0);
    expect(store.readBot("bot-1").authors["user-1"]?.confirmedScore).toBe(0);

    const released = await engine.decideBatch!([message({ id: "direct-2", channelType: 1 as Universal.Channel.Type })], state);
    await engine.settleReservation!(released.reservationId!, { kind: "release", turnId: "turn-2", reason: "done-without-delivery" });
    expect(store.readBot("bot-1").authors["user-1"]?.confirmedScore).toBeCloseTo(12, 10);
  });

  it("uses input timestamps and a strict 600-second exponential half-life without time reversal", async () => {
    const { engine } = await createEngine({}, { random: () => 1, now: () => 1_200_000 });
    await engine.decideBatch!([message({ id: "old", timestamp: 600_000 })], state);
    const decayed = await engine.decideBatch!([message({ id: "now", timestamp: 1_200_000 })], state);
    expect(decayed.candidate?.score).toBeCloseTo(addGain(6, 12, calibrated), 10);

    const outOfOrder = await engine.decideBatch!([message({ id: "late-arrival-old-time", timestamp: 100_000 })], state);
    expect(outOfOrder.candidate!.score).toBeGreaterThan(decayed.candidate!.score);
  });

  it("recovers durable score with real elapsed decay and releases unfinished reservations", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-willingness-recovery-"));
    roots.push(root);
    const path = join(root, "willingness.json");
    const firstStore = createDurableWillingnessStore(path, logger);
    const { engine: first } = await createEngine({ persistState: true }, { store: firstStore, random: () => 0, now: () => 600_000 });
    const trigger = await first.decideBatch!([message({ channelType: 1 as Universal.Channel.Type, timestamp: 600_000 })], state);
    expect(trigger.reservationId).toBeTruthy();

    const secondStore = createDurableWillingnessStore(path, logger);
    const { engine: recovered } = await createEngine({ persistState: true }, { store: secondStore, random: () => 1, now: () => 1_200_000 });

    expect(secondStore.readBot("bot-1").reservations).toEqual({});
    expect(recovered.getCurrentWillingness("user-1")).toBeCloseTo(6, 10);
  });

  it("rejects the batch when the atomic state mutation cannot be persisted", async () => {
    let bot: WillingnessBotState = { authors: {}, reservations: {} };
    let mutations = 0;
    const store: WillingnessStore = {
      init: async () => undefined,
      readBot: () => bot,
      mutateBot: async (_selfId, mutate) => {
        mutations += 1;
        if (mutations > 1) throw new Error("disk unavailable");
        const next: WillingnessBotState = { authors: { ...bot.authors }, reservations: { ...bot.reservations } };
        const result = mutate(next);
        bot = next;
        return result;
      },
    };
    const { engine } = await createEngine({}, { store, random: () => 0 });

    await expect(engine.decideBatch!([message({ channelType: 1 as Universal.Channel.Type })], state)).rejects.toThrow("disk unavailable");
    expect(bot.reservations).toEqual({});
  });

  it("uses only own author-state entries and skips unsafe prototype-mutating author ids", async () => {
    const random = vi.fn(() => 1);
    const { engine, store } = await createEngine({}, { random });

    const inheritedName = await engine.decideBatch!([message({ id: "prototype-name", userId: "toString" })], state);
    const unsafe = await engine.decideBatch!([message({ id: "unsafe-name", userId: "__proto__" })], state);

    expect(inheritedName.candidate).toMatchObject({ authorId: "toString", score: 12, probability: 0 });
    expect(Object.hasOwn(store.readBot("bot-1").authors, "toString")).toBe(true);
    expect(unsafe).toEqual({ decision: "wait" });
    expect(Object.hasOwn(store.readBot("bot-1").authors, "__proto__")).toBe(false);
    expect(random).toHaveBeenCalledOnce();
  });

  it("fails closed for poke events without typed actor identity or the current Bot target", async () => {
    const random = vi.fn(() => 0);
    const { engine } = await createEngine({}, { random });

    await expect(engine.decideBatch!([poke({ actorId: "", targetId: "bot-1" })], state)).resolves.toEqual({ decision: "wait" });
    await expect(engine.decideBatch!([poke({ actorId: "user-1", targetId: "other" })], state)).resolves.toEqual({ decision: "wait" });
    expect(random).not.toHaveBeenCalled();
  });
});
