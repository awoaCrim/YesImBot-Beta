import { defaultRoutingConfig, defaultWillingnessConfig, type PolicyRoutingConfig, type PolicyWillingnessConfig, type WillPolicyConfig } from "./types.js";

export interface ResolvedPolicy {
  readonly engine: "routing" | "willingness";
  readonly routing: PolicyRoutingConfig;
  readonly willingness: PolicyWillingnessConfig;
}

export function resolvePolicy(config: WillPolicyConfig): ResolvedPolicy {
  const resolved = {
    engine: config.engine,
    routing: { ...defaultRoutingConfig(), ...config.routing },
    willingness: { ...defaultWillingnessConfig(), ...config.willingness },
  };
  if (resolved.engine === "willingness") validateWillingnessConfig(resolved.willingness);
  return resolved;
}

export function validateWillingnessConfig(config: PolicyWillingnessConfig): void {
  positive(config.maxScore, "maxScore");
  nonNegative(config.initialScore, "initialScore");
  nonNegative(config.probabilityThreshold, "probabilityThreshold");
  nonNegative(config.probabilityAmplifier, "probabilityAmplifier");
  nonNegative(config.replyCost, "replyCost");
  positive(config.decayHalfLifeSeconds, "decayHalfLifeSeconds");
  nonNegative(config.textGain, "textGain");
  nonNegative(config.mentionGain, "mentionGain");
  nonNegative(config.quoteGain, "quoteGain");
  nonNegative(config.directGain, "directGain");
  nonNegative(config.imageGain, "imageGain");
  nonNegative(config.pokeGain, "pokeGain");
  nonNegative(config.keywordMultiplier, "keywordMultiplier");
  nonNegative(config.defaultMultiplier, "defaultMultiplier");
  nonNegative(config.hotWindowSeconds, "hotWindowSeconds");
  nonNegative(config.warmWindowSeconds, "warmWindowSeconds");
  nonNegative(config.hotDecayWeight, "hotDecayWeight");
  nonNegative(config.warmDecayWeight, "warmDecayWeight");

  if (config.initialScore > config.maxScore) throw new TypeError("initialScore must not exceed maxScore");
  if (config.probabilityThreshold > config.maxScore) throw new TypeError("probabilityThreshold must be within maxScore");
  if (config.hotWindowSeconds > config.warmWindowSeconds) throw new TypeError("hotWindowSeconds must not exceed warmWindowSeconds");
  if (!Array.isArray(config.keywords)) throw new TypeError("keywords must be an array");
  for (const keyword of config.keywords) {
    if (typeof keyword !== "string" || normalizeKeyword(keyword).length === 0) throw new TypeError("keywords must contain only non-empty normalized strings");
  }
  if (config.persistState && config.batchDecision !== "highest-candidate") {
    throw new TypeError("persistState requires batchDecision=highest-candidate");
  }
  if (config.batchDecision === "highest-candidate" && (config.directForce || config.mentionForce || config.quoteForce)) {
    throw new TypeError("highest-candidate mode does not allow force flags");
  }
}

export function normalizeKeyword(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

function positive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${field} must be a finite positive number`);
}

function nonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be a finite non-negative number`);
}
