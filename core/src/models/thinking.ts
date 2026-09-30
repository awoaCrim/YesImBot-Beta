import { Schema } from "koishi";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export interface ThinkingLevelSupport {
  readonly defaultMap: ThinkingLevelMap;
  readonly isNativeValue?: (value: string) => boolean;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap;
}

export interface ResolvedThinkingLevel {
  readonly clamped: boolean;
  readonly level: ThinkingLevel;
  readonly native: string | undefined;
}

export function getSupportedThinkingLevels(support: ThinkingLevelSupport): ThinkingLevel[] {
  if (support.reasoning === false) return ["off"];

  return THINKING_LEVELS.filter((level) => {
    const explicit = support.thinkingLevelMap?.[level];
    if (explicit === null) return false;
    if (explicit !== undefined) return support.isNativeValue?.(explicit) ?? true;
    if (level === "xhigh" || level === "max") return false;
    const fallback = support.defaultMap[level];
    return fallback !== undefined && fallback !== null;
  });
}

export function resolveThinkingLevel(support: ThinkingLevelSupport, requested: ThinkingLevel): ResolvedThinkingLevel {
  const available = getSupportedThinkingLevels(support);
  const level = available.includes(requested) ? requested : nearestThinkingLevel(available, requested);
  const explicit = support.thinkingLevelMap?.[level];
  const fallback = support.defaultMap[level];
  const native = explicit === null ? undefined : (explicit ?? (fallback === null ? undefined : fallback));
  return { clamped: level !== requested, level, native };
}

/**
 * Builds the Koishi schema for a per-model native thinking-level override map.
 *
 * The cast is required because Koishi's dict schema infers a literal value union that cannot
 * represent the shared `ThinkingLevelMap` contract; the returned schema still validates every
 * value against `nativeValues` or `null`.
 */
export function createThinkingLevelMapSchema(nativeValues: readonly string[]): Schema<ThinkingLevelMap> {
  return Schema.dict(
    Schema.union([Schema.const(null).description("不支持"), ...nativeValues.map((value) => Schema.const(value))]),
  ) as unknown as Schema<ThinkingLevelMap>;
}

function nearestThinkingLevel(available: ThinkingLevel[], requested: ThinkingLevel): ThinkingLevel {
  const requestedIndex = THINKING_LEVELS.indexOf(requested);
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index];
    if (available.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index];
    if (available.includes(candidate)) return candidate;
  }
  return available[0] ?? "off";
}
