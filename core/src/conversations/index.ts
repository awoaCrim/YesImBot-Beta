import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { createEntry, createJsonlStorage, createRandomId, type AgentEntry, type AgentStorage } from "@yesimbot/agent-runtime";
import type { LanguageModel } from "ai";

import type { MessageRecord } from "../messages/index.js";
import { resolveLatestCompactBoundary } from "./boundary.js";
import { compactSourceTimestamp, executeCompact, filterEntriesForCompression } from "./compact.js";
import type { CompactFragmentInput, CompactFragmentWriter } from "./fragment-store.js";

export type CompactReason = "auto" | "idle" | "periodic" | "turn-limit" | "prompt-limit" | "manual";

export type CompactResult = { readonly compacted: boolean; readonly reason?: string };

export type ConversationInfo = { filename: string; isActive: boolean; size: number; createdAt: string };

export type ConversationStatus = { active: ConversationInfo | null };

export interface CompactInput {
  model: LanguageModel;
  signal?: AbortSignal;
  force?: boolean;
  excludeMessageIds?: readonly string[];
}

export interface ConversationCompactConfig {
  minMessages: number;
  maxFailures: number;
  /** Resident fragments projected into the model context; older fragments overflow to the store. */
  inlineFragments?: number;
  threshold?: number;
  charTokenRatio?: number;
}

export interface ConversationOptions {
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
  private readonly root: string;
  private readonly compactConfig: ConversationCompactConfig;
  private readonly options: ConversationOptions;
  private readonly inlineFragments: number;
  private storagePathValue: string | undefined;
  private fileStorageValue: AgentStorage<AgentEntry> | undefined;
  private storageTail: Promise<void> = Promise.resolve();
  private failures = 0;

  public constructor(root: string, compactConfig: ConversationCompactConfig = { minMessages: 15, maxFailures: 3 }, options: ConversationOptions = {}) {
    this.root = root;
    this.compactConfig = compactConfig;
    this.options = options;
    this.inlineFragments = Math.max(1, Math.floor(compactConfig.inlineFragments ?? 3));
  }

  public get storage(): AgentStorage<AgentEntry> {
    if (!this.storagePathValue) throw new Error("Conversation has not been initialized");
    return {
      append: (...entries) => this.mutateStorage(() => Promise.resolve(this.currentStorage().append(...entries))),
      read: () => this.readStorage(),
      clear: () => this.mutateStorage(() => Promise.resolve(this.currentStorage().clear())),
    };
  }

  public async init(): Promise<void> {
    if (this.storagePathValue) return;
    this.setStorage(await this.createOrResolve());
    await this.rebuildCompactFragments();
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
    await this.storageTail;
    const filename = id.endsWith(".jsonl") ? id : `${id}.jsonl`;
    if (!/^[0-9A-Za-zTZ_-]+\.jsonl$/.test(filename)) throw new Error("Invalid session id");
    const path = join(this.sessionsPath(), filename);
    await stat(path);
    this.setStorage(path);
    await this.rebuildCompactFragments();
  }

  public async archive(noSummary = false, input?: CompactInput): Promise<void> {
    await this.init();
    if ((await this.readStorage()).length === 0) throw new Error("Cannot archive an empty session");
    if (!noSummary && input) {
      const result = await this.compact("manual", input);
      const entries = await this.readStorage();
      const resident = this.archiveSeed(entries);
      if (result.compacted || resident.some((entry) => entry.type === "compact")) {
        this.setStorage(await this.createSession(resident));
        await this.rebuildCompactFragments();
        return;
      }
    }
    this.setStorage(await this.createSession());
    await this.rebuildCompactFragments();
  }

  public async archiveIfOversize(maxBytes: number, input?: CompactInput): Promise<boolean> {
    await this.init();
    if (maxBytes <= 0) return false;
    const active = (await this.status()).active;
    if (!active || active.size <= maxBytes) return false;
    const resident = this.archiveSeed(await this.readStorage());
    if (resident.some((entry) => entry.type === "compact")) {
      this.setStorage(await this.createSession(resident));
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

  public async compact(reason: CompactReason, input: CompactInput): Promise<CompactResult> {
    await this.init();
    if (this.failures >= this.compactConfig.maxFailures) return { compacted: false, reason: "failure_limit" };
    const entries = await this.readStorage();
    const boundary = resolveLatestCompactBoundary(entries);
    const sourceEntries = entries.slice(boundary?.tailStartIndex ?? 0);
    const excluded = new Set(input.excludeMessageIds ?? []);
    const sourceForCompaction = sourceEntries.filter((entry) => entry.type !== "message" || !excluded.has(entry.id));
    const messages = sourceForCompaction.filter((entry) => entry.type === "message");
    if (!input.force && messages.length < this.compactConfig.minMessages) return { compacted: false, reason: "minimum_messages" };
    if (messages.length === 0) return { compacted: false, reason: "empty_input" };
    const content = filterEntriesForCompression(sourceForCompaction);
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
        })
      ).slice(0, 30_000);
      if (!summary) {
        this.failures += 1;
        return { compacted: false, reason: "empty_summary" };
      }
      const compactId = createRandomId();
      const timestamps = messages.map(compactSourceTimestamp);
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

  private setStorage(path: string): void {
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

  /** The newest `inlineFragments` compact entries stay resident and are projected into context. */
  private residentCompacts(entries: readonly AgentEntry[]): Extract<AgentEntry, { type: "compact" }>[] {
    return entries.filter((entry): entry is Extract<AgentEntry, { type: "compact" }> => entry.type === "compact").slice(-this.inlineFragments);
  }

  /** Carries resident summaries and any raw tail not covered by the newest compact boundary. */
  private archiveSeed(entries: readonly AgentEntry[]): AgentEntry[] {
    const boundary = resolveLatestCompactBoundary(entries);
    const resident = this.residentCompacts(entries);
    const tail = boundary ? entries.slice(boundary.tailStartIndex).filter((entry) => entry.type !== "compact") : [];
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
