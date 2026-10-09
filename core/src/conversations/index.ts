import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  createContinuityEntry,
  createEntry,
  createJsonlStorage,
  createRandomId,
  type AgentEntry,
  type AgentStorage,
  type ContinuityEntryData,
} from "@yesimbot/agent-runtime";
import type { LanguageModel } from "ai";

import type { MessageRecord } from "../messages/index.js";
import { requestUnits } from "../runtimes/context-budget.js";
import { AssistantHistoryFacts, type HistoryFactsModel } from "./assistant-facts.js";
import { resolveLatestCompactBoundary } from "./boundary.js";
import {
  CONTINUITY_PROMPT_VERSION,
  executeCompact,
  executeContinuity,
  filterEntriesForCompression,
  mergeContinuityDrafts,
  renderCompressionRecords,
  renderContinuitySourceChunks,
  validateContinuityEntryData,
  type CompressionRecord,
} from "./compact.js";
import {
  contextRegionLineage,
  contextRegionSource,
  normalizedSessionId,
  rangeFingerprint,
  resolveCompactAlias,
  resolveCompactSource,
  resolveContextRegionSource,
  safeSourceRecords,
  sourceObservationTimes,
  validatedContextRegions,
  type CompactEntry,
  type ContextSourceSnapshot,
  type ContinuityEntry,
} from "./context-blocks.js";
import { recallTerms, type CompactFragmentInput, type CompactFragmentWriter } from "./fragment-store.js";
import {
  CONTEXT_REGION_PROMPT_VERSION,
  validateContextRegionData,
  validateContextRegionDraft,
  type ContextRegionDraft,
  type ContextRegionEntry,
  type FrozenContextRegion,
} from "./historian.js";
import { collectActualDeliveredSourceRecords } from "./internal-history.js";
import type { ReplyJournalSink } from "./reply-journal.js";
import { replyHistoryContent, replySourceEntryIds, resolveReplyHistory } from "./reply-receipt.js";

const DEFAULT_COMPARTMENT_MESSAGES = 20;
const DEFAULT_COMPARTMENT_CHARS = 12_000;
const MAX_EXPANSION_PAGE_SIZE = 50;

export type CompactReason = "auto" | "idle" | "periodic" | "turn-limit" | "prompt-limit" | "manual";

export type CompactResult = { readonly compacted: boolean; readonly reason?: string };

export type ConversationInfo = { filename: string; isActive: boolean; size: number; createdAt: string };

export type ConversationStatus = { active: ConversationInfo | null };

export type CompartmentExpansionRecord = CompressionRecord;

export interface CompactInput {
  model: LanguageModel;
  signal?: AbortSignal;
  force?: boolean;
  excludeMessageIds?: readonly string[];
}

export interface ContinuityInput {
  readonly model: LanguageModel;
  readonly sourceEntryIds: readonly string[];
  readonly signal?: AbortSignal;
  readonly lineageId?: string;
}

export interface ContinuityRecallOptions {
  readonly lineageId: string;
  readonly query: string;
  readonly before: number;
  readonly excludeIds?: ReadonlySet<string>;
  readonly limit?: number;
}

export interface ConversationCompactConfig {
  minMessages: number;
  maxFailures: number;
  /** Resident fragments projected into the model context; older fragments overflow to the store. */
  inlineFragments?: number;
  /** Legacy-compatible one-shot summary or incremental raw-history compartments. */
  mode?: "summary" | "compartment";
  /** Maximum source messages per compartment. */
  chunkMessages?: number;
  /** Maximum rendered source characters per compartment. */
  chunkChars?: number;
  /** Neutralize all retained own speech, compaction and explicit expansion via auxiliaryModel. */
  assistantAsFacts?: boolean;
  threshold?: number;
  charTokenRatio?: number;
}

export interface CompartmentExpansionOptions {
  readonly offset?: number;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface CompartmentExpansionResult {
  readonly compartmentId: string;
  readonly label?: string;
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly entries: readonly CompartmentExpansionRecord[];
  readonly nextOffset?: number;
}

export interface ConversationOptions {
  /** Resolves only the configured auxiliary route for opt-in historical facts. */
  readonly resolveHistoryFactsModel?: () => HistoryFactsModel;
  /** Magic archives carry verified local regions and uncovered raw history without whole compaction. */
  readonly magicContext?: boolean;
  /** Channel scope key used to isolate persisted fragments. */
  readonly channelKey?: string;
  /** Persistent overflow index; absent disables persistence and leaves JSONL as the only source. */
  readonly fragments?: CompactFragmentWriter;
  /** Reports a best-effort fragment failure without failing the turn that triggered it. */
  readonly onFragmentError?: (operation: string, cause: unknown) => void;
}

export interface ConversationReadOptions {
  messageIds?: string[];
  before?: number;
  after?: number;
  from?: number;
  to?: number;
  userIds?: string[];
  limit?: number;
}

interface CompactionChunk {
  readonly entries: readonly AgentEntry[];
  readonly messages: readonly Extract<AgentEntry, { type: "message" }>[];
}

interface ReadMessage {
  readonly record: MessageRecord;
  readonly session: string;
  readonly index: number;
}

interface ReadSession {
  readonly filename: string;
  readonly messages: ReadMessage[];
}

export class Conversation {
  public readonly historyFacts: AssistantHistoryFacts | undefined;
  private readonly root: string;
  private readonly compactConfig: ConversationCompactConfig;
  private readonly options: ConversationOptions;
  private readonly inlineFragments: number;
  private storagePathValue: string | undefined;
  private fileStorageValue: AgentStorage<AgentEntry> | undefined;
  private storageTail: Promise<void> = Promise.resolve();
  private initializing: Promise<void> | undefined;
  private storageGenerationValue = 0;
  private readonly frozenRegions = new WeakSet<FrozenContextRegion>();
  private readonly frozenFactProofs = new WeakMap<FrozenContextRegion, ReadonlyMap<string, string>>();
  private failures = 0;
  private readonly compactSourceIndex = new Map<
    string,
    { stamp: string; compacts: readonly CompactEntry[]; continuities: readonly ContinuityEntry[]; regions: readonly ContextRegionEntry[] }
  >();

  public constructor(root: string, compactConfig: ConversationCompactConfig = { minMessages: 15, maxFailures: 3 }, options: ConversationOptions = {}) {
    this.root = root;
    this.compactConfig = compactConfig;
    this.options = options;
    this.inlineFragments = Math.max(1, Math.floor(compactConfig.inlineFragments ?? 3));
    this.historyFacts =
      compactConfig.assistantAsFacts === true
        ? new AssistantHistoryFacts({
            scope: () => `${this.currentSessionId()}:${this.storageGeneration}`,
            resolveModel: options.resolveHistoryFactsModel,
          })
        : undefined;
  }

  public get storage(): AgentStorage<AgentEntry> {
    if (!this.storagePathValue) throw new Error("Conversation has not been initialized");
    return {
      append: (...entries) => this.mutateStorage(() => Promise.resolve(this.currentStorage().append(...entries))),
      read: () => this.readStorage(),
      clear: () =>
        this.mutateStorage(async () => {
          this.storageGenerationValue += 1;
          this.historyFacts?.clear();
          await this.currentStorage().clear();
        }),
    };
  }

