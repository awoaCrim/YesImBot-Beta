import { createCustomMessage, createRandomId, type AgentEntry, type AgentMessage, type CustomMessageBase } from "@yesimbot/agent-runtime";

import type { CompressionRecord } from "./compact.js";

/**
 * One typed owner for every modern reply delivery proof.
 *
 * Two forms share this module:
 * - the bounded `replyReceipt` tool result (a mirror bound to `proofInvocationId`/`proofSequence`);
 * - the Core-owned `yesimbot.reply-delivery-proof` custom-message journal, which records actual
 *   observed effects independently of SDK step persistence (abort can discard the normal pair).
 *
 * There is exactly one strict decoder/reducer here. Consumer modules project its result and must
 * never re-derive proof from tool arguments, drafts, facts or partial page ranges.
 */

export const REPLY_RECEIPT_VERSION = 1;

export const REPLY_DELIVERY_PROOF_TYPE = "yesimbot.reply-delivery-proof" as const;

/** Hard bounds; safety maxima, never layout targets. */
export const REPLY_MAX_UNITS = 13;

export const REPLY_MAX_TEXT_UNITS = 12;

export const REPLY_MAX_STICKERS = 1;

export const REPLY_MAX_UNIT_TEXT_BYTES = 32 * 1024;

export const REPLY_MAX_PHASE_BYTES = 32 * 1024;

export const REPLY_MAX_SEGMENT_IDS = 64;

export const REPLY_MAX_SEGMENTS_PER_UNIT = 64;

/** Present-but-invalid sentinel so absent (`undefined`) stays distinct from malformed. */
const INVALID = Symbol("invalid-reply-proof-field");

const requiredIds = replyPlatformIds;

export type ReplyUnitKind = "text" | "sticker";

export type ReplyUnitProof = ReplyTextUnitProof | ReplyStickerUnitProof;

export type ReplyFailureStage = "preflight" | "delivery";

export type ReplyUncertainTransport = "text" | "sticker";

export type ReplyDeliveryProofData = ReplyDeliveryStart | ReplyDeliveryCheckpoint | ReplyDeliveryClose | ReplyDeliveryLateObservation;

export type ReplyDeliveryProofMessage = CustomMessageBase<typeof REPLY_DELIVERY_PROOF_TYPE, ReplyDeliveryProofData>;

export interface ReplyTextUnitProof {
  readonly index: number;
  readonly kind: "text";
  readonly text: string;
  /** One entry per delivered physical segment; each entry holds its own nonempty platform IDs. */
  readonly segmentMessageIds: readonly (readonly string[])[];
}

export interface ReplyStickerUnitProof {
  readonly index: number;
  readonly kind: "sticker";
  readonly stickerId: string;
  readonly contentHash: string;
  readonly messageIds: readonly string[];
}

/** The modern tool-result receipt, published on success and on every failure including no-output. */
export interface ReplyReceipt {
  readonly version: typeof REPLY_RECEIPT_VERSION;
  readonly phaseId: string;
  readonly totalUnits: number;
  readonly status: "complete" | "failed";
  readonly completeUnits: readonly ReplyUnitProof[];
  readonly failureStage?: ReplyFailureStage;
  readonly failedUnitIndex?: number;
  readonly incompleteSegmentIds?: readonly string[];
  readonly uncertainTransport?: ReplyUncertainTransport;
  readonly proofInvocationId?: string;
  readonly proofSequence?: number;
}

export interface ReplyExpectedUnit {
  readonly kind: ReplyUnitKind;
  readonly segments: number;
}

export interface ReplyDeliveryStart {
  readonly version: typeof REPLY_RECEIPT_VERSION;
  readonly kind: "start";
  readonly invocationId: string;
  readonly phaseId: string;
  readonly toolCallId: string;
  readonly turnId: string;
  readonly channelId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly inputFingerprint: string;
  readonly expectedUnits: readonly ReplyExpectedUnit[];
  readonly timestamp: number;
}

export interface ReplyDeliveryCheckpoint {
  readonly version: typeof REPLY_RECEIPT_VERSION;
  readonly kind: "checkpoint";
  readonly invocationId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly unitIndex: number;
  readonly unitKind: ReplyUnitKind;
  readonly segmentIndex: number;
  readonly messageIds: readonly string[];
  /** Present only when this checkpoint completes its logical unit with an actual public body. */
  readonly unitText?: string;
  readonly stickerId?: string;
  readonly contentHash?: string;
  readonly timestamp: number;
}

export interface ReplyDeliveryClose {
  readonly version: typeof REPLY_RECEIPT_VERSION;
  readonly kind: "close";
  readonly invocationId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly status: "complete" | "failed";
  readonly failureStage?: ReplyFailureStage;
  readonly failedUnitIndex?: number;
  readonly uncertainTransport?: ReplyUncertainTransport;
  readonly timestamp: number;
}

