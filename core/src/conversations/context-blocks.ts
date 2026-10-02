import { createHash, randomUUID } from "node:crypto";

import type { AgentEntry } from "@yesimbot/agent-runtime";

import { resolveLatestCompactBoundary } from "./boundary.js";
import { compactSourceTimestamp, renderVisibleUserRecords, type CompressionRecord } from "./compact.js";
import { recallTerms } from "./fragment-store.js";
import { collectDeliveredSourceRecords } from "./internal-history.js";

export type CompactEntry = Extract<AgentEntry, { type: "compact" }>;

type Cursor =
  | { kind: "page"; blockId: string; fingerprint: string; record: number; offset: number }
  | { kind: "list"; fingerprint: string; query: string; offset: number };

/** Archive bodies are read on demand; the persistent-source cache holds compact metadata only. */
export interface ContextSourceSnapshot {
  readonly sessionId: string;
  readonly entries: readonly AgentEntry[];
  readonly compacts: readonly CompactEntry[];
  readonly sessionIds: readonly string[];
  readSession(sessionId: string): Promise<readonly AgentEntry[]>;
}

export interface ResolvedCompactSource {
  readonly compact: CompactEntry;
  readonly sessionId: string;
  readonly entries: readonly AgentEntry[];
  readonly range: readonly AgentEntry[];
}

export interface ContextBlockDescriptor {
  readonly id: string;
  readonly kind: "compact" | "raw";
  readonly sourceState: "raw" | "summary-only" | "unavailable";
  readonly summary?: string;
  readonly startAt?: number;
  readonly endAt?: number;
  readonly sourceSession?: string;
  readonly firstEntryId?: string;
  readonly lastEntryId?: string;
}

export interface ContextPageRecord extends CompressionRecord {
  readonly textOffset: number;
  readonly continued: boolean;
}

export interface ContextBlockPage {
  readonly blockId: string;
  readonly pageId: string;
  readonly fingerprint: string;
  readonly records: readonly ContextPageRecord[];
  readonly sourceEntryIds: readonly string[];
  readonly omittedEntries: number;
  readonly nextCursor?: string;
}

export class ContextSourceError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "ContextSourceError";
  }
}

/** A rebuildable catalogue, not a second body store. Raw pages are verified and read on demand. */
export class ContextBlockStore {
  private readonly cursors = new Map<string, Cursor>();
  private readonly rawDescriptors = new Map<string, ContextBlockDescriptor>();
  private sessionId: string | undefined;
  private epoch = 0;

  public constructor(private readonly snapshot: () => Promise<ContextSourceSnapshot>) {}

  public invalidate(): void {
    this.epoch += 1;
    this.cursors.clear();
    this.rawDescriptors.clear();
    this.sessionId = undefined;
  }

  public async list(input: { query?: string; cursor?: string; limit?: number }, excludeIds: ReadonlySet<string> = new Set()) {
    const pendingEpoch = this.epoch;
    const snapshot = await this.snapshot();
    this.checkEpoch(pendingEpoch);
    this.syncSession(snapshot.sessionId);
    const query = input.query ?? "";
    if (query.length > 1024) throw new ContextSourceError("QueryTooLong");
    const limit = boundedLimit(input.limit, 10, 20);
    const descriptors = this.catalogue(snapshot, excludeIds);
    const terms = recallTerms(query);
    const candidates = query
      ? descriptors.filter((entry) => {
          const words = new Set(recallTerms(entry.summary ?? entry.id));
          return terms.some((term) => words.has(term));
        })
      : descriptors;
    const fingerprint = hash(JSON.stringify(candidates.map((entry) => [entry.id, entry.summary, entry.sourceState])));
    let offset = 0;
    if (input.cursor) {
      const cursor = this.cursors.get(input.cursor);
      if (!cursor || cursor.kind !== "list" || cursor.fingerprint !== fingerprint || cursor.query !== query) throw new ContextSourceError("InvalidCursor");
      offset = cursor.offset;
    }
    const blocks = candidates.slice(offset, offset + limit);
    const nextCursor =
      offset + blocks.length < candidates.length ? this.issue({ kind: "list", fingerprint, query, offset: offset + blocks.length }) : undefined;
    return { blocks, ...(nextCursor ? { nextCursor } : {}) };
  }