  public async init(): Promise<void> {
    if (this.initializing) return this.initializing;
    if (this.storagePathValue) return;
    this.initializing = (async () => {
      this.setStorage(await this.createOrResolve());
      await this.rebuildCompactFragments();
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }

  public get storageGeneration(): number {
    return this.storageGenerationValue;
  }

  /**
   * Generation-bound append-only writer for the Core actual-delivery journal. It is deliberately
   * independent of the SDK execution signal: effects that already happened locally stay readable
   * after an abort discards the normal tool receipt. A session/generation change rejects late writes
   * instead of repopulating a replacement history.
   */
  public replyProofSink(): ReplyJournalSink {
    return {
      append: (entry, expected) =>
        this.mutateStorage(async () => {
          if (!this.storagePathValue) throw new Error("Conversation has not been initialized");
          expected.signal?.throwIfAborted();
          if (this.storageGenerationValue !== expected.generation || this.currentSessionId() !== expected.sessionId)
            throw new Error("ReplyProofGenerationChanged");
          await this.currentStorage().append(entry);
        }),
    };
  }

  public projectAssistantRecords(
    records: readonly CompressionRecord[],
    signal?: AbortSignal,
    proofs?: ReadonlyMap<string, string>,
  ): Promise<readonly CompressionRecord[]> {
    return this.historyFacts ? this.historyFacts.projectRecords(records, signal, proofs) : Promise.resolve(records);
  }

  public projectFrozenAssistantRecords(frozen: FrozenContextRegion, signal?: AbortSignal): Promise<readonly CompressionRecord[]> {
    if (!this.frozenRegions.has(frozen)) throw new Error("InvalidContextRegionSource");
    return this.projectAssistantRecords(frozen.records, signal, this.frozenFactProofs.get(frozen));
  }

  /** A short canonical read; auxiliary generation happens after this mutation queue is released. */
  public async freezeContextRegion(sourceEntryIds: readonly string[]): Promise<FrozenContextRegion> {
    const sourceIds = [...sourceEntryIds];
    await this.init();
    return this.mutateStorage(async () => {
      const entries = await this.currentStorage().read();
      const sessionId = this.currentSessionId();
      const source = contextRegionSource(entries, sourceIds);
      const frozen: FrozenContextRegion = Object.freeze({
        ...source,
        sessionId,
        sourceSession: sessionId,
        storageGeneration: this.storageGenerationValue,
        lineageId: contextRegionLineage(entries, sessionId),
        promptVersion: CONTEXT_REGION_PROMPT_VERSION,
        sourceEntryIds: Object.freeze(source.sourceEntryIds),
        records: Object.freeze(source.records.map((record) => Object.freeze(record))),
      });
      this.frozenRegions.add(frozen);
      if (this.historyFacts) this.frozenFactProofs.set(frozen, this.historyFacts.proofsForEntries(entries));
      return frozen;
    });
  }

  /** A complete, validated region is appended in one JSONL entry, never as partial tier records. */
  public async commitContextRegion(frozen: FrozenContextRegion, draft: ContextRegionDraft, signal?: AbortSignal): Promise<ContextRegionEntry> {
    const semantic = validateContextRegionDraft(draft);
    return this.mutateStorage(async () => {
      signal?.throwIfAborted();
      if (!this.frozenRegions.has(frozen) || frozen.sessionId !== this.currentSessionId() || frozen.storageGeneration !== this.storageGenerationValue)
        throw new Error("StaleContextRegion");
      const entries = await this.currentStorage().read();
      const source = contextRegionSource(entries, frozen.sourceEntryIds);
      if (
        contextRegionLineage(entries, frozen.sessionId) !== frozen.lineageId ||
        source.sourceFingerprint !== frozen.sourceFingerprint ||
        source.sourceProjectionFingerprint !== frozen.sourceProjectionFingerprint ||
        source.sourceStartAt !== frozen.sourceStartAt ||
        source.sourceEndAt !== frozen.sourceEndAt
      )
        throw new Error("ContextRegionSourceConflict");
      const snapshot = await this.regionSourceSnapshot(entries);
      let reused: ContextRegionEntry | undefined;
      for (const existing of entries) {
        if (existing.type !== "context-region") continue;
        let data;
        try {
          data = validateContextRegionData(existing.data);
        } catch {
          continue;
        }
        if (!data.sourceEntryIds.some((id) => frozen.sourceEntryIds.includes(id))) continue;
        if (
          data.sourceSession !== frozen.sourceSession ||
          data.lineageId !== frozen.lineageId ||
          data.sourceFingerprint !== frozen.sourceFingerprint ||
          JSON.stringify(data.sourceEntryIds) !== JSON.stringify(frozen.sourceEntryIds)
        )
          throw new Error("ContextRegionSourceConflict");
        await resolveContextRegionSource(snapshot, existing);
        if (reused && JSON.stringify(reused.data) !== JSON.stringify(existing.data)) throw new Error("ContextRegionSourceConflict");
        reused = existing;
      }
      signal?.throwIfAborted();
      if (reused) return reused;
      const data = validateContextRegionData({
        version: 1,
        lineageId: frozen.lineageId,
        sourceSession: frozen.sourceSession,
        sourceEntryIds: [...frozen.sourceEntryIds],
        sourceFingerprint: frozen.sourceFingerprint,
        sourceStartAt: frozen.sourceStartAt,
        sourceEndAt: frozen.sourceEndAt,
        promptVersion: frozen.promptVersion,
        ...semantic,
      });
      const entry = createEntry("context-region", data);
      signal?.throwIfAborted();
      await this.currentStorage().append(entry);
      return entry;
    });
  }

  /** Only current reachable roots are recovered; archived originals are verified, not re-summarized. */
  public async contextRegions(): Promise<readonly ContextRegionEntry[]> {
    await this.init();
    return this.mutateStorage(async () => validatedContextRegions(await this.regionSourceSnapshot(await this.currentStorage().read())));
  }

  public currentSessionId(): string {
    if (!this.storagePathValue) throw new Error("Conversation has not been initialized");
    return basename(this.storagePathValue, ".jsonl");
  }

  public async list(): Promise<ConversationInfo[]> {
    const active = this.storagePathValue;
    return Promise.all(
      (await this.files()).reverse().map(async (filename) => ({
        filename,
        isActive: join(this.sessionsPath(), filename) === active,
        size: (await stat(join(this.sessionsPath(), filename))).size,
        createdAt: basename(filename, ".jsonl"),
      })),
    );
  }

  public async status(): Promise<ConversationStatus> {
    return { active: (await this.list()).find((item) => item.isActive) ?? null };
  }

  public failuresCount(): number {
    return this.failures;
  }

  public async messagesSinceLastCompact(): Promise<number> {
    await this.init();
    const entries = await this.readStorage();
    const boundary = resolveLatestCompactBoundary(entries);
    const tailStartIndex = boundary?.tailStartIndex ?? 0;
    return entries.slice(tailStartIndex).filter((entry) => entry.type === "message").length;
  }

  public async userTurnsSinceLastCompact(): Promise<number> {
    await this.init();
    const entries = await this.readStorage();
    const boundary = resolveLatestCompactBoundary(entries);
    const tailStartIndex = boundary?.tailStartIndex ?? 0;
    return entries.slice(tailStartIndex).filter((entry) => entry.type === "message" && isUserTurnMessage(entry.data)).length;
  }

  public async switch(id: string): Promise<void> {
    await this.init();
    const filename = id.endsWith(".jsonl") ? id : `${id}.jsonl`;
    if (!/^[0-9A-Za-zTZ_-]+\.jsonl$/.test(filename)) throw new Error("Invalid session id");
    await this.mutateStorage(async () => {
      const path = join(this.sessionsPath(), filename);
      await stat(path);
      this.setStorage(path);
    });
    await this.rebuildCompactFragments();
  }

  public async archive(noSummary = false, input?: CompactInput): Promise<void> {
    await this.init();
    if (this.options.magicContext) {
      await this.mutateStorage(() => this.archiveMagic(noSummary));
      await this.rebuildCompactFragments();
      return;
    }
    if ((await this.readStorage()).length === 0) throw new Error("Cannot archive an empty session");
    if (!noSummary && input) {
      const result = await this.compact("manual", input);
      const entries = await this.readStorage();
      const resident = this.archiveSeed(entries);
      if (result.compacted || resident.some((entry) => entry.type === "compact" || entry.type === "continuity")) {
        await this.mutateStorage(async () => this.setStorage(await this.createSession(this.archiveSeed(await this.currentStorage().read()))));
        await this.rebuildCompactFragments();
        return;
      }
    }
    await this.mutateStorage(async () => this.setStorage(await this.createSession()));
    await this.rebuildCompactFragments();
  }

  public async archiveIfOversize(maxBytes: number, input?: CompactInput): Promise<boolean> {
    await this.init();
    if (maxBytes <= 0) return false;
    if (this.options.magicContext) {
      const archived = await this.mutateStorage(async () => {
        if ((await stat(this.storagePathValue!)).size <= maxBytes) return false;
        return this.archiveMagic(false, true);
      });
      if (archived) await this.rebuildCompactFragments();
      return archived;
    }
    const active = (await this.status()).active;
    if (!active || active.size <= maxBytes) return false;
    const resident = this.archiveSeed(await this.readStorage());
    if (resident.some((entry) => entry.type === "compact" || entry.type === "continuity")) {
      await this.mutateStorage(async () => this.setStorage(await this.createSession(this.archiveSeed(await this.currentStorage().read()))));
      await this.rebuildCompactFragments();
    } else {
      await this.archive(!input, input);
    }
    return true;
  }

  public async read(options: ConversationReadOptions = {}): Promise<MessageRecord[]> {
    validateReadOptions(options);
    const sessions: ReadSession[] = [];
    const sourceMatches = new Map<string, ReadMessage[]>();

    for (const filename of await this.files()) {
      const messages: ReadMessage[] = [];
      for (const entry of await createJsonlStorage(join(this.sessionsPath(), filename)).read()) {
        if (entry.type !== "message" || !isPlatformMessage(entry.data)) continue;
        messages.push({ record: { ...entry.data.data, timestamp: entry.data.timestamp }, session: filename, index: messages.length });
      }
      sessions.push({ filename, messages });
      for (const message of messages) {
        if (!options.messageIds?.includes(message.record.messageId)) continue;
        const matches = sourceMatches.get(message.record.messageId) ?? [];
        matches.push(message);
        sourceMatches.set(message.record.messageId, matches);
      }
    }

    const sourceIds = options.messageIds ?? [];
    for (const sourceId of sourceIds) {
      const matches = sourceMatches.get(sourceId) ?? [];
      if (matches.length !== 1)
        throw new Error(`Conversation source message ID ${JSON.stringify(sourceId)} ${matches.length ? "is duplicated" : "is missing"}`);
    }

    const selected = sourceIds.length ? selectSourceWindows(sessions, sourceMatches, options) : sessions.flatMap(({ messages }) => messages);
    const filtered = selected.filter((message) => matchesReadFilter(message.record, options));
    const limited = sourceIds.length ? limitSourceMessages(filtered, sourceMatches, options.limit) : limitNewestMessages(filtered, options.limit);
    return limited.sort((left, right) => left.record.timestamp - right.record.timestamp).map(({ record }) => record);
  }

  /** Rebuildable archive metadata index; never caches a second copy of archived raw bodies. */
  public async contextSources(): Promise<ContextSourceSnapshot> {
    if (!this.storagePathValue) throw new Error("Conversation has not been initialized");
    return this.mutateStorage(() => this.contextSourcesNow());
  }

  private async contextSourcesNow(): Promise<ContextSourceSnapshot> {
    const sessionId = this.currentSessionId();
    const entries = await this.currentStorage().read();
    const filenames = (await this.files()).filter((name) => /^[0-9A-Za-zTZ_-]+\.jsonl$/.test(name));
    const sessionIds = filenames.map(normalizedSessionId);
    const compacts: CompactEntry[] = [];
    const continuities: ContinuityEntry[] = [];
    const regions: ContextRegionEntry[] = [];
    for (const filename of filenames) {
      const id = normalizedSessionId(filename);
      if (id === sessionId) {
        compacts.push(...entries.filter((entry): entry is CompactEntry => entry.type === "compact"));
        continuities.push(...entries.filter((entry): entry is ContinuityEntry => entry.type === "continuity"));
        regions.push(...entries.filter((entry): entry is ContextRegionEntry => entry.type === "context-region"));
        continue;
      }
      const info = await stat(join(this.sessionsPath(), filename));
      const stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      const cached = this.compactSourceIndex.get(id);
      if (cached?.stamp === stamp) {
        compacts.push(...cached.compacts);
        continuities.push(...cached.continuities);
        regions.push(...cached.regions);
        continue;
      }
      const historical = await createJsonlStorage(join(this.sessionsPath(), filename)).read();
      const indexed = historical.filter((entry): entry is CompactEntry => entry.type === "compact");
      const indexedContinuities = historical.filter((entry): entry is ContinuityEntry => entry.type === "continuity");
      const indexedRegions = historical.filter((entry): entry is ContextRegionEntry => entry.type === "context-region");
      this.compactSourceIndex.set(id, { stamp, compacts: indexed, continuities: indexedContinuities, regions: indexedRegions });
      compacts.push(...indexed);
      continuities.push(...indexedContinuities);
      regions.push(...indexedRegions);
    }
    for (const id of this.compactSourceIndex.keys()) if (!sessionIds.includes(id)) this.compactSourceIndex.delete(id);
    return {
      sessionId,
      lineageId: contextRegionLineage(entries, sessionId),
      entries,
      compacts,
      continuities,
      regions,
      sessionIds,
      readSession: async (input) => {
        const id = normalizedSessionId(input);
        if (!sessionIds.includes(id)) throw new Error("Source session is not available");
        return id === sessionId ? entries : createJsonlStorage(join(this.sessionsPath(), `${id}.jsonl`)).read();
      },
    };
  }

  /**
   * Creates or reuses one bounded continuity card for an exact verified source set. The model only
   * supplies semantic fields; all provenance is rebuilt from canonical JSONL before the append.
   */
  public async ensureContinuity(input: ContinuityInput): Promise<{ readonly entry: ContinuityEntry; readonly reused: boolean }> {
    await this.init();
    const sourceIds = [...new Set(input.sourceEntryIds)];
    if (sourceIds.length === 0 || sourceIds.length > 256) throw new Error("ContinuitySourceUnavailable");
    return this.mutateStorage(async () => {
      const entries = await this.currentStorage().read();
      const positions = new Map<string, number>();
      entries.forEach((entry, index) => {
        if (sourceIds.includes(entry.id)) {
          if (positions.has(entry.id)) throw new Error("ContinuitySourceConflict");
          positions.set(entry.id, index);
        }
      });
      if (positions.size !== sourceIds.length) throw new Error("ContinuitySourceUnavailable");
      const canonicalIds = replySourceEntryIds(entries, sourceIds);
      const sourceEntries = entries.filter((entry) => canonicalIds.includes(entry.id));
      if (
        sourceEntries.length > 256 ||
        new Set(sourceEntries.map((entry) => entry.id)).size !== sourceEntries.length ||
        sourceEntries.some((entry) => entry.type !== "message")
      )
        throw new Error("ContinuitySourceUnavailable");
      const sourceFingerprint = rangeFingerprint(sourceEntries);
      const sourceSession = this.currentSessionId();
      const verifiedLineageId = continuityLineage(entries, sourceSession);
      if (input.lineageId !== undefined && input.lineageId !== verifiedLineageId) throw new Error("ContinuitySourceConflict");
      const lineageId = verifiedLineageId;
      const firstEntryId = sourceEntries[0]!.id;
      const lastEntryId = sourceEntries.at(-1)!.id;
      const sourceManifest = sourceEntries.map((entry) => entry.id);
      const timestamps = sourceObservationTimes(entries, sourceManifest);
      if (!timestamps.length) throw new Error("ContinuitySourceUnavailable");
      const existing = entries
        .filter((entry): entry is ContinuityEntry => entry.type === "continuity")
        .filter((entry) => {
          try {
            const data = validateContinuityEntryData(entry.data);
            return (
              data.lineageId === lineageId &&
              data.sourceSession === sourceSession &&
              data.firstEntryId === firstEntryId &&
              data.lastEntryId === lastEntryId &&
              data.sourceCount === sourceEntries.length &&
              data.sourceFingerprint === sourceFingerprint &&
              (data.sourceEntryIds === undefined || JSON.stringify(data.sourceEntryIds) === JSON.stringify(sourceManifest))
            );
          } catch {
            return false;
          }
        });
      if (existing.length > 0) {
        const first = existing[0]!;
        if (existing.some((entry) => JSON.stringify(entry.data) !== JSON.stringify(first.data))) throw new Error("ContinuitySourceConflict");
        return { entry: first, reused: true };
      }

      const sourceChunks = renderContinuitySourceChunks(sourceEntries, {
        deliveredRecords: collectActualDeliveredSourceRecords(entries),
        ...(this.historyFacts
          ? {
              assistantAsFacts: true,
              assistantFacts: await this.historyFacts.factsForEntries(entries, input.signal),
            }
          : {}),
      });
      if (sourceChunks.length === 0) throw new Error("ContinuitySourceUnavailable");
      const drafts = [];
      for (const content of sourceChunks) drafts.push(await executeContinuity({ model: input.model, conversation: content, signal: input.signal }));
      const draft = mergeContinuityDrafts(drafts);
      const data: ContinuityEntryData = {
        version: 1,
        lineageId,
        sourceSession,
        firstEntryId,
        lastEntryId,
        sourceCount: sourceEntries.length,
        sourceEntryIds: sourceManifest,
        sourceStartAt: Math.min(...timestamps),
        sourceEndAt: Math.max(...timestamps),
        sourceFingerprint,
        promptVersion: CONTINUITY_PROMPT_VERSION,
        goal: draft.goal,
        decisions: [...draft.decisions],
        constraints: [...draft.constraints],
        facts: [...draft.facts],
        unresolved: [...draft.unresolved],
        completed: [...draft.completed],
        pending: [...draft.pending],
        ...(input.lineageId ? {} : continuityParent(entries, lineageId, Math.min(...timestamps))),
      };
      validateContinuityEntryData(data);
      const entry = createContinuityEntry(data);
      await this.currentStorage().append(entry);
      return { entry, reused: false };
    });
  }

  /** Bounded lexical recall over canonical continuity metadata; raw source remains explicit-only. */
  public async recallContinuity(options: ContinuityRecallOptions): Promise<readonly ContinuityEntry[]> {
    const snapshot = await this.contextSources();
    const terms = recallTerms(options.query);
    if (terms.length === 0) return [];
    const limit = Math.min(3, Math.max(1, options.limit ?? 3));
    const byId = new Map<string, { readonly entry: ContinuityEntry; readonly data: ContinuityEntryData; readonly signature: string }>();
    const conflictingIds = new Set<string>();
    for (const entry of snapshot.continuities ?? []) {
      let data: ContinuityEntryData;
      try {
        data = validateContinuityEntryData(entry.data);
      } catch {
        byId.delete(entry.id);
        conflictingIds.add(entry.id);
        continue;
      }
      if (conflictingIds.has(entry.id)) continue;
      const signature = JSON.stringify(data);
      const previous = byId.get(entry.id);
      if (previous && previous.signature !== signature) {
        byId.delete(entry.id);
        conflictingIds.add(entry.id);
        continue;
      }
      if (!previous) byId.set(entry.id, { entry, data, signature });
    }
    const bySource = new Map<string, { readonly id: string; readonly signature: string }>();
    const conflictingSources = new Set<string>();
    for (const [id, value] of byId) {
      const sourceKey = JSON.stringify([
        value.data.sourceSession,
        value.data.lineageId,
        value.data.firstEntryId,
        value.data.lastEntryId,
        value.data.sourceCount,
        value.data.sourceFingerprint,
      ]);
      if (conflictingSources.has(sourceKey)) {
        byId.delete(id);
        continue;
      }
      const previous = bySource.get(sourceKey);
      if (!previous) {
        bySource.set(sourceKey, { id, signature: value.signature });
      } else if (previous.signature !== value.signature) {
        byId.delete(previous.id);
        byId.delete(id);
        bySource.delete(sourceKey);
        conflictingSources.add(sourceKey);
      } else {
        byId.delete(id);
      }
    }
    const candidates: Array<{ entry: ContinuityEntry; score: number; endAt: number }> = [];
    for (const { entry, data } of byId.values()) {
      const endAt = data.sourceEndAt ?? entry.timestamp;
      if (data.lineageId !== options.lineageId || endAt > options.before || options.excludeIds?.has(entry.id)) continue;
      if (!(await continuitySourceAvailable(snapshot, data))) continue;
      const text = JSON.stringify([data.goal, ...data.decisions, ...data.constraints, ...data.facts, ...data.unresolved, ...data.completed, ...data.pending]);
      const available = new Set(recallTerms(text));
      const score = terms.reduce((total, term) => total + (available.has(term) ? 1 : 0), 0);
      if (score > 0) candidates.push({ entry, score, endAt });
    }
    candidates.sort((left, right) => right.score - left.score || right.endAt - left.endAt || left.entry.id.localeCompare(right.entry.id));
    return candidates.slice(0, limit).map(({ entry }) => entry);
  }

  /** Expands canonical source read-only; opt-in own speech uses bounded auxiliary factual views. */
  public async expandCompartment(compartmentId: string, options: CompartmentExpansionOptions = {}): Promise<CompartmentExpansionResult> {
    if (!this.storagePathValue) throw new Error("Conversation has not been initialized");
    const generation = this.storageGenerationValue;
    const check = () => {
      if (options.signal?.aborted) throw new Error("CancelledContextRead");
      if (generation !== this.storageGenerationValue) throw new Error("StaleContextRead");
    };
    await this.storageTail;
    check();
    if (typeof compartmentId !== "string" || compartmentId.trim().length === 0) throw new Error("Compartment ID must be a non-empty string");
    const offset = options.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) throw new Error("Compartment expansion offset must be a non-negative integer");
    const requestedLimit = options.limit ?? MAX_EXPANSION_PAGE_SIZE;
    if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) throw new Error("Compartment expansion limit must be a positive integer");
    const limit = Math.min(requestedLimit, MAX_EXPANSION_PAGE_SIZE);

    const snapshot = await this.contextSources();
    const region = (await validatedContextRegions(snapshot)).find((entry) => entry.id === compartmentId);
    if (region) {
      const source = await resolveContextRegionSource(snapshot, region);
      const records = await this.projectAssistantRecords(source.records, options.signal, this.historyFacts?.proofsForEntries(source.entries));
      check();
      const entries = records.slice(offset, offset + limit);
      return {
        compartmentId: region.id,
        label: "historical region",
        offset,
        limit,
        total: records.length,
        entries,
        ...(offset + entries.length < records.length ? { nextOffset: offset + entries.length } : {}),
      };
    }
    const source = await resolveCompactSource(snapshot, compartmentId);
    const actual = collectActualDeliveredSourceRecords(source.entries);
    const sourceIds = new Set(
      replySourceEntryIds(
        source.entries,
        source.range.map((entry) => entry.id),
      ),
    );
    const originalRecords = this.historyFacts
      ? safeSourceRecords(source.entries, sourceIds)
      : source.entries.filter((entry) => sourceIds.has(entry.id)).flatMap((entry) => actual.get(entry.id) ?? renderCompressionRecords(entry));
    const records = await this.projectAssistantRecords(originalRecords, options.signal, this.historyFacts?.proofsForEntries(source.entries));
    check();
    const entries = records.slice(offset, offset + limit);
    const nextOffset = offset + entries.length < records.length ? offset + entries.length : undefined;
    return {
      compartmentId: source.compact.data.compartmentId ?? source.compact.id,
      ...(source.compact.data.compartmentLabel ? { label: source.compact.data.compartmentLabel } : {}),
      offset,
      limit,
      total: records.length,
      entries,
      ...(nextOffset === undefined ? {} : { nextOffset }),
    };
  }

