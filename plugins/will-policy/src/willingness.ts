import { randomUUID } from "node:crypto";

import type { Element, Logger, Universal } from "koishi";
import {
  isMessage,
  type Event,
  type Message,
  type MessageBatchInput,
  type WillBatchDecision,
  type WillDebug,
  type WillEngine,
  type WillReservationOutcome,
  type WillState,
} from "koishi-plugin-yesimbot";

import { hasImage, hasQuote, mentionKind } from "./message-context.js";
import { normalizeKeyword } from "./policy.js";
import { createMemoryWillingnessStore, type WillingnessAuthorState, type WillingnessBotState, type WillingnessStore } from "./store.js";
import type { PolicyWillingnessConfig } from "./types.js";

const DIRECT_CHANNEL_TYPE = 1 satisfies Universal.Channel.Type;
const MAX_TRACKED_AUTHORS = 256;
const UNSAFE_STATE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

interface LegacyWillingnessState {
  score: number;
  lastMessageAt: number | null;
  lastDecayAt: number | null;
}

interface BatchParticipant {
  readonly authorId: string;
  readonly inputIds: string[];
  strongestDirectedGain: number;
  latestInputId: string;
  latestTimestamp: number;
  latestOrder: number;
}

interface BatchCandidate extends BatchParticipant {
  readonly availableBase: number;
  readonly score: number;
  readonly probability: number;
}

export interface PolicyWillingnessEngineOptions {
  readonly store?: WillingnessStore;
  readonly selfId?: string;
  readonly random?: () => number;
  readonly now?: () => number;
}

export class PolicyWillingnessEngine implements WillEngine {
  public readonly decideBatch?: (inputs: readonly MessageBatchInput[], state: WillState) => Promise<WillBatchDecision>;
  public readonly settleReservation?: (reservationId: string, outcome: WillReservationOutcome) => Promise<void>;

  private readonly states = new Map<string, LegacyWillingnessState>();
  private readonly store: WillingnessStore;
  private readonly normalizedKeywords: readonly string[];
  private readonly random: () => number;
  private readonly now: () => number;
  private resolvedSelfId: string | undefined;
  private lastEvaluatedKey: string | undefined;
  private lastScore = 0;
  private lastProbability = 0;

  public constructor(
    private readonly config: PolicyWillingnessConfig,
    private readonly logger: Pick<Logger, "debug" | "warn">,
    options: PolicyWillingnessEngineOptions = {},
  ) {
    this.store = options.store ?? createMemoryWillingnessStore();
    this.resolvedSelfId = options.selfId;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.normalizedKeywords = config.keywords.map(normalizeKeyword);
    if (config.batchDecision === "highest-candidate") {
      this.decideBatch = (inputs, state) => this.decideHighestCandidateBatch(inputs, state);
      this.settleReservation = (reservationId, outcome) => this.settle(reservationId, outcome);
    }
  }

  public async initialize(): Promise<void> {
    if (!this.decideBatch) return;
    await this.store.init();
    const selfId = this.resolvedSelfId;
    if (!selfId) return;
    const now = this.now();
    const released = await this.store.mutateBot(selfId, (bot) => recoverBotState(bot, now, this.config));
    if (released > 0) this.logger.warn("will_policy.willingness_recovered_reservations", { selfId, released });
  }

  public async decide(input: Message | Event, _state: WillState): Promise<"wait" | "trigger"> {
    return isMessage(input) ? this.decideMessage(input) : isPokeEvent(input) ? this.decidePoke(input) : "wait";
  }

  public getCurrentWillingness(authorId?: string): number {
    if (this.decideBatch) {
      const selfId = this.resolvedSelfId;
      if (!selfId || authorId === undefined) return this.config.initialScore;
      return this.store.readBot(selfId).authors[authorId]?.confirmedScore ?? this.config.initialScore;
    }
    const key = authorId === undefined ? this.lastEvaluatedKey : authorKey(authorId);
    return key === undefined ? this.config.initialScore : (this.states.get(key)?.score ?? this.config.initialScore);
  }

  public debug(): WillDebug {
    return {
      engine: "willingness",
      score: this.lastScore,
      probability: this.lastProbability,
      config: this.config as unknown as Record<string, unknown>,
    };
  }