/** A bounded observation of an already-attempted boundary; it can never start another send. */
export interface ReplyDeliveryLateObservation {
  readonly version: typeof REPLY_RECEIPT_VERSION;
  readonly kind: "late";
  readonly invocationId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly unitIndex: number;
  readonly unitKind: ReplyUnitKind;
  readonly segmentIndex: number;
  readonly messageIds: readonly string[];
  readonly unitText?: string;
  readonly stickerId?: string;
  readonly contentHash?: string;
  readonly timestamp: number;
}

export interface ResolvedReplyJournal {
  readonly invocationId: string;
  readonly phaseId: string;
  readonly toolCallId: string;
  readonly turnId: string;
  readonly channelId: string;
  readonly sessionId: string;
  readonly generation: number;
  /** Fully committed complete units only, in order. Partial segment IDs stay unproved. */
  readonly units: readonly ReplyUnitProof[];
  readonly status: "open" | "complete" | "failed";
  readonly failureStage?: ReplyFailureStage;
  readonly failedUnitIndex?: number;
  readonly uncertainTransport?: ReplyUncertainTransport;
  /** Actual observation timestamps in physical order; never derived from a plan or close time. */
  readonly observedAt: readonly number[];
  readonly unitTimestamps: readonly number[];
  readonly effects: readonly string[];
  /** The SDK mirror binds to this committed state before any later observation. */
  readonly snapshots: ReadonlyMap<number, ReplyReceipt>;
  readonly entryIds: readonly string[];
}

export interface ReducedReplyJournal {
  /** One entry per provable invocation; failed-closed invocations are absent. */
  readonly journals: ReadonlyMap<string, ResolvedReplyJournal>;
  /** Invocation ids whose evidence was malformed, conflicting or duplicate. */
  readonly invalid: ReadonlySet<string>;
  /** Every journal entry id seen, including unreadable ones. */
  readonly entryIds: ReadonlySet<string>;
  readonly byEntryId: ReadonlyMap<string, string>;
}

export interface ReplyHistoryProof {
  readonly records: ReadonlyMap<string, readonly CompressionRecord[]>;
  readonly groups: ReadonlyMap<string, readonly string[]>;
  readonly maskedCalls: ReadonlySet<string>;
  readonly journalEntryIds: ReadonlySet<string>;
  /** Readable owners only; status/actual times come from the same verified journal as bodies. */
  readonly journals: ReadonlyMap<string, ResolvedReplyJournal>;
}

declare module "@yesimbot/agent-runtime" {
  interface AgentCustomMessages {
    "yesimbot.reply-delivery-proof": ReplyDeliveryProofMessage;
  }
}

export function createReplyDeliveryProofMessage(data: ReplyDeliveryProofData, options: { id?: string; timestamp?: number } = {}): ReplyDeliveryProofMessage {
  return createCustomMessage(REPLY_DELIVERY_PROOF_TYPE, data, options);
}

export function isReplyDeliveryProof(message: AgentMessage): message is ReplyDeliveryProofMessage {
  return message.role === "custom" && message.type === REPLY_DELIVERY_PROOF_TYPE;
}

export function createReplyDeliveryStart(input: Omit<ReplyDeliveryStart, "version" | "kind" | "timestamp">): ReplyDeliveryStart {
  return { version: REPLY_RECEIPT_VERSION, kind: "start", timestamp: Date.now(), ...input };
}

export function createReplyDeliveryCheckpoint(input: Omit<ReplyDeliveryCheckpoint, "version" | "kind" | "timestamp">): ReplyDeliveryCheckpoint {
  return { version: REPLY_RECEIPT_VERSION, kind: "checkpoint", timestamp: Date.now(), ...input };
}

export function createReplyDeliveryClose(input: Omit<ReplyDeliveryClose, "version" | "kind" | "timestamp">): ReplyDeliveryClose {
  return { version: REPLY_RECEIPT_VERSION, kind: "close", timestamp: Date.now(), ...input };
}

export function createReplyDeliveryLateObservation(input: Omit<ReplyDeliveryLateObservation, "version" | "kind" | "timestamp">): ReplyDeliveryLateObservation {
  return { version: REPLY_RECEIPT_VERSION, kind: "late", timestamp: Date.now(), ...input };
}

export function newReplyPhaseId(): string {
  return createRandomId();
}

/**
 * Strict receipt decoder. A present but malformed/unknown-version marker fails closed: callers must
 * treat `undefined` as "no provable modern output" and never fall back to args, facts or drafts.
 */