  public async compact(reason: CompactReason, input: CompactInput): Promise<CompactResult> {
    await this.init();
    if (this.failures >= this.compactConfig.maxFailures) return { compacted: false, reason: "failure_limit" };
    const entries = await this.readStorage();
    const boundary = resolveLatestCompactBoundary(entries);
    const sourceIds = new Set(
      replySourceEntryIds(
        entries,
        entries.slice(boundary?.tailStartIndex ?? 0).map((entry) => entry.id),
      ),
    );
    const sourceEntries = entries.filter((entry) => sourceIds.has(entry.id));
    if (this.compactConfig.mode === "compartment") return this.compactCompartments(reason, input, sourceEntries, boundary);
    const excluded = new Set(replySourceEntryIds(entries, input.excludeMessageIds ?? []));
    const sourceForCompaction = sourceEntries.filter((entry) => entry.type !== "message" || !excluded.has(entry.id));
    const messages = sourceForCompaction.filter((entry) => entry.type === "message");
    if (!input.force && messages.length < this.compactConfig.minMessages) return { compacted: false, reason: "minimum_messages" };
    if (messages.length === 0) return { compacted: false, reason: "empty_input" };
    const assistantFacts = await this.historyFacts?.factsForEntries(entries, input.signal);
    const content = filterEntriesForCompression(sourceForCompaction, {
      assistantAsFacts: this.compactConfig.assistantAsFacts,
      assistantFacts,
      deliveredRecords: collectActualDeliveredSourceRecords(entries),
    });
    if (!content) return { compacted: false, reason: "empty_input" };
    try {
      // Only raw entries after the latest boundary are summarized. The previous summary is never
      // fed back in, so each fragment stays independent instead of shrinking into a recursive
      // digest of a digest.
      const summary = (
        await executeCompact({
          model: input.model,
          conversation: content,
          signal: input.signal,
          assistantAsFacts: this.compactConfig.assistantAsFacts,
        })
      ).slice(0, 30_000);
      if (!summary) {
        this.failures += 1;
        return { compacted: false, reason: "empty_summary" };
      }
      const compactId = createRandomId();
      const timestamps = sourceObservationTimes(
        entries,
        messages.map((entry) => entry.id),
      );
      const parentCompactId = boundary?.compact.id;
      const compact = createEntry(
        "compact",
        {
          summary,
          lastEntryId: messages.at(-1)!.id,
          firstEntryId: messages[0]!.id,
          sourceSession: this.currentSessionId(),
          lineageId: boundary?.compact.data.lineageId ?? parentCompactId ?? compactId,
          startAt: Math.min(...timestamps),
          endAt: Math.max(...timestamps),
          ...(parentCompactId ? { parentCompactId } : {}),
        },
        { id: compactId },
      );
      await this.storage.append(compact);
      this.failures = 0;
      await this.syncCompactFragments();
      return { compacted: true };
    } catch (cause) {
      this.failures += 1;
      if (input.signal?.aborted) throw cause;
      return {
        compacted: false,
        reason: cause instanceof Error && cause.message === "Compaction produced an empty summary." ? "empty_summary" : "model_failure",
      };
    }
  }