  private decideMessage(input: Message): "wait" | "trigger" {
    const now = this.config.decayMode === "half-life" ? clampInputTimestamp(input.timestamp, this.now()) : this.now();
    const key = authorKey(input.data.user.id);
    const state = this.stateFor(key);
    const decayed = decayedScore(state, now, this.config);
    const baseScore = calculateLegacyBaseScore(decayed, input.data, this.config);
    const directedBoost = calculateLegacyDirectedBoost(input.data, this.config);
    const score = addGain(baseScore, directedBoost, this.config);
    const probability = calculateProbability(score, this.config);
    const forced = shouldForce(input.data, this.config);
    const decision: "wait" | "trigger" = forced || this.random() < probability ? "trigger" : "wait";

    this.updateState(key, state, decision === "trigger" ? Math.max(0, baseScore - this.config.replyCost) : baseScore, now);
    this.recordDecision(key, score, probability);
    this.logger.debug("will_policy.willingness", {
      messageId: input.id,
      channelId: input.data.channel.id,
      authorId: input.data.user.id,
      previousScore: decayed,
      baseScore,
      directedBoost,
      score,
      probability,
      decision,
      forced,
      mode: "per-input",
    });
    return decision;
  }

  private decidePoke(input: Event): "wait" | "trigger" {
    const now = this.config.decayMode === "half-life" ? clampInputTimestamp(input.timestamp, this.now()) : this.now();
    const key = "event:poke";
    const state = this.stateFor(key);
    const decayed = decayedScore(state, now, this.config);
    const score = addGain(decayed, this.config.pokeGain, this.config);
    const probability = calculateProbability(score, this.config);
    const decision: "wait" | "trigger" = this.random() < probability ? "trigger" : "wait";

    this.updateState(key, state, decision === "trigger" ? Math.max(0, score - this.config.replyCost) : score, now);
    this.recordDecision(key, score, probability);
    this.logger.debug("will_policy.willingness", {
      messageId: input.id,
      channelId: input.data.channel.id,
      previousScore: decayed,
      score,
      probability,
      decision,
      forced: false,
      mode: "per-input",
    });
    return decision;
  }

  private async decideHighestCandidateBatch(inputs: readonly MessageBatchInput[], _state: WillState): Promise<WillBatchDecision> {
    if (inputs.length === 0) return { decision: "wait" };
    const now = this.now();
    const selfId = this.resolveSelfId(inputs);
    const prepared = inputs
      .map((input, order) => ({ input, order, timestamp: clampInputTimestamp(input.timestamp, now) }))
      .sort((left, right) => left.timestamp - right.timestamp || left.order - right.order);

    return this.store.mutateBot(selfId, (bot) => {
      const heldByAuthor = reservationAmounts(bot);
      const participants = new Map<string, BatchParticipant>();

      for (const item of prepared) {
        const signals = extractBatchSignals(item.input, selfId, this.normalizedKeywords);
        if (!signals || !isSafeStateKey(signals.authorId)) continue;
        const current = Object.hasOwn(bot.authors, signals.authorId) ? bot.authors[signals.authorId]! : initialAuthorState(this.config.initialScore);
        const timestamp = Math.max(current.lastDecayAt ?? item.timestamp, item.timestamp);
        const decayed = decayStoredAuthor(current, timestamp, this.config);
        const multiplier = signals.keyword ? this.config.keywordMultiplier : this.config.defaultMultiplier;
        const confirmedScore = addGain(decayed, this.config.textGain * multiplier, this.config);
        bot.authors[signals.authorId] = {
          confirmedScore,
          lastMessageAt: Math.max(current.lastMessageAt ?? timestamp, timestamp),
          lastDecayAt: timestamp,
        };

        const directedGain = Math.max(
          signals.direct ? this.config.directGain : 0,
          signals.mentionsSelf ? this.config.mentionGain : 0,
          signals.quotesSelf ? this.config.quoteGain : 0,
          signals.pokeSelf ? this.config.pokeGain : 0,
        );
        const participant = participants.get(signals.authorId);
        if (participant) {
          participant.inputIds.push(item.input.id);
          participant.strongestDirectedGain = Math.max(participant.strongestDirectedGain, directedGain);
          if (timestamp > participant.latestTimestamp || (timestamp === participant.latestTimestamp && item.order > participant.latestOrder)) {
            participant.latestInputId = item.input.id;
            participant.latestTimestamp = timestamp;
            participant.latestOrder = item.order;
          }
        } else {
          participants.set(signals.authorId, {
            authorId: signals.authorId,
            inputIds: [item.input.id],
            strongestDirectedGain: directedGain,
            latestInputId: item.input.id,
            latestTimestamp: timestamp,
            latestOrder: item.order,
          });
        }
      }

      const candidates: BatchCandidate[] = [];
      for (const participant of participants.values()) {
        if ((heldByAuthor.get(participant.authorId) ?? 0) > 0 || hasReservation(bot, participant.authorId)) continue;
        const confirmedScore = bot.authors[participant.authorId]?.confirmedScore ?? this.config.initialScore;
        const availableBase = Math.max(0, confirmedScore - (heldByAuthor.get(participant.authorId) ?? 0));
        const score = addGain(availableBase, participant.strongestDirectedGain, this.config);
        candidates.push({
          ...participant,
          availableBase,
          score,
          probability: calculateProbability(score, this.config),
        });
      }

      candidates.sort((left, right) => right.score - left.score || right.latestTimestamp - left.latestTimestamp || right.latestOrder - left.latestOrder);
      const winner = candidates[0];
      if (!winner) {
        this.lastScore = 0;
        this.lastProbability = 0;
        this.logger.debug("will_policy.willingness_batch", { size: inputs.length, selfId, decision: "wait", reason: "no-eligible-candidate" });
        return { decision: "wait" };
      }

      const decision: "wait" | "trigger" = this.random() < winner.probability ? "trigger" : "wait";
      this.recordDecision(authorKey(winner.authorId), winner.score, winner.probability);
      const candidate = {
        inputId: winner.latestInputId,
        authorId: winner.authorId,
        score: winner.score,
        probability: winner.probability,
      };
      if (decision === "wait") {
        this.logger.debug("will_policy.willingness_batch", { size: inputs.length, selfId, decision, candidate });
        return { decision, candidate };
      }

      const reservationId = randomUUID();
      bot.reservations[reservationId] = {
        id: reservationId,
        authorId: winner.authorId,
        amount: Math.min(this.config.replyCost, winner.availableBase),
        createdAt: now,
        sourceEventIds: [...winner.inputIds],
      };
      this.logger.debug("will_policy.willingness_batch", { size: inputs.length, selfId, decision, candidate, reservationId });
      return { decision, candidate, reservationId };
    });
  }

