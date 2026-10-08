import type { StickerStore } from "./store.js";
import { normalizeTags, type StickerProjection } from "./types.js";

/**
 * Shared tag-scoped selection used by both the preview and send tools so "the best match for these
 * tags" cannot diverge between reading and sending. `randomRange` widens the accepted score window
 * so the same tags do not always resolve to one single sticker.
 */
export async function pickBestTaggedSticker(
  store: StickerStore,
  scopeKey: string,
  tags: readonly string[],
  category?: string,
  fuzzyTagMatch = true,
  randomRange = 0,
): Promise<StickerProjection | null> {
  const normalized = normalizeTags(tags);
  if (normalized.length === 0) return null;
  const rows = await store.listByScopeKey(scopeKey);
  const scoped = category ? rows.filter((sticker) => sticker.category === category) : rows;
  const matches = scoped.filter((sticker) => normalized.some((tag) => stickerMatches(sticker.tags, tag, fuzzyTagMatch)));
  if (matches.length === 0) return null;
  const score = (sticker: StickerProjection): number =>
    normalized.reduce((count, tag) => count + (stickerMatches(sticker.tags, tag, fuzzyTagMatch) ? 1 : 0), 0);
  const best = Math.max(...matches.map(score));
  const threshold = Math.min(best, Math.max(0, randomRange));
  const candidates = matches.filter((sticker) => score(sticker) >= best - threshold);
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

function stickerMatches(tags: readonly string[], requested: string, fuzzyTagMatch: boolean): boolean {
  return tags.some((tag) => (fuzzyTagMatch ? fuzzyTagEquals(requested, tag) : tag === requested));
}

function fuzzyTagEquals(requested: string, stored: string): boolean {
  const left = requested.toLowerCase();
  const right = stored.toLowerCase();
  return left.length > 0 && (right.includes(left) || left.includes(right));
}