  private async compactCompartments(
    _reason: CompactReason,
    input: CompactInput,
    sourceEntries: readonly AgentEntry[],
    boundary: ReturnType<typeof resolveLatestCompactBoundary>,
  ): Promise<CompactResult> {
    const canonical = await this.readStorage();
    const excluded = new Set(replySourceEntryIds(canonical, input.excludeMessageIds ?? []));
    const sourceForCompaction = sourceEntries.filter((entry) => entry.type !== "message" || !excluded.has(entry.id));
    const messages = sourceForCompaction.filter((entry) => entry.type === "message" && entry.data.role !== "tool");
    if (!input.force && messages.length < this.compactConfig.minMessages) return { compacted: false, reason: "minimum_messages" };
    if (messages.length === 0) return { compacted: false, reason: "empty_input" };

    const assistantFacts = await this.historyFacts?.factsForEntries(canonical, input.signal);
    const deliveredRecords = collectActualDeliveredSourceRecords(canonical);
    const chunks = buildCompactionChunks(sourceForCompaction, {
      maxMessages: this.compactConfig.chunkMessages ?? DEFAULT_COMPARTMENT_MESSAGES,
      maxChars: this.compactConfig.chunkChars ?? DEFAULT_COMPARTMENT_CHARS,
    });
    let compacted = false;
    let parentCompactId = boundary?.compact.id;
    let lineageId = boundary?.compact.data.lineageId ?? parentCompactId;
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const content = filterEntriesForCompression(chunk.entries, {
        mode: "compartment",
        assistantAsFacts: this.compactConfig.assistantAsFacts,
        assistantFacts,
        deliveredRecords,
      });
      if (!content) continue;
      try {
        const summary = (
          await executeCompact({
            model: input.model,
            conversation: content,
            signal: input.signal,
            mode: "compartment",
            assistantAsFacts: this.compactConfig.assistantAsFacts,
          })
        ).slice(0, 30_000);
        if (!summary) throw new Error("Compaction produced an empty summary.");
        const compactId = createRandomId();
        const timestamps = sourceObservationTimes(
          canonical,
          chunk.entries.map((entry) => entry.id),
        );
        const nextLineageId = lineageId ?? compactId;
        const compact = createEntry(
          "compact",
          {
            summary,
            lastEntryId: chunk.entries.at(-1)!.id,
            firstEntryId: chunk.entries[0]!.id,
            sourceSession: this.currentSessionId(),
            lineageId: nextLineageId,
            mode: "compartment",
            compartmentId: compactId,
            compartmentLabel: `compartment-${chunkIndex + 1}`,
            chunkIndex,
            startAt: Math.min(...timestamps),
            endAt: Math.max(...timestamps),
            ...(parentCompactId ? { parentCompactId } : {}),
          },
          { id: compactId },
        );
        await this.storage.append(compact);
        compacted = true;
        parentCompactId = compact.id;
        lineageId = nextLineageId;
        this.failures = 0;
      } catch (cause) {
        this.failures += 1;
        if (input.signal?.aborted) throw cause;
        await this.syncCompactFragments();
        if (compacted) return { compacted: true, reason: "partial_failure" };
        return {
          compacted: false,
          reason: cause instanceof Error && cause.message === "Compaction produced an empty summary." ? "empty_summary" : "model_failure",
        };
      }
    }
    if (!compacted) return { compacted: false, reason: "empty_input" };
    await this.syncCompactFragments();
    return { compacted: true };
  }