  public async page(
    input: { blockId: string; cursor?: string; limit?: number },
    maxBytes: number,
    excludeIds: ReadonlySet<string> = new Set(),
  ): Promise<ContextBlockPage> {
    const pendingEpoch = this.epoch;
    const snapshot = await this.snapshot();
    this.checkEpoch(pendingEpoch);
    this.syncSession(snapshot.sessionId);
    const sourceEpoch = this.epoch;
    const catalogue = this.catalogue(snapshot, excludeIds);
    const block = catalogue.find((entry) => entry.id === input.blockId) ?? this.rawDescriptors.get(input.blockId);
    if (!block) throw new ContextSourceError("BlockNotAccessible");
    if (block.sourceState !== "raw") throw new ContextSourceError("RawSourceUnavailable");
    const limit = boundedLimit(input.limit, 50, 50);
    let entries: readonly AgentEntry[];
    let range: readonly AgentEntry[];
    if (block.kind === "compact") {
      const source = await resolveCompactSource(snapshot, block.id);
      this.checkEpoch(sourceEpoch);
      entries = source.entries;
      range = source.range;
    } else {
      // A previously issued raw range may survive compaction, but only while the
      // identical original bounds remain in the same active session.
      const active = snapshot.entries;
      const first = active.findIndex((entry) => entry.id === block.firstEntryId);
      const last = active.findIndex((entry) => entry.id === block.lastEntryId);
      if (
        block.sourceSession !== snapshot.sessionId ||
        first < 0 ||
        last < first ||
        active.filter((entry) => entry.id === block.firstEntryId).length !== 1 ||
        active.filter((entry) => entry.id === block.lastEntryId).length !== 1
      )
        throw new ContextSourceError("BlockNotAccessible");
      entries = snapshot.entries;
      range = active.slice(first, last + 1);
    }
    if (range.some((entry) => excludeIds.has(entry.id))) throw new ContextSourceError("ActiveTurnSource");
    if (new Set(range.map((entry) => entry.id)).size !== range.length) throw new ContextSourceError("AmbiguousRawSource");
    const rangeIds = new Set(range.map((entry) => entry.id));
    const records = safeSourceRecords(entries).filter((record) => rangeIds.has(record.entryId));
    // A send receipt can lie outside the range. Bind cursors to the verified readable
    // projection too, so changing that evidence cannot reuse old text offsets.
    const fingerprint = hash(JSON.stringify([rangeFingerprint(range), records]));
    let recordIndex = 0;
    let offset = 0;
    if (input.cursor) {
      const cursor = this.cursors.get(input.cursor);
      if (!cursor || cursor.kind !== "page" || cursor.blockId !== block.id || cursor.fingerprint !== fingerprint) throw new ContextSourceError("InvalidCursor");
      recordIndex = cursor.record;
      offset = cursor.offset;
    }
    const start = [recordIndex, offset];
    const page: ContextPageRecord[] = [];
    let remaining = Math.floor(maxBytes);
    if (!Number.isFinite(remaining) || remaining < 128) throw new ContextSourceError("BudgetDenied");
    while (recordIndex < records.length && page.length < limit) {
      const record = records[recordIndex]!;
      const points = Array.from(record.text);
      const overhead = Buffer.byteLength(JSON.stringify({ ...record, text: "", textOffset: offset, continued: true }), "utf8") + 32;
      if (remaining <= overhead) break;
      let end = offset;
      let bytes = 0;
      while (end < points.length) {
        const size = Buffer.byteLength(points[end]!, "utf8");
        if (bytes + size > remaining - overhead) break;
        bytes += size;
        end += 1;
      }
      if (end === offset) break;
      const continued = end < points.length;
      page.push({ ...record, text: points.slice(offset, end).join(""), textOffset: offset, continued });
      remaining -= bytes + overhead;
      if (continued) {
        offset = end;
        break;
      }
      recordIndex += 1;
      offset = 0;
    }
    if (page.length === 0 && recordIndex < records.length) throw new ContextSourceError("BudgetDenied");
    const nextCursor = recordIndex < records.length ? this.issue({ kind: "page", blockId: block.id, fingerprint, record: recordIndex, offset }) : undefined;
    return {
      blockId: block.id,
      pageId: hash(JSON.stringify([block.id, fingerprint, start, recordIndex, offset])),
      fingerprint,
      records: page,
      sourceEntryIds: [...new Set(page.map((record) => record.entryId))],
      omittedEntries: range.filter((entry) => entry.type === "message" && !records.some((record) => record.entryId === entry.id)).length,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  private checkEpoch(epoch: number): void {
    if (this.epoch !== epoch) throw new ContextSourceError("StaleContextRead");
  }

  private syncSession(id: string): void {
    if (this.sessionId === id) return;
    this.invalidate();
    this.sessionId = id;
  }

  private catalogue(snapshot: ContextSourceSnapshot, excludeIds: ReadonlySet<string>): ContextBlockDescriptor[] {
    const result: ContextBlockDescriptor[] = [];
    const boundary = resolveLatestCompactBoundary(snapshot.entries);
    const seen = new Set<string>();
    let compact = boundary?.compact;
    const lineage = compact?.data.lineageId ?? compact?.id;
    while (compact && !seen.has(compact.id)) {
      seen.add(compact.id);
      const canonical = resolveCompactAlias(snapshot.compacts, compact.id);
      if ((canonical.data.lineageId ?? canonical.id) !== lineage) break;
      const data = canonical.data;
      validateSourceIds([canonical.id, data.firstEntryId, data.lastEntryId]);
      const sourceSession = data.sourceSession ? normalizedSessionId(data.sourceSession) : undefined;
      const sourceState =
        !data.firstEntryId || !data.lastEntryId ? "summary-only" : !sourceSession || snapshot.sessionIds.includes(sourceSession) ? "raw" : "unavailable";
      result.push({
        id: canonical.id,
        kind: "compact",
        sourceState,
        summary: preview(data.summary),
        sourceSession,
        firstEntryId: data.firstEntryId,
        lastEntryId: data.lastEntryId,
        startAt: data.startAt,
        endAt: data.endAt,
      });
      if (!data.parentCompactId) break;
      compact = snapshot.compacts.find((entry) => entry.id === data.parentCompactId);
    }
    const tail = snapshot.entries.slice(boundary?.tailStartIndex ?? 0);
    for (const group of rawGroups(tail, excludeIds)) {
      const first = group[0]!;
      const last = group.at(-1)!;
      validateSourceIds([first.id, last.id]);
      const id = `raw_${hash(JSON.stringify([snapshot.sessionId, first.id, last.id]))}`;
      const users = group.flatMap(renderVisibleUserRecords);
      if (!users.length) continue;
      const block: ContextBlockDescriptor = {
        id,
        kind: "raw",
        sourceState: "raw",
        sourceSession: snapshot.sessionId,
        firstEntryId: first.id,
        lastEntryId: last.id,
        summary: preview(users.map((record) => record.text).join(" ")),
        startAt: compactSourceTimestamp(first as Extract<AgentEntry, { type: "message" }>),
        endAt: compactSourceTimestamp(last as Extract<AgentEntry, { type: "message" }>),
      };
      this.rawDescriptors.set(id, block);
      result.push(block);
    }
    // Only a bounded set of previously issued raw identities is retained, never their bodies.
    while (this.rawDescriptors.size > 512) this.rawDescriptors.delete(this.rawDescriptors.keys().next().value!);
    return result.sort((left, right) => (right.endAt ?? right.startAt ?? 0) - (left.endAt ?? left.startAt ?? 0) || left.id.localeCompare(right.id));
  }

  private issue(cursor: Cursor): string {
    for (const [key, value] of this.cursors) if (JSON.stringify(value) === JSON.stringify(cursor)) return key;
    const key = randomUUID();
    this.cursors.set(key, cursor);
    while (this.cursors.size > 512) this.cursors.delete(this.cursors.keys().next().value!);
    return key;
  }
}

export function normalizedSessionId(value: string): string {
  const id = value.replace(/\.jsonl$/, "");
  if (id.length > 256 || !/^[0-9A-Za-zTZ_-]+$/.test(id)) throw new ContextSourceError("InvalidSourceSession");
  return id;
}

/** Identical archive seeds are aliases; conflicting records must never be silently deduplicated. */
export function resolveCompactAlias(compacts: readonly CompactEntry[], id: string): CompactEntry {
  const matches = compacts.filter((entry) => entry.id === id || entry.data.compartmentId === id);
  const first = matches[0];
  if (!first) throw new Error(`Compartment ID ${JSON.stringify(id)} was not found in this conversation`);
  const signature = compactSignature(first);
  if (matches.some((entry) => compactSignature(entry) !== signature)) throw new ContextSourceError("SourceConflict");
  return first;
}

export async function resolveCompactSource(snapshot: ContextSourceSnapshot, id: string): Promise<ResolvedCompactSource> {
  const compact = resolveCompactAlias(snapshot.compacts, id);
  const { firstEntryId, lastEntryId, sourceSession } = compact.data;
  if (!firstEntryId || !lastEntryId) throw new ContextSourceError("MissingSourceBounds");
  const sessionIds = sourceSession ? [normalizedSessionId(sourceSession)] : snapshot.sessionIds;
  let found: ResolvedCompactSource | undefined;
  for (const sessionId of sessionIds) {
    if (!snapshot.sessionIds.includes(sessionId)) continue;
    const entries = await snapshot.readSession(sessionId);
    const first = entries.flatMap((entry, index) => (entry.id === firstEntryId ? [index] : []));
    const last = entries.flatMap((entry, index) => (entry.id === lastEntryId ? [index] : []));
    if (first.length === 0 || last.length === 0) continue;
    if (first.length !== 1 || last.length !== 1 || last[0]! < first[0]!) throw new ContextSourceError("InvalidSourceBounds");
    const range = entries.slice(first[0], last[0]! + 1);
    if (found) {
      if (rangeFingerprint(found.range) !== rangeFingerprint(range)) throw new ContextSourceError("AmbiguousRawSource");
      continue; // An identical carried raw tail is an alias too.
    }
    found = { compact, sessionId, entries, range };
  }
  if (!found) throw new ContextSourceError("MissingRawSource");
  return found;
}

export function safeSourceRecords(entries: readonly AgentEntry[]): CompressionRecord[] {
  const delivered = collectDeliveredSourceRecords(entries);
  return entries.flatMap((entry) => {
    const users = renderVisibleUserRecords(entry);
    return [...users, ...(delivered.get(entry.id) ?? [])];
  });
}

export function rangeFingerprint(entries: readonly AgentEntry[]): string {
  return hash(JSON.stringify(entries));
}

function rawGroups(entries: readonly AgentEntry[], excluded: ReadonlySet<string>): AgentEntry[][] {
  const groups: AgentEntry[][] = [];
  let group: AgentEntry[] = [];
  const flush = () => {
    if (group.length) groups.push(group);
    group = [];
  };
  for (const entry of entries) {
    if (excluded.has(entry.id)) {
      flush();
      continue;
    }
    if (entry.type === "event" && ["turn.done", "turn.failed", "turn.aborted"].includes(entry.data.type)) {
      flush();
      continue;
    }
    if (entry.type !== "message") continue;
    if (entry.data.role === "user" || (entry.data.role === "custom" && entry.data.type === "yesimbot.message")) flush();
    group.push(entry);
  }
  flush();
  return groups;
}

function compactSignature(entry: CompactEntry): string {
  const data = entry.data;
  return JSON.stringify([
    entry.id,
    data.summary,
    data.firstEntryId,
    data.lastEntryId,
    data.sourceSession ? normalizedSessionId(data.sourceSession) : null,
    data.lineageId,
    data.parentCompactId,
    data.mode,
    data.compartmentId,
    data.startAt,
    data.endAt,
  ]);
}

function validateSourceIds(ids: readonly (string | undefined)[]): void {
  if (ids.some((id) => id !== undefined && (id.length < 1 || id.length > 256))) throw new ContextSourceError("InvalidSourceIdentifier");
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const count = value ?? fallback;
  if (!Number.isInteger(count) || count < 1 || count > maximum) throw new ContextSourceError("InvalidLimit");
  return count;
}

function preview(value: string): string {
  const points = Array.from(value);
  let result = "";
  for (const point of points) {
    if (Buffer.byteLength(result + point, "utf8") > 400) break;
    result += point;
  }
  return result;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