export function decodeReplyReceipt(value: unknown): ReplyReceipt | undefined {
  if (
    !isRecord(value) ||
    value.version !== REPLY_RECEIPT_VERSION ||
    !onlyKeys(value, [
      "version",
      "phaseId",
      "totalUnits",
      "status",
      "completeUnits",
      "failureStage",
      "failedUnitIndex",
      "incompleteSegmentIds",
      "uncertainTransport",
      "proofInvocationId",
      "proofSequence",
    ])
  )
    return undefined;
  const phaseId = requiredString(value.phaseId);
  if (!phaseId || !isCount(value.totalUnits) || value.totalUnits > REPLY_MAX_UNITS) return undefined;
  if (value.status !== "complete" && value.status !== "failed") return undefined;
  if (!Array.isArray(value.completeUnits) || value.completeUnits.length > value.totalUnits || value.completeUnits.length > REPLY_MAX_UNITS) return undefined;
  const units: ReplyUnitProof[] = [];
  for (const entry of value.completeUnits) {
    const unit = decodeUnitProof(entry);
    if (!unit) return undefined;
    units.push(unit);
  }
  if (
    units.some((unit, position) => unit.index !== position) ||
    units.reduce((sum, unit) => sum + (unit.kind === "text" ? Buffer.byteLength(unit.text, "utf8") : 0), 0) > REPLY_MAX_PHASE_BYTES
  )
    return undefined;
  const seenIds = new Set<string>();
  for (const unit of units) {
    for (const id of unit.kind === "text" ? unit.segmentMessageIds.flat() : unit.messageIds) {
      if (seenIds.has(id)) return undefined;
      seenIds.add(id);
    }
  }

  const failureStage = value.failureStage;
  if (failureStage !== undefined && failureStage !== "preflight" && failureStage !== "delivery") return undefined;
  const uncertainTransport = value.uncertainTransport;
  if (uncertainTransport !== undefined && uncertainTransport !== "text" && uncertainTransport !== "sticker") return undefined;
  const failedUnitIndex = optionalCount(value.failedUnitIndex);
  if (failedUnitIndex === INVALID) return undefined;
  const incompleteSegmentIds = optionalIds(value.incompleteSegmentIds);
  if (incompleteSegmentIds === INVALID) return undefined;
  const proofInvocationId = optionalNonEmptyString(value.proofInvocationId);
  if (proofInvocationId === INVALID) return undefined;
  const proofSequence = optionalCount(value.proofSequence);
  if (proofSequence === INVALID || (proofInvocationId === undefined) !== (proofSequence === undefined)) return undefined;
  if (units.filter((unit) => unit.kind === "text").length > REPLY_MAX_TEXT_UNITS || units.filter((unit) => unit.kind === "sticker").length > 1)
    return undefined;
  if (units.reduce((sum, unit) => sum + (unit.kind === "text" ? unit.segmentMessageIds.length : 1), 0) > REPLY_MAX_SEGMENTS_PER_UNIT) return undefined;
  if (incompleteSegmentIds?.some((id) => seenIds.has(id)) || (incompleteSegmentIds && new Set(incompleteSegmentIds).size !== incompleteSegmentIds.length))
    return undefined;

  if (value.status === "complete") {
    if (failureStage !== undefined || failedUnitIndex !== undefined || incompleteSegmentIds !== undefined || uncertainTransport !== undefined) return undefined;
    if (value.totalUnits === 0 || units.length !== value.totalUnits) return undefined;
    return {
      version: REPLY_RECEIPT_VERSION,
      phaseId,
      totalUnits: value.totalUnits,
      status: "complete",
      completeUnits: units,
      ...(proofInvocationId ? { proofInvocationId } : {}),
      ...(proofSequence === undefined ? {} : { proofSequence }),
    };
  }

  // A failed receipt always names its stage and index. Unknown input is the explicit zero-output
  // variant (totalUnits 0 / index 0 / preflight), never an index-derived delivered prefix.
  if (failureStage === undefined || failedUnitIndex === undefined) return undefined;
  if (failureStage === "preflight") {
    if (units.length !== 0 || uncertainTransport !== undefined || incompleteSegmentIds !== undefined) return undefined;
    if (value.totalUnits === 0 ? failedUnitIndex !== 0 : failedUnitIndex >= value.totalUnits) return undefined;
  } else if (
    units.length !== failedUnitIndex ||
    failedUnitIndex > value.totalUnits ||
    (failedUnitIndex === value.totalUnits && (incompleteSegmentIds !== undefined || uncertainTransport !== undefined))
  ) {
    return undefined;
  }
  return {
    version: REPLY_RECEIPT_VERSION,
    phaseId,
    totalUnits: value.totalUnits,
    status: "failed",
    completeUnits: units,
    failureStage,
    failedUnitIndex,
    ...(incompleteSegmentIds ? { incompleteSegmentIds } : {}),
    ...(uncertainTransport ? { uncertainTransport } : {}),
    ...(proofInvocationId ? { proofInvocationId } : {}),
    ...(proofSequence === undefined ? {} : { proofSequence }),
  };
}