  private setStorage(path: string): void {
    this.storageGenerationValue += 1;
    this.historyFacts?.clear();
    this.storagePathValue = path;
    this.fileStorageValue = createJsonlStorage(path);
  }

  private currentStorage(): AgentStorage<AgentEntry> {
    if (!this.fileStorageValue) throw new Error("Conversation has not been initialized");
    return this.fileStorageValue;
  }

  private mutateStorage<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.storageTail.then(operation, operation);
    this.storageTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private readStorage(): Promise<Readonly<AgentEntry[]>> {
    return this.storageTail.then(() => this.currentStorage().read());
  }

  /** Minimal source snapshot for short freeze/commit/recovery operations; no archive-corpus scan. */
  private async regionSourceSnapshot(entries: readonly AgentEntry[]): Promise<ContextSourceSnapshot> {
    const sessionId = this.currentSessionId();
    const sessionIds = (await this.files()).map(normalizedSessionId);
    const reads = new Map<string, Promise<readonly AgentEntry[]>>();
    return {
      sessionId,
      lineageId: contextRegionLineage(entries, sessionId),
      entries,
      compacts: entries.filter((entry): entry is CompactEntry => entry.type === "compact"),
      regions: entries.filter((entry): entry is ContextRegionEntry => entry.type === "context-region"),
      sessionIds,
      readSession: async (input) => {
        const id = normalizedSessionId(input);
        if (!sessionIds.includes(id)) throw new Error("ContextRegionSourceUnavailable");
        if (id === sessionId) return entries;
        let read = reads.get(id);
        if (!read) {
          read = Promise.resolve(createJsonlStorage(join(this.sessionsPath(), `${id}.jsonl`)).read());
          reads.set(id, read);
        }
        return read;
      },
    };
  }