  private async settle(reservationId: string, outcome: WillReservationOutcome): Promise<void> {
    const selfId = this.resolvedSelfId;
    if (!selfId) throw new Error("Cannot settle willingness reservation without selfId");
    const settled = await this.store.mutateBot(selfId, (bot) => {
      const reservation = bot.reservations[reservationId];
      if (!reservation) return false;
      if (outcome.kind === "commit") {
        const author = bot.authors[reservation.authorId];
        if (author) author.confirmedScore = Math.max(0, author.confirmedScore - reservation.amount);
      }
      delete bot.reservations[reservationId];
      return true;
    });
    this.logger.debug("will_policy.willingness_reservation", { reservationId, outcome, settled });
  }

  private resolveSelfId(inputs: readonly MessageBatchInput[]): string {
    const selfId = this.resolvedSelfId ?? inputs[0]?.data.selfId;
    if (!selfId || inputs.some((input) => input.data.selfId !== selfId)) throw new Error("Willingness batch must contain exactly one Bot identity");
    this.resolvedSelfId = selfId;
    return selfId;
  }

  private stateFor(key: string): LegacyWillingnessState {
    const existing = this.states.get(key);
    if (existing) return existing;
    if (this.states.size >= MAX_TRACKED_AUTHORS) this.evictOldestState();
    const state = { score: this.config.initialScore, lastMessageAt: null, lastDecayAt: null };
    this.states.set(key, state);
    return state;
  }

  private updateState(key: string, state: LegacyWillingnessState, score: number, now: number): void {
    state.score = score;
    state.lastMessageAt = now;
    state.lastDecayAt = now;
    this.states.delete(key);
    this.states.set(key, state);
  }

  private recordDecision(key: string, score: number, probability: number): void {
    this.lastEvaluatedKey = key;
    this.lastScore = score;
    this.lastProbability = probability;
  }

  private evictOldestState(): void {
    const oldest = this.states.keys().next().value as string | undefined;
    if (oldest !== undefined) this.states.delete(oldest);
  }
}

interface BatchSignals {
  readonly authorId: string;
  readonly direct: boolean;
  readonly mentionsSelf: boolean;
  readonly quotesSelf: boolean;
  readonly pokeSelf: boolean;
  readonly keyword: boolean;
}