export function hasReplyReceiptMarker(value: unknown): boolean {
  return isRecord(value) && Object.hasOwn(value, "replyReceipt");
}

export function createPreflightFailureReceipt(input: { phaseId: string; totalUnits: number; failedUnitIndex: number }): ReplyReceipt {
  const totalUnits = isCount(input.totalUnits) && input.totalUnits <= REPLY_MAX_UNITS ? input.totalUnits : 0;
  const index = isCount(input.failedUnitIndex) ? input.failedUnitIndex : 0;
  if (totalUnits === 0)
    return {
      version: REPLY_RECEIPT_VERSION,
      phaseId: input.phaseId,
      totalUnits: 0,
      status: "failed",
      completeUnits: [],
      failureStage: "preflight",
      failedUnitIndex: 0,
    };
  return {
    version: REPLY_RECEIPT_VERSION,
    phaseId: input.phaseId,
    totalUnits,
    status: "failed",
    completeUnits: [],
    failureStage: "preflight",
    failedUnitIndex: Math.min(index, totalUnits - 1),
  };
}

export function createCompleteReceipt(input: {
  phaseId: string;
  units: readonly ReplyUnitProof[];
  proof?: { invocationId: string; sequence: number };
}): ReplyReceipt {
  return {
    version: REPLY_RECEIPT_VERSION,
    phaseId: input.phaseId,
    totalUnits: input.units.length,
    status: "complete",
    completeUnits: input.units,
    ...(input.proof ? { proofInvocationId: input.proof.invocationId, proofSequence: input.proof.sequence } : {}),
  };
}

export function createDeliveryFailureReceipt(input: {
  phaseId: string;
  totalUnits: number;
  completeUnits: readonly ReplyUnitProof[];
  failedUnitIndex: number;
  incompleteSegmentIds?: readonly string[];
  uncertainTransport?: ReplyUncertainTransport;
  proof?: { invocationId: string; sequence: number };
}): ReplyReceipt {
  return {
    version: REPLY_RECEIPT_VERSION,
    phaseId: input.phaseId,
    totalUnits: input.totalUnits,
    status: "failed",
    completeUnits: input.completeUnits,
    failureStage: "delivery",
    failedUnitIndex: input.failedUnitIndex,
    ...(input.incompleteSegmentIds?.length ? { incompleteSegmentIds: [...input.incompleteSegmentIds] } : {}),
    ...(input.uncertainTransport ? { uncertainTransport: input.uncertainTransport } : {}),
    ...(input.proof ? { proofInvocationId: input.proof.invocationId, proofSequence: input.proof.sequence } : {}),
  };
}

/**
 * Reduces the Core journal by strict physical order: exactly one start, then ordered checkpoints,
 * then at most one close, then at most one bounded late observation. Records must be typed, bounded,
 * uniquely sequenced and consistent with their start; anything else invalidates the invocation so
 * every consumer masks legacy derivation instead of guessing a prefix.
 */
export function reduceReplyJournal(entries: readonly AgentEntry[]): ReducedReplyJournal {
  const journals = new Map<string, ResolvedReplyJournal>();
  const invalid = new Set<string>();
  const entryIds = new Set<string>();
  const byEntryId = new Map<string, string>();
  const perInvocation = new Map<string, ReplyDeliveryProofData[]>();

  for (const entry of entries) {
    if (entry.type !== "message" || !isReplyDeliveryProof(entry.data)) continue;
    entryIds.add(entry.id);
    const data: unknown = entry.data.data;
    if (!isRecord(data)) continue;
    const invocationId = requiredString(data.invocationId);
    if (!invocationId) continue;
    if (data.version !== REPLY_RECEIPT_VERSION) invalid.add(invocationId);
    const priorOwner = byEntryId.get(entry.id);
    if (priorOwner) {
      invalid.add(priorOwner);
      invalid.add(invocationId);
    }
    byEntryId.set(entry.id, invocationId);
    perInvocation.set(invocationId, [...(perInvocation.get(invocationId) ?? []), data as unknown as ReplyDeliveryProofData]);
  }

  for (const [invocationId, records] of perInvocation) {
    const reduced = reduceInvocation(records);
    if (!reduced) {
      invalid.add(invocationId);
      continue;
    }
    journals.set(invocationId, {
      ...reduced,
      entryIds: [...byEntryId].filter(([, id]) => id === invocationId).map(([entryId]) => entryId),
    });
  }

  const byCall = new Map<string, string>();
  const byPhase = new Map<string, string>();
  for (const [id, journal] of journals) {
    for (const [owners, key] of [
      [byCall, journal.toolCallId],
      [byPhase, journal.phaseId],
    ] as const) {
      const previous = owners.get(key);
      if (previous) {
        invalid.add(previous);
        invalid.add(id);
      }
      owners.set(key, id);
    }
  }
  for (const invocationId of invalid) journals.delete(invocationId);
  return { journals, invalid, entryIds, byEntryId };
}