  /** Magic archive never invokes a model and carries every uncovered record, even without summaries. */
  private async archiveMagic(noSummary: boolean, onlyIfSmaller = false): Promise<boolean> {
    const entries = await this.currentStorage().read();
    if (!entries.length) throw new Error("Cannot archive an empty session");
    let seed: readonly AgentEntry[] = [];
    if (!noSummary) {
      const snapshot = await this.regionSourceSnapshot(entries);
      const regions = await validatedContextRegions(snapshot);
      const regionIds = new Set(regions.map((entry) => entry.id));
      const covered = new Set(regions.flatMap((entry) => entry.data.sourceEntryIds));
      const legacyIds = new Set<string>();
      for (const entry of entries) {
        try {
          if (entry.type === "continuity") {
            const data = validateContinuityEntryData(entry.data);
            if (data.lineageId === snapshot.lineageId && (await continuitySourceAvailable(snapshot, data))) legacyIds.add(entry.id);
          } else if (entry.type === "compact") {
            const canonical = resolveCompactAlias(snapshot.compacts, entry.id);
            if (typeof canonical.data.summary !== "string" || !canonical.data.summary.trim()) continue;
            if (canonical.data.firstEntryId && canonical.data.lastEntryId) {
              const source = await resolveCompactSource(snapshot, entry.id);
              for (const sourceEntry of source.range) covered.add(sourceEntry.id);
            }
            legacyIds.add(entry.id);
          }
        } catch {
          /* Invalid derived metadata must not become an archive seed. Raw remains intact. */
        }
      }
      const messages = entries.filter((entry) => entry.type === "message");
      const modern = resolveReplyHistory(entries);
      const units = requestUnits(
        messages.map((entry) => ({ content: replyHistoryContent(entry, modern.maskedCalls) })),
        messages.map((entry) => ({ kind: "history" as const, sourceEntryIds: modern.groups.get(entry.id) ?? [entry.id] })),
      );
      const removable = new Set<string>();
      const canonicalCovered = new Set(replySourceEntryIds(entries, covered, modern));
      for (const unit of units) {
        if (!unit.mandatory && [...unit.sourceEntryIds].every((id) => canonicalCovered.has(id))) for (const id of unit.sourceEntryIds) removable.add(id);
      }
      // Original files remain untouched. Carry only verified semantic regions and uncovered
      // protocol units; the non-Magic history adapter can render regions after a mode switch.
      seed = entries.filter((entry) => {
        if (entry.type === "context-region") return regionIds.has(entry.id);
        if (entry.type === "compact" || entry.type === "continuity") return legacyIds.has(entry.id);
        return !removable.has(entry.id);
      });
    }
    // An automatic archive with an identical seed would make another oversized file on every
    // inbound message. Wait for useful committed coverage instead; manual archive still rotates.
    if (onlyIfSmaller && seed.length >= entries.length) return false;
    this.setStorage(await this.createSession(seed));
    return true;
  }