function extractBatchSignals(input: MessageBatchInput, selfId: string, keywords: readonly string[]): BatchSignals | undefined {
  if (isMessage(input)) {
    const normalizedText = normalizeKeyword(extractCurrentBodyText(input.data.elements));
    return {
      authorId: input.data.user.id,
      direct: input.data.channel.type === DIRECT_CHANNEL_TYPE,
      mentionsSelf: mentionsSelf(input.data.elements, selfId),
      quotesSelf: input.data.channel.type !== DIRECT_CHANNEL_TYPE && input.data.quote?.author?.id === selfId,
      pokeSelf: false,
      keyword: keywords.some((keyword) => normalizedText.includes(keyword)),
    };
  }
  const data = input.data as unknown as { readonly eventType?: string; readonly actorId?: unknown; readonly targetId?: unknown };
  if (data.eventType !== "notice.poke" || typeof data.actorId !== "string" || data.actorId.length === 0 || data.targetId !== selfId) return undefined;
  return { authorId: data.actorId, direct: false, mentionsSelf: false, quotesSelf: false, pokeSelf: true, keyword: false };
}

function extractCurrentBodyText(elements: readonly Element[]): string {
  const parts: string[] = [];
  const visit = (element: Element) => {
    if (element.type === "quote" || element.type === "reply") return;
    if (element.type === "text" && typeof element.attrs.content === "string") parts.push(element.attrs.content);
    for (const child of element.children) visit(child);
  };
  for (const element of elements) visit(element);
  return parts.join("");
}

function mentionsSelf(elements: readonly Element[], selfId: string): boolean {
  const visit = (element: Element): boolean => {
    if (element.type === "quote" || element.type === "reply") return false;
    if (element.type === "at") {
      const type = String(element.attrs.type ?? "");
      if (type !== "all" && type !== "here" && String(element.attrs.id ?? "") === selfId) return true;
    }
    return element.children.some(visit);
  };
  return elements.some(visit);
}

function authorKey(authorId: string): string {
  return `user:${authorId}`;
}

function isSafeStateKey(value: string): boolean {
  return value.length > 0 && !UNSAFE_STATE_KEYS.has(value);
}

function decayedScore(state: LegacyWillingnessState, now: number, config: PolicyWillingnessConfig): number {
  return state.lastDecayAt === null || state.lastMessageAt === null
    ? state.score
    : decayScore(state.score, state.lastDecayAt, state.lastMessageAt, now, config);
}

export function decayScore(score: number, lastDecayAt: number, lastMessageAt: number, now: number, config: PolicyWillingnessConfig): number {
  if (now <= lastDecayAt) return score;
  if (config.decayMode === "half-life") {
    return Math.max(0, score * 0.5 ** ((now - lastDecayAt) / 1_000 / config.decayHalfLifeSeconds));
  }
  const weightedSeconds = weightedSilenceSeconds(lastDecayAt, lastMessageAt, now, config);
  const decayed =
    score > config.probabilityThreshold && config.probabilityThreshold > 0
      ? decayHighScore(score, weightedSeconds, config.probabilityThreshold, config.decayHalfLifeSeconds)
      : score * 0.5 ** (weightedSeconds / config.decayHalfLifeSeconds);
  return decayed < 0.01 ? 0 : Math.max(0, decayed);
}

function weightedSilenceSeconds(lastDecayAt: number, lastMessageAt: number, now: number, config: PolicyWillingnessConfig): number {
  const hotEnd = lastMessageAt + config.hotWindowSeconds * 1_000;
  const warmEnd = lastMessageAt + config.warmWindowSeconds * 1_000;
  const overlap = (start: number, end: number) => Math.max(0, Math.min(now, end) - Math.max(lastDecayAt, start)) / 1_000;
  return (
    overlap(lastMessageAt, hotEnd) * config.hotDecayWeight +
    overlap(hotEnd, warmEnd) * config.warmDecayWeight +
    Math.max(0, now - Math.max(lastDecayAt, warmEnd)) / 1_000
  );
}

function decayHighScore(score: number, weightedSeconds: number, threshold: number, halfLife: number): number {
  const weightedSecondsToThreshold = 2 * halfLife * Math.log2(score / threshold);
  if (weightedSeconds <= weightedSecondsToThreshold) {
    return score * 0.5 ** ((0.5 * weightedSeconds) / halfLife);
  }
  return threshold * 0.5 ** ((weightedSeconds - weightedSecondsToThreshold) / halfLife);
}