/**
 * Canonical source grouping: SDK call/result, journal records of the same invocation and any late
 * observation form one indivisible source unit. Consumers use this instead of per-entry origins.
 */
export function replyJournalSourceGroups(entries: readonly AgentEntry[]): ReadonlyMap<string, readonly string[]> {
  // Group identity is deliberately independent of successful reduction. Unknown/malformed records
  // and mirrors participate too, otherwise an edit outside a page could leave its cursor valid.
  // Shared SDK entries can carry several calls; union transitively rather than overwrite a group.
  const parents = entries.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) index = parents[index]!;
    return index;
  };
  const identities = new Map<string, number>();
  const link = (key: string, index: number) => {
    const previous = identities.get(key);
    if (previous === undefined) identities.set(key, index);
    else parents[find(index)] = find(previous);
  };
  const modernCalls = new Set<string>();
  entries.forEach((entry, index) => {
    if (entry.type !== "message") return;
    if (isReplyDeliveryProof(entry.data)) {
      const data: unknown = entry.data.data;
      if (!isRecord(data)) return;
      const invocationId = requiredString(data.invocationId);
      const callId = requiredString(data.toolCallId);
      if (invocationId) link(`invocation:${invocationId}`, index);
      if (callId) {
        modernCalls.add(callId);
        link(`call:${callId}`, index);
      }
      return;
    }
    if ((entry.data.role !== "assistant" && entry.data.role !== "tool") || !Array.isArray(entry.data.content)) return;
    for (const part of entry.data.content) {
      if ((part.type !== "tool-call" && part.type !== "tool-result") || part.toolName !== "send_message") continue;
      const value = part.type === "tool-result" ? replyToolValue(part.output) : undefined;
      if (part.type === "tool-call" ? isRecord(part.input) && ("parts" in part.input || "reply_id" in part.input) : hasReplyReceiptMarker(value)) {
        modernCalls.add(part.toolCallId);
        link(`call:${part.toolCallId}`, index);
      }
      if (isRecord(value) && isRecord(value.replyReceipt)) {
        const invocationId = requiredString(value.replyReceipt.proofInvocationId);
        if (invocationId) link(`invocation:${invocationId}`, index);
      }
    }
  });
  entries.forEach((entry, index) => {
    if (entry.type !== "message" || (entry.data.role !== "assistant" && entry.data.role !== "tool") || !Array.isArray(entry.data.content)) return;
    for (const part of entry.data.content)
      if ((part.type === "tool-call" || part.type === "tool-result") && modernCalls.has(part.toolCallId)) link(`call:${part.toolCallId}`, index);
  });
  const grouped = new Map<number, string[]>();
  for (const index of identities.values()) grouped.set(find(index), []);
  entries.forEach((entry, index) => {
    const group = grouped.get(find(index));
    if (group && !group.includes(entry.id)) group.push(entry.id);
  });
  const result = new Map<string, readonly string[]>();
  for (const group of grouped.values()) for (const id of group) result.set(id, group);
  return result;
}

/** Resolve whole canonical invocations before selecting a range, page, archive or frozen source. */
export function replySourceEntryIds(entries: readonly AgentEntry[], ids: Iterable<string>, proof = resolveReplyHistory(entries)): string[] {
  const wanted = new Set([...ids].flatMap((id) => proof.groups.get(id) ?? [id]));
  return entries.filter((entry) => wanted.has(entry.id)).map((entry) => entry.id);
}

/** Request grouping sees modern delivery as journal-owned, not an unresolved legacy tool pair. */
export function replyHistoryContent(entry: AgentEntry, maskedCalls: ReadonlySet<string>): unknown {
  if (entry.type !== "message" || !("content" in entry.data)) return [];
  const content = entry.data.content;
  return Array.isArray(content)
    ? content.filter(
        (part) => (part.type !== "tool-call" && part.type !== "tool-result") || part.toolName !== "send_message" || !maskedCalls.has(part.toolCallId),
      )
    : content;
}