  /** The newest `inlineFragments` compact entries stay resident and are projected into context. */
  private residentCompacts(entries: readonly AgentEntry[]): Extract<AgentEntry, { type: "compact" }>[] {
    return entries.filter((entry): entry is Extract<AgentEntry, { type: "compact" }> => entry.type === "compact").slice(-this.inlineFragments);
  }

  /** Carries resident summaries and any raw tail not covered by the newest compact boundary. */
  private archiveSeed(entries: readonly AgentEntry[]): AgentEntry[] {
    const boundary = resolveLatestCompactBoundary(entries);
    const resident = this.residentCompacts(entries);
    const tailIds = new Set(replySourceEntryIds(entries, boundary ? entries.slice(boundary.tailStartIndex).map((entry) => entry.id) : []));
    const tail = entries.filter((entry) => tailIds.has(entry.id) && entry.type !== "compact");
    return [...resident, ...tail];
  }

  /**
   * JSONL stays the source of truth; the database is a rebuildable overflow index. Every compact
   * entry outside the active session's resident window is upserted so restart, archive and switch
   * can repair an interrupted index write. A store failure never fails the current turn.
   */
  private async rebuildCompactFragments(): Promise<void> {
    const store = this.options.fragments;
    const channelKey = this.options.channelKey;
    if (!store || !channelKey) return;
    try {
      const residentIds = new Set(
        (await this.readStorage())
          .filter((entry): entry is Extract<AgentEntry, { type: "compact" }> => entry.type === "compact")
          .slice(-this.inlineFragments)
          .map((entry) => entry.id),
      );
      const fragments = new Map<string, CompactFragmentInput>();
      for (const filename of await this.files()) {
        const entries = await createJsonlStorage(join(this.sessionsPath(), filename)).read();
        for (const entry of entries) {
          if (entry.type !== "compact" || residentIds.has(entry.id)) continue;
          fragments.set(entry.id, toCompactFragment(entry, channelKey));
        }
      }
      const overflow = [...fragments.values()];
      if (overflow.length === 0) return;
      await store.upsert(overflow);
    } catch (cause) {
      this.reportFragmentError("rebuild", cause);
    }
  }

  /** Indexes newly overflowed entries in the active session after compaction. */
  private async syncCompactFragments(): Promise<void> {
    const store = this.options.fragments;
    const channelKey = this.options.channelKey;
    if (!store || !channelKey) return;
    try {
      const compacts = (await this.readStorage()).filter((entry): entry is Extract<AgentEntry, { type: "compact" }> => entry.type === "compact");
      const overflow = compacts.slice(0, Math.max(0, compacts.length - this.inlineFragments));
      if (overflow.length === 0) return;
      await store.upsert(overflow.map((entry) => toCompactFragment(entry, channelKey)));
    } catch (cause) {
      this.reportFragmentError("sync", cause);
    }
  }

  private reportFragmentError(operation: string, cause: unknown): void {
    try {
      this.options.onFragmentError?.(operation, cause);
    } catch {
      // Diagnostics are best-effort too; storage failure must not break the regular conversation.
    }
  }

  private async createOrResolve(): Promise<string> {
    await mkdir(this.sessionsPath(), { recursive: true });
    const files = await this.files();
    return files.at(-1) ? join(this.sessionsPath(), files.at(-1)!) : this.createSession();
  }

  private async createSession(entries: readonly AgentEntry[] = []): Promise<string> {
    await mkdir(this.sessionsPath(), { recursive: true });
    const payload = entries.length ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
    for (;;) {
      const path = join(this.sessionsPath(), `${formatTimestamp(new Date())}.jsonl`);
      try {
        await writeFile(path, payload, { flag: "wx" });
        return path;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      }
    }
  }

  private async files(): Promise<string[]> {
    try {
      return (await readdir(this.sessionsPath())).filter((name) => name.endsWith(".jsonl") && name !== "messages.jsonl").sort();
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
  }

  private sessionsPath(): string {
    return join(this.root, "sessions");
  }
}

function buildCompactionChunks(entries: readonly AgentEntry[], options: { readonly maxMessages: number; readonly maxChars: number }): CompactionChunk[] {
  const maxMessages = Number.isInteger(options.maxMessages) && options.maxMessages > 0 ? options.maxMessages : DEFAULT_COMPARTMENT_MESSAGES;
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : DEFAULT_COMPARTMENT_CHARS;
  const chunks: CompactionChunk[] = [];
  let current: AgentEntry[] = [];
  let messages: Extract<AgentEntry, { type: "message" }>[] = [];
  let chars = 0;
  const flush = (): void => {
    if (messages.length === 0) return;
    chunks.push({ entries: [...current], messages: [...messages] });
    current = [];
    messages = [];
    chars = 0;
  };

  const modern = resolveReplyHistory(entries);
  const positions = new Map(entries.map((entry, index) => [entry.id, index]));
  let indivisibleUntil = -1;
  for (const [index, entry] of entries.entries()) {
    const group = modern.groups.get(entry.id);
    const last = group ? Math.max(...group.map((id) => positions.get(id) ?? index)) : index;
    const entryChars = (modern.records.get(entry.id) ?? renderCompressionRecords(entry)).reduce((total, record) => total + record.text.length, 0);
    if (index > indivisibleUntil && messages.length > 0 && (messages.length >= maxMessages || chars + entryChars > maxChars)) flush();
    indivisibleUntil = Math.max(indivisibleUntil, last);
    current.push(entry);
    if (entry.type === "message" && entry.data.role !== "tool") messages.push(entry);
    chars += entryChars;
    // Safety maxima guide chunks, but never sever the admission/checkpoint/mirror proof unit.
    if (index >= indivisibleUntil && (messages.length >= maxMessages || chars >= maxChars)) flush();
  }
  flush();
  return chunks;
}

function validateReadOptions(options: ConversationReadOptions): void {
  for (const name of ["before", "after"] as const) {
    const value = options[name];
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new Error(`Conversation read ${name} must be a non-negative integer`);
  }
  if (options.from !== undefined && !Number.isFinite(options.from)) throw new Error("Conversation read from must be a finite timestamp");
  if (options.to !== undefined && !Number.isFinite(options.to)) throw new Error("Conversation read to must be a finite timestamp");
  if (options.from !== undefined && options.to !== undefined && options.from > options.to) throw new Error("Conversation read from must not exceed to");
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0))
    throw new Error("Conversation read limit must be a positive integer");
}