function calculateLegacyBaseScore(current: number, data: Message["data"], config: PolicyWillingnessConfig): number {
  const attributes = hasImage(data.elements) ? config.imageGain : 0;
  const multiplier = hasLegacyKeyword(data.elements, config.keywords) ? config.keywordMultiplier : config.defaultMultiplier;
  return addGain(current, (config.textGain + attributes) * multiplier, config);
}

function calculateLegacyDirectedBoost(data: Message["data"], config: PolicyWillingnessConfig): number {
  return (
    (mentionKind(data.selfId, data.elements) === "self" ? config.mentionGain : 0) +
    (data.channel.type === DIRECT_CHANNEL_TYPE && hasQuote(data.elements) ? config.quoteGain : 0) +
    (data.channel.type === DIRECT_CHANNEL_TYPE ? config.directGain : 0)
  );
}

export function addGain(current: number, rawGain: number, config: Pick<PolicyWillingnessConfig, "maxScore">): number {
  const ratio = current / config.maxScore;
  const gain = rawGain * Math.max(0, 1 - ratio ** 2) * dynamicGainMultiplier(ratio);
  return Math.min(config.maxScore, Math.max(0, current + gain));
}

export function calculateProbability(score: number, config: Pick<PolicyWillingnessConfig, "probabilityThreshold" | "probabilityAmplifier">): number {
  if (score <= config.probabilityThreshold) return 0;
  return Math.min(1, Math.max(0, (score - config.probabilityThreshold) * config.probabilityAmplifier));
}

function dynamicGainMultiplier(ratio: number): number {
  if (ratio < 0.2) return 1;
  if (ratio < 0.8) return Math.max(1, -(((ratio - 0.5) * 2) ** 2) + 2);
  return 1 - (ratio - 0.8) / 0.2;
}

function hasLegacyKeyword(elements: readonly unknown[] | undefined, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false;
  const text = elements
    ?.flatMap((element) => {
      if (element && typeof element === "object" && "attrs" in element) {
        const attrs = (element as { attrs?: Record<string, unknown> }).attrs;
        return typeof attrs?.content === "string" ? [attrs.content] : [];
      }
      return [];
    })
    .join("");
  return keywords.some((keyword) => text?.includes(keyword) ?? false);
}

function shouldForce(data: Message["data"], config: PolicyWillingnessConfig): boolean {
  if (config.directForce && data.channel.type === DIRECT_CHANNEL_TYPE) return true;
  if (config.mentionForce && mentionKind(data.selfId, data.elements) === "self") return true;
  return config.quoteForce && data.channel.type === DIRECT_CHANNEL_TYPE && hasQuote(data.elements);
}

function isPokeEvent(input: Event): boolean {
  return input.role === "custom" && input.type === "yesimbot.event" && (input.data as { eventType?: string }).eventType === "notice.poke";
}

function clampInputTimestamp(value: number, now: number): number {
  if (!Number.isFinite(value)) return now;
  return Math.min(now, Math.max(0, value));
}

function initialAuthorState(initialScore: number): WillingnessAuthorState {
  return { confirmedScore: initialScore, lastMessageAt: null, lastDecayAt: null };
}

function decayStoredAuthor(author: WillingnessAuthorState, now: number, config: PolicyWillingnessConfig): number {
  if (author.lastDecayAt === null || author.lastMessageAt === null) return author.confirmedScore;
  return decayScore(author.confirmedScore, author.lastDecayAt, author.lastMessageAt, now, config);
}

function reservationAmounts(bot: WillingnessBotState): Map<string, number> {
  const amounts = new Map<string, number>();
  for (const reservation of Object.values(bot.reservations)) {
    amounts.set(reservation.authorId, (amounts.get(reservation.authorId) ?? 0) + reservation.amount);
  }
  return amounts;
}

function hasReservation(bot: WillingnessBotState, authorId: string): boolean {
  return Object.values(bot.reservations).some((reservation) => reservation.authorId === authorId);
}

function recoverBotState(bot: WillingnessBotState, now: number, config: PolicyWillingnessConfig): number {
  for (const author of Object.values(bot.authors)) {
    author.confirmedScore = Math.min(config.maxScore, decayStoredAuthor(author, now, config));
    if (author.lastDecayAt !== null) author.lastDecayAt = Math.max(author.lastDecayAt, now);
  }
  const released = Object.keys(bot.reservations).length;
  bot.reservations = {};
  return released;
}