/** SDK wrappers are decoded here, never independently by each history surface. */
export function replyToolValue(output: unknown): unknown {
  const raw = isRecord(output) && "value" in output ? output.value : output;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Canonical journal plus an optional anchored SDK mirror. No arguments become public proof. */
export function resolveReplyHistory(entries: readonly AgentEntry[]): ReplyHistoryProof {
  const reduced = reduceReplyJournal(entries);
  const maskedCalls = new Set<string>();
  const invalidCalls = new Set<string>();
  const mirrors = new Map<string, Array<{ value: unknown; index: number }>>();
  const calls = new Map<string, number[]>();
  const groups = replyJournalSourceGroups(entries);
  const journalByCall = new Map<string, ResolvedReplyJournal>();
  for (const entry of entries) {
    if (entry.type !== "message" || !isReplyDeliveryProof(entry.data)) continue;
    const data: unknown = entry.data.data;
    if (!isRecord(data) || typeof data.toolCallId !== "string") continue;
    maskedCalls.add(data.toolCallId);
    if (typeof data.invocationId !== "string" || !reduced.journals.has(data.invocationId)) invalidCalls.add(data.toolCallId);
  }
  for (const journal of reduced.journals.values()) {
    maskedCalls.add(journal.toolCallId);
    journalByCall.set(journal.toolCallId, journal);
  }
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "message" || (entry.data.role !== "assistant" && entry.data.role !== "tool") || !Array.isArray(entry.data.content)) continue;
    for (const part of entry.data.content) {
      if (part.type !== "tool-call" && part.type !== "tool-result") continue;
      if (part.type === "tool-call") {
        calls.set(part.toolCallId, [...(calls.get(part.toolCallId) ?? []), index]);
        if (part.toolName !== "send_message" || entry.data.role !== "assistant") {
          invalidCalls.add(part.toolCallId);
          continue;
        }
        if (isRecord(part.input) && ("parts" in part.input || "reply_id" in part.input)) maskedCalls.add(part.toolCallId);
      } else {
        if (part.toolName !== "send_message" || entry.data.role !== "tool") {
          invalidCalls.add(part.toolCallId);
          continue;
        }
        const value = replyToolValue(part.output);
        if (!hasReplyReceiptMarker(value)) continue;
        maskedCalls.add(part.toolCallId);
        mirrors.set(part.toolCallId, [...(mirrors.get(part.toolCallId) ?? []), { value, index }]);
      }
    }
  }
  for (const [callId, candidates] of mirrors) {
    const callPositions = calls.get(callId);
    const mirror = candidates[0]!;
    const receipt = isRecord(mirror.value) ? decodeReplyReceipt(mirror.value.replyReceipt) : undefined;
    const journal = journalByCall.get(callId);
    if (candidates.length !== 1 || callPositions?.length !== 1 || callPositions[0]! >= mirror.index || !receipt) {
      invalidCalls.add(callId);
      continue;
    }
    if (!journal) {
      if (receipt.completeUnits.length || receipt.proofInvocationId) invalidCalls.add(callId);
      continue;
    }
    const anchored = receipt.proofSequence === undefined ? undefined : journal.snapshots.get(receipt.proofSequence);
    const unanchored = { ...receipt, proofInvocationId: undefined, proofSequence: undefined };
    if (receipt.proofInvocationId !== journal.invocationId || !anchored || JSON.stringify(unanchored) !== JSON.stringify(decodeReplyReceipt(anchored)))
      invalidCalls.add(callId);
  }
  const records = new Map<string, readonly CompressionRecord[]>();
  const journals = new Map<string, ResolvedReplyJournal>();
  for (const journal of reduced.journals.values()) {
    if ((calls.get(journal.toolCallId)?.length ?? 0) > 1 || invalidCalls.has(journal.toolCallId)) continue;
    const publicRecords = replyJournalRecords(journal);
    const ownerId = journal.entryIds[0]!;
    journals.set(ownerId, journal);
    if (publicRecords.length) records.set(ownerId, publicRecords);
  }
  return { records, groups, maskedCalls, journalEntryIds: reduced.entryIds, journals };
}

/** Current-turn journal metadata is not historical source or provider-visible speech. */
export function excludeCurrentReplyJournal(entries: readonly AgentEntry[], turnId?: string): AgentEntry[] {
  return entries.filter((entry) => {
    if (entry.type !== "message" || !isReplyDeliveryProof(entry.data)) return true;
    const data: unknown = entry.data.data;
    return turnId === undefined || !isRecord(data) || data.turnId !== turnId;
  });
}

/** Public records for one proved journal; a sticker yields only a neutral identity marker. */
export function replyJournalRecords(record: ResolvedReplyJournal): CompressionRecord[] {
  const entryId = record.entryIds[0];
  if (!entryId) return [];
  return record.units.flatMap((unit, position) =>
    unit.kind === "text"
      ? [
          {
            entryId,
            timestamp: record.unitTimestamps[position] ?? 0,
            role: "assistant" as const,
            speaker: "assistant (already delivered)",
            text: unit.text,
          },
        ]
      : [
          {
            entryId,
            timestamp: record.unitTimestamps[position] ?? 0,
            role: "assistant" as const,
            speaker: "assistant (already delivered)",
            text: `[已发送表情包 ${unit.stickerId}]`,
          },
        ],
  );
}

/** Required: one bounded nonempty ID list. Absent or malformed both return undefined here. */
export function replyPlatformIds(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= REPLY_MAX_SEGMENT_IDS &&
    value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 512 && !/\s/.test(id) && !hasControlCharacters(id)) &&
    new Set(value).size === value.length
    ? ([...value] as string[])
    : undefined;
}