function selectSourceWindows(
  sessions: readonly ReadSession[],
  matches: ReadonlyMap<string, readonly ReadMessage[]>,
  options: ConversationReadOptions,
): ReadMessage[] {
  const selected = new Map<string, ReadMessage>();
  const before = options.before ?? 0;
  const after = options.after ?? 0;
  for (const source of matches.values()) {
    const message = source[0]!;
    const session = sessions.find(({ filename }) => filename === message.session)!;
    const start = Math.max(0, message.index - before);
    const end = Math.min(session.messages.length, message.index + after + 1);
    for (const nearby of session.messages.slice(start, end)) selected.set(readMessageKey(nearby), nearby);
  }
  return [...selected.values()];
}

function matchesReadFilter(record: MessageRecord, options: ConversationReadOptions): boolean {
  return (
    (options.from === undefined || record.timestamp >= options.from) &&
    (options.to === undefined || record.timestamp <= options.to) &&
    (options.userIds === undefined || options.userIds.includes(record.user.id))
  );
}

function limitSourceMessages(messages: readonly ReadMessage[], matches: ReadonlyMap<string, readonly ReadMessage[]>, limit: number | undefined): ReadMessage[] {
  if (limit === undefined) return [...messages];
  const sourceKeys = new Set([...matches.values()].map(([message]) => readMessageKey(message!)));
  const sources = messages.filter((message) => sourceKeys.has(readMessageKey(message)));
  if (sources.length >= limit) return sources;
  const distance = (message: ReadMessage) =>
    Math.min(...sources.filter((source) => source.session === message.session).map((source) => Math.abs(source.index - message.index)));
  return [
    ...sources,
    ...messages
      .filter((message) => !sourceKeys.has(readMessageKey(message)))
      .sort((left, right) => distance(left) - distance(right) || left.record.timestamp - right.record.timestamp)
      .slice(0, limit - sources.length),
  ];
}

function limitNewestMessages(messages: readonly ReadMessage[], limit: number | undefined): ReadMessage[] {
  if (limit === undefined) return [...messages];
  return [...messages].sort((left, right) => right.record.timestamp - left.record.timestamp).slice(0, limit);
}

function readMessageKey(message: ReadMessage): string {
  const { platform, selfId, channel, messageId } = message.record;
  return `${platform}\u0000${selfId}\u0000${channel.id}\u0000${messageId}`;
}

function isUserTurnMessage(value: AgentEntry["data"]): boolean {
  if (typeof value !== "object" || value === null || !("role" in value)) return false;
  return value.role === "user" || isPlatformMessage(value);
}

/**
 * Legacy compact entries predate the per-fragment metadata and only carry a summary. They stay
 * readable, and recall uses their entry timestamp as a conservative bound without persisting it as
 * a source-message time; no event time is invented inside the summary text itself.
 */
async function continuitySourceAvailable(snapshot: ContextSourceSnapshot, data: ContinuityEntryData): Promise<boolean> {
  try {
    const sessionId = normalizedSessionId(data.sourceSession);
    if (!snapshot.sessionIds.includes(sessionId)) return false;
    const entries = sessionId === snapshot.sessionId ? snapshot.entries : await snapshot.readSession(sessionId);
    const first = entries.flatMap((entry, index) => (entry.id === data.firstEntryId ? [index] : []));
    const last = entries.flatMap((entry, index) => (entry.id === data.lastEntryId ? [index] : []));
    if (first.length !== 1 || last.length !== 1 || last[0]! < first[0]!) return false;
    const range = entries.slice(first[0], last[0]! + 1);
    const messageCount = range.filter((entry) => entry.type === "message").length;
    if (messageCount < data.sourceCount) return false;
    if (data.sourceEntryIds) {
      const selected = data.sourceEntryIds.map((id) => entries.filter((entry) => entry.id === id));
      if (selected.some((matches) => matches.length !== 1 || matches[0]!.type !== "message")) return false;
      const sourceEntries = selected.map(([entry]) => entry!);
      const sourcePositions = sourceEntries.map((entry) => entries.indexOf(entry));
      if (
        data.sourceEntryIds[0] !== data.firstEntryId ||
        data.sourceEntryIds.at(-1) !== data.lastEntryId ||
        sourcePositions.some((position, index) => position < 0 || (index > 0 && position <= sourcePositions[index - 1]!)) ||
        sourceEntries.length !== data.sourceCount ||
        rangeFingerprint(sourceEntries) !== data.sourceFingerprint ||
        JSON.stringify(replySourceEntryIds(entries, data.sourceEntryIds)) !== JSON.stringify(data.sourceEntryIds)
      )
        return false;
    } else {
      if (messageCount !== data.sourceCount || rangeFingerprint(range.filter((entry) => entry.type === "message")) !== data.sourceFingerprint) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function continuityLineage(entries: readonly AgentEntry[], sessionId: string): string {
  const latest = [...entries].reverse().find((entry): entry is CompactEntry => entry.type === "compact");
  return latest?.data.lineageId ?? latest?.id ?? sessionId;
}

function continuityParent(entries: readonly AgentEntry[], lineageId: string, before: number): { readonly parentStateId?: string } {
  const parent = [...entries].reverse().find((entry): entry is ContinuityEntry => {
    if (entry.type !== "continuity") return false;
    try {
      const data = validateContinuityEntryData(entry.data);
      return data.lineageId === lineageId && (data.sourceEndAt ?? entry.timestamp) < before;
    } catch {
      return false;
    }
  });
  return parent ? { parentStateId: parent.id } : {};
}

function toCompactFragment(entry: Extract<AgentEntry, { type: "compact" }>, channelKey: string): CompactFragmentInput {
  const { data } = entry;
  return {
    id: entry.id,
    channelKey,
    lineageId: data.lineageId ?? entry.id,
    lastEntryId: data.lastEntryId,
    summary: data.summary,
    createdAt: entry.timestamp,
    ...(data.endAt === undefined ? {} : { endAt: data.endAt }),
    ...(data.parentCompactId ? { parentCompactId: data.parentCompactId } : {}),
    ...(data.sourceSession ? { sourceSession: data.sourceSession } : {}),
    ...(data.firstEntryId ? { firstEntryId: data.firstEntryId } : {}),
    ...(data.startAt === undefined ? {} : { startAt: data.startAt }),
  };
}

function isPlatformMessage(value: AgentEntry["data"]): value is {
  readonly role: "custom";
  readonly id: string;
  readonly type: "yesimbot.message";
  readonly timestamp: number;
  readonly data: Omit<MessageRecord, "timestamp">;
} {
  return typeof value === "object" && value !== null && "role" in value && value.role === "custom" && "type" in value && value.type === "yesimbot.message";
}

function formatTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export type { ContextRegionDraft, ContextRegionEntry, FrozenContextRegion } from "./historian.js";
