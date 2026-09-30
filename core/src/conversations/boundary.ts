import type { AgentEntry } from "@yesimbot/agent-runtime";

export interface CompactBoundary {
  readonly compact: Extract<AgentEntry, { type: "compact" }>;
  readonly compactIndex: number;
  /** Logical start of entries not covered by the latest compact summary. */
  readonly tailStartIndex: number;
}

export function resolveLatestCompactBoundary(entries: readonly AgentEntry[]): CompactBoundary | undefined {
  let compactIndex = -1;
  let compact: Extract<AgentEntry, { type: "compact" }> | undefined;
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "compact") continue;
    compactIndex = index;
    compact = entry;
  }
  if (!compact) return undefined;

  const lastEntryIndex = entries.findIndex((entry, index) => index < compactIndex && entry.id === compact!.data.lastEntryId);
  return {
    compact,
    compactIndex,
    tailStartIndex: lastEntryIndex >= 0 ? lastEntryIndex + 1 : compactIndex + 1,
  };
}