/** Sticker identities also become neutral history markers; reject control-character injection. */
export function replyStickerId(value: unknown): string | undefined {
  return requiredString(value);
}

function reduceInvocation(records: readonly ReplyDeliveryProofData[]): Omit<ResolvedReplyJournal, "entryIds"> | undefined {
  const start = records[0];
  if (!start || start.kind !== "start" || start.version !== 1 || !validStart(start) || records.length > 67) return undefined;
  const observedAt: number[] = [];
  const unitTimestamps: number[] = [];
  const seenIds = new Set<string>();
  const units: ReplyUnitProof[] = [];
  const snapshots = new Map<number, ReplyReceipt>([
    [
      0,
      {
        version: 1,
        phaseId: start.phaseId,
        totalUnits: start.expectedUnits.length,
        status: "failed",
        completeUnits: [],
        failureStage: "delivery",
        failedUnitIndex: 0,
      },
    ],
  ]);
  let latestTimestamp = start.timestamp;
  let publicBytes = 0;
  let segments: string[][] = [];
  let close: ReplyDeliveryClose | undefined;
  let sawLate = false;
  let sequence = 0;
  for (const record of records.slice(1)) {
    if (
      record.version !== 1 ||
      record.invocationId !== start.invocationId ||
      record.turnId !== start.turnId ||
      !isCount(record.timestamp) ||
      !validJournalKeys(record)
    )
      return undefined;
    if (record.timestamp < latestTimestamp || record.kind === "start" || !isCount(record.sequence) || record.sequence !== sequence + 1) return undefined;
    latestTimestamp = record.timestamp;
    sequence = record.sequence;
    if (record.kind === "close") {
      if (close || sawLate) return undefined;
      const receipt: ReplyReceipt = {
        version: 1,
        phaseId: start.phaseId,
        totalUnits: start.expectedUnits.length,
        status: record.status,
        completeUnits: [...units],
        ...(record.failureStage === undefined ? {} : { failureStage: record.failureStage }),
        ...(record.failedUnitIndex === undefined ? {} : { failedUnitIndex: record.failedUnitIndex }),
        ...(record.uncertainTransport === undefined ? {} : { uncertainTransport: record.uncertainTransport }),
        ...(segments.length ? { incompleteSegmentIds: segments.flat() } : {}),
      };
      if (!decodeReplyReceipt(receipt)) return undefined;
      if (record.uncertainTransport && start.expectedUnits[units.length]?.kind !== record.uncertainTransport) return undefined;
      snapshots.set(sequence, receipt);
      close = record;
      continue;
    }
    if (record.kind !== "checkpoint" && record.kind !== "late") return undefined;
    if (record.kind === "late") {
      if (!close || close.status !== "failed" || !close.uncertainTransport || sawLate || record.unitIndex !== close.failedUnitIndex) return undefined;
      sawLate = true;
    } else if (close) return undefined;
    const expectedUnit = start.expectedUnits[units.length];
    if (!expectedUnit || record.unitIndex !== units.length || record.unitKind !== expectedUnit.kind || record.segmentIndex !== segments.length)
      return undefined;
    const ids = requiredIds(record.messageIds);
    if (!ids || ids.some((id) => seenIds.has(id)) || new Set(ids).size !== ids.length || segments.length >= expectedUnit.segments) return undefined;
    for (const id of ids) seenIds.add(id);
    segments.push(ids);
    observedAt.push(record.timestamp);
    const last = segments.length === expectedUnit.segments;
    if (!last && (record.unitText !== undefined || record.stickerId !== undefined || record.contentHash !== undefined)) return undefined;
    if (last) {
      if (record.unitKind === "text") {
        if (
          typeof record.unitText !== "string" ||
          !record.unitText.trim() ||
          Buffer.byteLength(record.unitText, "utf8") > REPLY_MAX_UNIT_TEXT_BYTES ||
          record.stickerId !== undefined ||
          record.contentHash !== undefined
        )
          return undefined;
        publicBytes += Buffer.byteLength(record.unitText, "utf8");
        if (publicBytes > REPLY_MAX_PHASE_BYTES) return undefined;
        units.push({ index: units.length, kind: "text", text: record.unitText, segmentMessageIds: segments });
      } else {
        if (record.unitText !== undefined || !requiredString(record.stickerId) || !validContentHash(record.contentHash)) return undefined;
        units.push({ index: units.length, kind: "sticker", stickerId: record.stickerId!, contentHash: record.contentHash!, messageIds: ids });
      }
      unitTimestamps.push(record.timestamp);
      segments = [];
    }
    snapshots.set(sequence, {
      version: 1,
      phaseId: start.phaseId,
      totalUnits: start.expectedUnits.length,
      status: "failed",
      completeUnits: [...units],
      failureStage: "delivery",
      failedUnitIndex: units.length,
      ...(segments.length ? { incompleteSegmentIds: segments.flat() } : {}),
    });
  }
  return {
    invocationId: start.invocationId,
    phaseId: start.phaseId,
    toolCallId: start.toolCallId,
    turnId: start.turnId,
    channelId: start.channelId,
    sessionId: start.sessionId,
    generation: start.generation,
    units,
    status: close?.status ?? "open",
    observedAt,
    unitTimestamps,
    effects: segments.flat(),
    snapshots,
    ...(close?.failureStage ? { failureStage: close.failureStage } : {}),
    ...(close?.failedUnitIndex === undefined ? {} : { failedUnitIndex: units.length }),
    ...(close?.uncertainTransport && !sawLate ? { uncertainTransport: close.uncertainTransport } : {}),
  };
}

