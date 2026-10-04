import type { AgentModelRequestContext } from "@yesimbot/agent-runtime";

import { estimateContextMessage, requestUnits } from "./context-budget.js";

export const CONTEXT_TRIGGER_TOKENS = 100_000;

export const CONTEXT_TARGET_TOKENS = 80_000;

export const CONTEXT_SAFETY_WAIT_MS = 60_000;

export const CONTEXT_REGION_SOURCE_BYTES = 48_000;

const tiers: readonly ContextTier[] = ["P1", "P2", "P3", "P4"];

export type ContextTier = "P1" | "P2" | "P3" | "P4";

export interface TierRegion {
  readonly id: string;
  readonly data: { readonly importance: number; readonly tiers: Readonly<Record<ContextTier, string>> };
}

export function contextPressure(actual: number | undefined, estimate: number, capacity: number) {
  const valid = typeof actual === "number" && Number.isFinite(actual) && actual > 0;
  return {
    ordinary: valid && actual >= CONTEXT_TRIGGER_TOKENS,
    emergency: (valid && actual >= capacity * 0.95) || estimate > capacity,
    unsafe: estimate > capacity,
    target: Math.min(CONTEXT_TARGET_TOKENS, Math.floor(capacity * 0.8)),
  };
}

/** Recent protection is token-based. Every source fanout and call/result pair stays atomic. */
export function contextCandidates(
  context: Pick<AgentModelRequestContext, "messages" | "projection" | "currentMessageIds">,
  covered: ReadonlySet<string>,
  capacity: number,
  multiplier: number,
  baseTokens = 0,
  sourceCosts?: ReadonlyMap<string, number>,
): string[][] {
  const current = new Set(context.currentMessageIds);
  const units = requestUnits(context.messages, context.projection?.describe(context.messages) ?? context.messages.map(() => undefined));
  const historical = units
    .filter(
      (unit) =>
        !unit.mandatory &&
        unit.kind === "history" &&
        unit.sourceEntryIds.size > 0 &&
        ![...unit.sourceEntryIds].some((id) => current.has(id) || covered.has(id)),
    )
    .sort((a, b) => a.timestamp - b.timestamp || a.indices[0]! - b.indices[0]!);
  const mandatoryTokens =
    (baseTokens +
      units
        .filter((unit) => unit.mandatory || [...unit.sourceEntryIds].some((id) => current.has(id)))
        .reduce((sum, unit) => sum + unit.indices.reduce((total, index) => total + estimateContextMessage(context.messages[index]!), 0), 0)) *
    multiplier;
  const protectedTokens = Math.max(0, Math.floor(Math.min(Math.min(CONTEXT_TARGET_TOKENS, capacity * 0.8) * 0.2, capacity * 0.9 - mandatoryTokens)));
  let tailTokens = 0;
  const eligible = new Set<(typeof historical)[number]>();
  for (const unit of [...historical].reverse()) {
    const cost = unit.indices.reduce((sum, index) => sum + estimateContextMessage(context.messages[index]!), 0) * multiplier;
    if (tailTokens + cost > protectedTokens) {
      eligible.add(unit);
      tailTokens = protectedTokens;
    } else tailTokens += cost;
  }
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const unit of historical) {
    if (!eligible.has(unit)) continue;
    // The historian reads public source records, not the full projected tool transcript.
    // Size that input when it is available: complete private tool pairs have zero public
    // body cost and can accompany nearby dialogue without producing empty-only jobs.
    // Manifest overhead still bounds large groups of otherwise zero-cost source IDs.
    const cost = sourceCosts
      ? [...unit.sourceEntryIds].reduce((sum, id) => sum + (sourceCosts.get(id) ?? Infinity), 0) +
        Buffer.byteLength(JSON.stringify([...unit.sourceEntryIds]), "utf8")
      : unit.indices.reduce((sum, index) => sum + estimateContextMessage(context.messages[index]!), 0);
    // Oversized indivisible public sources remain raw; never split a protocol chain.
    if (!Number.isFinite(cost) || cost > CONTEXT_REGION_SOURCE_BYTES) continue;
    if (bytes + cost > CONTEXT_REGION_SOURCE_BYTES && batch.length) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(...unit.sourceEntryIds);
    bytes += cost;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Age counts newer partitions, never wall-clock time. Pressure applies only to summaries. */
export function selectContextTiers(regions: readonly TierRegion[], budget: number, multiplier: number): Map<string, ContextTier | null> {
  const selected = new Map<string, ContextTier | null>();
  const cost = (region: TierRegion, tier: ContextTier) => (Buffer.byteLength(region.data.tiers[tier], "utf8") + 256) * multiplier;
  for (const [index, region] of regions.entries()) {
    const age = regions.length - index - 1;
    const decay = Math.floor(Math.log2(age + 1) / (1 + 2 * region.data.importance));
    selected.set(region.id, decay >= 5 ? null : tiers[Math.min(3, decay)]!);
  }
  let total = regions.reduce((sum, region) => {
    const tier = selected.get(region.id);
    return sum + (tier ? cost(region, tier) : 0);
  }, 0);
  // Low-importance/older regions yield first; latest P1 is a delta until pressure requires less.
  const order = regions.map((region, index) => ({ region, index })).sort((a, b) => a.region.data.importance - b.region.data.importance || a.index - b.index);
  for (let pass = 0; pass < 4 && total > budget; pass++) {
    for (const { region } of order) {
      if (total <= budget) break;
      const tier = selected.get(region.id);
      if (!tier) continue;
      const next = tiers[tiers.indexOf(tier) + 1] ?? null;
      total -= cost(region, tier) - (next ? cost(region, next) : 0);
      selected.set(region.id, next);
    }
  }
  return selected;
}