function optionalIds(value: unknown): string[] | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  return requiredIds(value) ?? INVALID;
}

function optionalNonEmptyString(value: unknown): string | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  return requiredString(value) ?? INVALID;
}

function optionalCount(value: unknown): number | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  return isCount(value) ? value : INVALID;
}

function decodeUnitProof(value: unknown): ReplyUnitProof | undefined {
  if (!isRecord(value) || !isCount(value.index)) return undefined;
  if (value.kind === "text") {
    if (!onlyKeys(value, ["index", "kind", "text", "segmentMessageIds"])) return undefined;
    if (typeof value.text !== "string" || !value.text.trim() || Buffer.byteLength(value.text, "utf8") > REPLY_MAX_UNIT_TEXT_BYTES) return undefined;
    if (!Array.isArray(value.segmentMessageIds) || value.segmentMessageIds.length === 0 || value.segmentMessageIds.length > REPLY_MAX_SEGMENTS_PER_UNIT)
      return undefined;
    const segments: string[][] = [];
    for (const segment of value.segmentMessageIds) {
      const ids = requiredIds(segment);
      if (!ids) return undefined;
      segments.push(ids);
    }
    return { index: value.index, kind: "text", text: value.text, segmentMessageIds: segments };
  }
  if (value.kind === "sticker") {
    if (!onlyKeys(value, ["index", "kind", "stickerId", "contentHash", "messageIds"])) return undefined;
    const stickerId = requiredString(value.stickerId);
    const contentHash = requiredString(value.contentHash);
    const messageIds = requiredIds(value.messageIds);
    if (!stickerId || !validContentHash(contentHash) || !messageIds) return undefined;
    return { index: value.index, kind: "sticker", stickerId, contentHash, messageIds };
  }
  return undefined;
}

function validContentHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function onlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function validJournalKeys(record: ReplyDeliveryProofData): boolean {
  const common = ["version", "kind", "invocationId", "turnId", "timestamp"];
  if (record.kind === "start")
    return onlyKeys(record, [...common, "phaseId", "toolCallId", "channelId", "sessionId", "generation", "inputFingerprint", "expectedUnits"]);
  if (record.kind === "close") return onlyKeys(record, [...common, "sequence", "status", "failureStage", "failedUnitIndex", "uncertainTransport"]);
  return onlyKeys(record, [...common, "sequence", "unitIndex", "unitKind", "segmentIndex", "messageIds", "unitText", "stickerId", "contentHash"]);
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !hasControlCharacters(value) ? value : undefined;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function validStart(start: ReplyDeliveryStart): boolean {
  if (!validJournalKeys(start) || !requiredString(start.invocationId)) return false;
  if (!requiredString(start.phaseId) || !requiredString(start.toolCallId) || !requiredString(start.turnId)) return false;
  if (!requiredString(start.channelId) || !requiredString(start.sessionId) || !requiredString(start.inputFingerprint)) return false;
  if (!isCount(start.generation) || !isCount(start.timestamp)) return false;
  if (!Array.isArray(start.expectedUnits) || start.expectedUnits.length === 0 || start.expectedUnits.length > REPLY_MAX_UNITS) return false;
  let textUnits = 0;
  let stickers = 0;
  let segmentCount = 0;
  for (const unit of start.expectedUnits) {
    if (!isRecord(unit) || !onlyKeys(unit, ["kind", "segments"]) || (unit.kind !== "text" && unit.kind !== "sticker")) return false;
    if (!isCount(unit.segments) || unit.segments < 1 || unit.segments > REPLY_MAX_SEGMENTS_PER_UNIT) return false;
    if (unit.kind === "text") textUnits += 1;
    else if (unit.segments !== 1) return false;
    else stickers += 1;
    segmentCount += unit.segments;
  }
  return segmentCount <= 64 && textUnits <= REPLY_MAX_TEXT_UNITS && stickers <= REPLY_MAX_STICKERS;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
