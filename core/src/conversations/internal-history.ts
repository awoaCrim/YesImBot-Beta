import { createHash } from "node:crypto";

import {
  createMessageEntry,
  type AgentAssistantMessage,
  type AgentEntry,
  type AgentPlugin,
  type AgentToolMessage,
  type AgentRequestProjection,
} from "@yesimbot/agent-runtime";

import type { HistoryProjectionMode } from "../models/index.js";
import { compactSourceTimestamp, type CompressionRecord } from "./compact.js";
import { createDeliveredTranscriptMessage, isDeliveredTranscript, type DeliveredTranscriptData } from "./delivered-transcript.js";
import { excludeCurrentReplyJournal, isReplyDeliveryProof, resolveReplyHistory } from "./reply-receipt.js";

/**
 * Internal tool arguments and historical platform output are useful in durable diagnostics but are not
 * dialogue. Keep tool calls and private control fields out of later model context while retaining a
 * typed, non-actionable transcript of successfully delivered speech.
 */
export const INTERNAL_HISTORY_PROJECTION_PLUGIN: AgentPlugin = createInternalHistoryProjectionPlugin("default");

/** The send_message tool is the only Core path that delivers model-authored text to a platform. */
const HISTORICAL_OUTPUT_TOOL_NAME = "send_message";
/** Image artifacts are ephemeral side effects; replaying their tool trace can resurrect an old image task. */
const HISTORICAL_EPHEMERAL_TOOL_NAMES = new Set(["edit_image", "generate_image", "prepare_reply"]);
/** Legacy durable records may still carry the delivered-message envelope this projection used to emit. */
const LEGACY_DELIVERED_OPEN = "[DELIVERED_MESSAGE]";
const LEGACY_DELIVERED_CLOSE = "[/DELIVERED_MESSAGE]";

interface HistoricalSendResult {
  readonly ok: boolean;
  readonly sentCount: number;
  readonly failedAt?: number;
  /** Core-recorded complete platform items; absent on legacy receipts. */
  readonly deliveredMessages?: readonly string[];
}

interface LegacyMarkerProjection {
  readonly text: string;
  readonly transcripts: readonly DeliveredTranscriptData[];
}

export function createInternalHistoryProjectionPlugin(mode: HistoryProjectionMode = "default", projection?: AgentRequestProjection): AgentPlugin {
  return {
    name: "core.internal-history-projection",
    enforce: "pre",
    transformEntries: (entries, context) => stripInternalAssistantInputs(entries, mode, projection, context?.turnId),
  };
}

export function stripInternalAssistantInputs(
  entries: readonly AgentEntry[],
  mode: HistoryProjectionMode = "default",
  projection?: AgentRequestProjection,
  turnId?: string,
): AgentEntry[] {
  entries = excludeCurrentReplyJournal(entries, turnId);
  const modern = resolveReplyHistory(entries);
  const sendResults = collectHistoricalSendResults(entries, false, modern.maskedCalls);
  const geminiSendCalls = mode === "gemini-native" ? collectSafeGeminiSendCalls(entries, sendResults) : new Map<string, readonly string[]>();
  const removedToolCallIds = new Set(
    entries.flatMap((entry) =>
      entry.type === "message" && entry.data.role === "assistant" ? removedToolCallIdsFor(entry.data.content, mode, geminiSendCalls) : [],
    ),
  );
  const projected: AgentEntry[] = [];
  const transcripts: AgentEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") {
      projected.push(entry);
      continue;
    }

    if (isReplyDeliveryProof(entry.data)) {
      const records = modern.records.get(entry.id);
      if (records?.length) {
        for (const [index, record] of records.entries()) {
          const transcript = createTranscriptEntry(
            { ...entry, timestamp: record.timestamp },
            {
              messages: [record.text],
              deliveredCount: 1,
              partial: modern.journals.get(entry.id)?.status !== "complete",
            },
            index,
          );
          if (transcript.type === "message")
            projection?.inherit(
              transcript.data,
              entries.flatMap((source) => (source.type === "message" && (modern.groups.get(entry.id) ?? [entry.id]).includes(source.id) ? [source.data] : [])),
            );
          transcripts.push(transcript);
        }
      }
      continue;
    }
    if (entry.data.role === "custom" && entry.data.type === "yesimbot.event") {
      // Runtime events are external observations, not historical user requests. Keep them durable,
      // but never offer their untrusted payload as a later model-history message.
      continue;
    }
    if (mode === "gemini-native" && isDeliveredTranscript(entry.data)) {
      // Gemini mode reconstructs safe delivered output from paired send_message history only. A
      // legacy/custom transcript has no call/result identity and must not become a duplicate turn.
      continue;
    }

    if (entry.data.role === "assistant") {
      const replacements = stripAssistantEntry(
        entry as Extract<AgentEntry, { type: "message" }> & { data: AgentAssistantMessage },
        sendResults,
        mode,
        geminiSendCalls,
      );
      for (const replacement of replacements) if (replacement.type === "message") projection?.inherit(replacement.data, [entry.data]);
      appendProjectedEntries(projected, transcripts, replacements);
      continue;
    }

    if (entry.data.role === "tool") {
      const data = stripToolContent(entry.data, removedToolCallIds, mode, geminiSendCalls);
      if (data) {
        if (data !== entry.data) projection?.inherit(data, [entry.data]);
        projected.push(data === entry.data ? entry : { ...entry, data });
      }
      continue;
    }

    projected.push(entry);
  }
  // Providers such as Gemini reject any system message that appears after non-system content. The
  // compaction summary is a system entry, and delivered transcripts are assistant history, so the
  // stable order is: every system entry, then transcripts, then the remaining dialogue in order.
  const systemEntries: AgentEntry[] = [];
  const dialogue: AgentEntry[] = [];
  for (const entry of projected) {
    if (entry.type === "message" && entry.data.role === "system") systemEntries.push(entry);
    else dialogue.push(entry);
  }
  return [...systemEntries, ...transcripts, ...dialogue];
}

/** Public-output evidence used by block loading. No internal assistant text or failed send is exposed. */
export function collectDeliveredSourceRecords(entries: readonly AgentEntry[]): ReadonlyMap<string, readonly CompressionRecord[]> {
  const results = collectHistoricalSendResults(entries, true);
  const records = new Map<string, readonly CompressionRecord[]>(resolveReplyHistory(entries).records);
  for (const entry of entries) {
    if (entry.type !== "message" || entry.data.role !== "assistant" || !Array.isArray(entry.data.content)) continue;
    const output: CompressionRecord[] = [];
    for (const part of entry.data.content) {
      if (part.type !== "tool-call" || part.toolName !== HISTORICAL_OUTPUT_TOOL_NAME) continue;
      const result = results.get(part.toolCallId);
      if (!result || result.sentCount <= 0 || (!result.ok && (result.failedAt ?? 0) <= 0)) continue;
      const messages = result.deliveredMessages ?? readHistoricalSendMessages(part.input);
      if (!messages) continue;
      // sent IDs count platform segments, not input messages. A partial receipt proves
      // only inputs strictly before failedAt; even partially sent failed input is excluded.
      const count = result.ok ? result.sentCount : result.failedAt!;
      if ((result.ok && count !== messages.length) || (!result.ok && (result.deliveredMessages ? count !== messages.length : count >= messages.length)))
        continue;
      for (const message of messages.slice(0, count)) {
        // Unbalanced control markup cannot prove where private text ends. The old
        // history projection stays unchanged; block loading fails closed for this row.
        if (/<\/?inner_thought\b/i.test(message.replace(/<inner_thought\b[^>]*>[\s\S]*?<\/inner_thought\s*>/gi, ""))) continue;
        const text = sanitizeDeliveredMessage(message);
        if (text)
          output.push({ entryId: entry.id, timestamp: compactSourceTimestamp(entry), role: "assistant", speaker: "assistant (already delivered)", text });
      }
    }
    if (output.length) records.set(entry.id, output);
  }
  return records;
}

/** Source/body/proof identity without exposing original private fields to derived prompts. */
export function collectAssistantSourceProofs(entries: readonly AgentEntry[]): ReadonlyMap<string, string> {
  const modern = resolveReplyHistory(entries);
  const receipts = new Map<string, object[]>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.data.role !== "tool" || !Array.isArray(entry.data.content)) continue;
    for (const part of entry.data.content)
      if (part.type === "tool-result" && part.toolName === HISTORICAL_OUTPUT_TOOL_NAME) {
        const list = receipts.get(part.toolCallId) ?? [];
        list.push(entry.data);
        receipts.set(part.toolCallId, list);
      }
  }
  const result = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const origins: object[] = [entry.data];
    if (entry.data.role === "assistant" && Array.isArray(entry.data.content)) {
      for (const part of entry.data.content)
        if (part.type === "tool-call" && part.toolName === HISTORICAL_OUTPUT_TOOL_NAME) origins.push(...(receipts.get(part.toolCallId) ?? []));
    }
    const group = modern.groups.get(entry.id);
    const proof = group ? entries.filter((source) => group.includes(source.id)) : origins;
    result.set(entry.id, createHash("sha256").update(JSON.stringify(proof)).digest("hex"));
  }
  return result;
}

/** Only new actual-body receipts override legacy renderers; invalid new proof masks the draft. */
export function collectActualDeliveredSourceRecords(entries: readonly AgentEntry[]): ReadonlyMap<string, readonly CompressionRecord[]> {
  const calls = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.data.role !== "tool" || !Array.isArray(entry.data.content)) continue;
    for (const part of entry.data.content) {
      if (part.type !== "tool-result" || part.toolName !== HISTORICAL_OUTPUT_TOOL_NAME) continue;
      const output: unknown = part.output;
      const value = parseJsonValue(isRecord(output) && "value" in output ? output.value : output);
      if (isRecord(value) && Object.hasOwn(value, "deliveredMessages")) calls.add(part.toolCallId);
    }
  }
  const delivered = collectDeliveredSourceRecords(entries);
  const modern = resolveReplyHistory(entries);
  const result = new Map<string, readonly CompressionRecord[]>(modern.records);
  for (const id of modern.journalEntryIds) if (!result.has(id)) result.set(id, []);
  for (const entry of entries) {
    if (
      entry.type === "message" &&
      entry.data.role === "assistant" &&
      Array.isArray(entry.data.content) &&
      entry.data.content.some((part) => part.type === "tool-call" && (calls.has(part.toolCallId) || modern.maskedCalls.has(part.toolCallId)))
    )
      result.set(entry.id, delivered.get(entry.id) ?? []);
  }
  return result;
}

export function sanitizeDeliveredMessage(value: string): string {
  return value
    .replace(/<inner_thought\b[^>]*\/?>[\s\S]*?<\/inner_thought\s*>/gi, "")
    .replace(/<inner_thought\b[^>]*\/?\s*>/gi, "")
    .replace(/<\/?img\b[^>]*>/gi, "[图片]")
    .replace(/<\/?image\b[^>]*>/gi, "[图片]")
    .replace(/<\/?file\b[^>]*>/gi, "[文件]")
    .replace(/<message\s*\/>/gi, "\n")
    .replace(/<\/?text\b[^>]*>/gi, "")
    .replace(/\b(?:artifact|asset|workspace):\/\/[^\s"'<>]+/gi, "[资源]")
    .trim();
}

function appendProjectedEntries(target: AgentEntry[], transcripts: AgentEntry[], entries: readonly AgentEntry[]): void {
  for (const entry of entries) {
    if (entry.type === "message" && isDeliveredTranscript(entry.data)) transcripts.push(entry);
    else target.push(entry);
  }
}

function stripAssistantEntry(
  entry: Extract<AgentEntry, { type: "message" }> & { data: AgentAssistantMessage },
  sendResults: ReadonlyMap<string, HistoricalSendResult>,
  mode: HistoryProjectionMode,
  geminiSendCalls: ReadonlyMap<string, readonly string[]>,
): AgentEntry[] {
  const transcripts: DeliveredTranscriptData[] = [];
  const data = stripAssistantContent(entry.data, sendResults, transcripts, mode, geminiSendCalls);
  const projected: AgentEntry[] = transcripts.map((transcript, index) => createTranscriptEntry(entry, transcript, index));
  if (data) projected.push(data === entry.data ? entry : { ...entry, data });
  return projected;
}

function createTranscriptEntry(
  source: Extract<AgentEntry, { type: "message" }>,
  data: DeliveredTranscriptData,
  index: number,
): Extract<AgentEntry, { type: "message" }> {
  const suffix = `:delivered-transcript:${index}`;
  const message = createDeliveredTranscriptMessage(
    { ...data, messages: [...data.messages] },
    { id: `${source.data.id}${suffix}`, timestamp: source.timestamp },
  );
  return createMessageEntry(message, { id: `${source.id}${suffix}`, timestamp: source.timestamp, parentId: source.parentId });
}

function stripAssistantContent(
  message: AgentAssistantMessage,
  sendResults: ReadonlyMap<string, HistoricalSendResult>,
  transcripts: DeliveredTranscriptData[],
  mode: HistoryProjectionMode,
  geminiSendCalls: ReadonlyMap<string, readonly string[]>,
): AgentAssistantMessage | null {
  if (typeof message.content === "string") {
    const legacy = extractLegacyDeliveredMarkers(message.content);
    if (!legacy) return mode === "gemini-native" && hasLegacyDeliveredMarker(message.content) ? null : message;
    if (mode === "default") transcripts.push(...legacy.transcripts);
    const text = legacy.text.trim();
    return text.length === 0 ? null : { ...message, content: text };
  }
  if (!Array.isArray(message.content)) return message;
  let changed = false;
  const content: unknown[] = [];
  for (const sourcePart of message.content as readonly unknown[]) {
    if (!isRecord(sourcePart)) {
      content.push(sourcePart);
      continue;
    }
    if (sourcePart.type === "tool-call" && sourcePart.toolName === HISTORICAL_OUTPUT_TOOL_NAME) {
      changed = true;
      const receipt = typeof sourcePart.toolCallId === "string" ? sendResults.get(sourcePart.toolCallId) : undefined;
      if (mode === "default" || receipt?.deliveredMessages !== undefined) {
        const delivered = projectDeliveredMessages(sourcePart, sendResults);
        if (delivered) transcripts.push(delivered);
        continue;
      }
      const toolCallId = typeof sourcePart.toolCallId === "string" ? sourcePart.toolCallId : undefined;
      const messages = toolCallId ? geminiSendCalls.get(toolCallId) : undefined;
      if (!messages) continue;
      const part = structuredClone(sourcePart) as Record<string, unknown>;
      if (!isRecord(part.input)) continue;
      // Compose calls contain facts/intent, not a messages draft. Do not invent arguments
      // or substitute generated dialogue into the signed historical call.
      const input = { ...part.input, ...(Array.isArray(part.input.messages) ? { messages: [...messages] } : {}) };
      removePrivateToolFields(input);
      part.input = input;
      content.push(part);
      continue;
    }
    if (sourcePart.type === "tool-call" && isHistoricalToolCall(sourcePart)) {
      changed = true;
      continue;
    }
    const part = structuredClone(sourcePart) as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      const legacy = extractLegacyDeliveredMarkers(part.text);
      if (!legacy) {
        if (mode === "gemini-native" && hasLegacyDeliveredMarker(part.text)) return null;
      } else {
        changed = true;
        if (mode === "default") transcripts.push(...legacy.transcripts);
        const text = legacy.text.trim();
        if (text.length === 0) continue;
        part.text = text;
      }
    }
    if (part.type === "tool-call" && isRecord(part.input) && removePrivateToolFields(part.input)) changed = true;
    content.push(part);
  }
  if (!changed) return message;
  return content.length === 0 ? null : { ...message, content: content as AgentAssistantMessage["content"] };
}

function stripToolContent(
  message: AgentToolMessage,
  removedToolCallIds: ReadonlySet<string>,
  mode: HistoryProjectionMode,
  geminiSendCalls: ReadonlyMap<string, readonly string[]>,
): AgentToolMessage | null {
  if (!Array.isArray(message.content)) return message;
  let changed = false;
  const content: unknown[] = [];
  for (const sourcePart of message.content as readonly unknown[]) {
    if (!isRecord(sourcePart)) {
      content.push(sourcePart);
      continue;
    }
    const toolCallId = typeof sourcePart.toolCallId === "string" ? sourcePart.toolCallId : undefined;
    const isSafeGeminiSendResult = mode === "gemini-native" && toolCallId !== undefined && geminiSendCalls.has(toolCallId);
    const removeResult =
      sourcePart.type === "tool-result" &&
      (sourcePart.toolName === HISTORICAL_OUTPUT_TOOL_NAME
        ? !isSafeGeminiSendResult
        : typeof sourcePart.toolName === "string" && HISTORICAL_EPHEMERAL_TOOL_NAMES.has(sourcePart.toolName)
          ? true
          : toolCallId !== undefined && removedToolCallIds.has(toolCallId)
            ? true
            : isSafeGeminiSendResult);
    if (removeResult) {
      changed = true;
      continue;
    }
    content.push(structuredClone(sourcePart));
  }
  if (!changed) return message;
  return content.length === 0 ? null : { ...message, content: content as AgentToolMessage["content"] };
}

function collectHistoricalSendResults(
  entries: readonly AgentEntry[],
  strict = false,
  maskedCalls = resolveReplyHistory(entries).maskedCalls,
): ReadonlyMap<string, HistoricalSendResult> {
  const calls = new Map<string, { index: number; count: number }>();
  const receiptCounts = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "message" || (entry.data.role !== "assistant" && entry.data.role !== "tool") || !Array.isArray(entry.data.content)) continue;
    for (const part of entry.data.content as readonly unknown[]) {
      if (!isRecord(part) || typeof part.toolCallId !== "string") continue;
      if (entry.data.role === "assistant" && part.type === "tool-call")
        calls.set(part.toolCallId, { index, count: (calls.get(part.toolCallId)?.count ?? 0) + 1 });
      if (entry.data.role === "tool" && part.type === "tool-result") receiptCounts.set(part.toolCallId, (receiptCounts.get(part.toolCallId) ?? 0) + 1);
    }
  }
  const results = new Map<string, HistoricalSendResult>();
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "message" || entry.data.role !== "tool" || !Array.isArray(entry.data.content)) continue;
    for (const sourcePart of entry.data.content as readonly unknown[]) {
      if (!isRecord(sourcePart) || sourcePart.type !== "tool-result" || sourcePart.toolName !== HISTORICAL_OUTPUT_TOOL_NAME) continue;
      if (typeof sourcePart.toolCallId !== "string" || maskedCalls.has(sourcePart.toolCallId)) continue;
      const result = decodeHistoricalSendResult(sourcePart, strict);
      const call = calls.get(sourcePart.toolCallId);
      // Only legacy receipts retain permissive compatibility. Actual-body receipts must have
      // unambiguous ordered proof in every history renderer, not only explicit expansion.
      const ambiguousProof =
        (strict || result.deliveredMessages !== undefined) && (call?.count !== 1 || call.index >= index || receiptCounts.get(sourcePart.toolCallId) !== 1);
      results.set(sourcePart.toolCallId, ambiguousProof ? { ok: false, sentCount: 0 } : result);
    }
  }
  return results;
}

function decodeHistoricalSendResult(part: Record<string, unknown>, strict = false): HistoricalSendResult {
  const rawOutput = part.output;
  const rawValue = isRecord(rawOutput) && "value" in rawOutput ? rawOutput.value : rawOutput;
  const value = parseJsonValue(rawValue);
  if (!isRecord(value)) return { ok: false, sentCount: 0 };
  const hasBody = Object.hasOwn(value, "deliveredMessages");
  if (strict || hasBody) {
    const ids = value.ok === true ? value.messageIds : value.sent;
    const invalidIds = ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0));
    const invalidCount = value.count !== undefined && (typeof value.count !== "number" || !Number.isSafeInteger(value.count) || value.count < 0);
    const explicitNoDelivery = Array.isArray(ids) && ids.length === 0;
    const completeCount = value.ok === true ? value.count : value.failedAt;
    const insufficientIds = !Array.isArray(ids) || (typeof completeCount === "number" && ids.length < completeCount);
    if (invalidIds || invalidCount || explicitNoDelivery || insufficientIds || (value.ok !== true && value.ok !== false)) return { ok: false, sentCount: 0 };
  }
  const deliveredMessages = value.deliveredMessages;
  if (
    hasBody &&
    (!Array.isArray(deliveredMessages) ||
      !deliveredMessages.every((text) => typeof text === "string" && text.trim().length > 0) ||
      (value.ok === true ? deliveredMessages.length !== value.count : deliveredMessages.length !== value.failedAt))
  )
    return { ok: false, sentCount: 0 };
  const body = hasBody ? { deliveredMessages: deliveredMessages as string[] } : {};
  if (value.ok === true) {
    const count = typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 0 ? value.count : undefined;
    const messageIds = Array.isArray(value.messageIds) ? value.messageIds.length : undefined;
    return { ok: true, sentCount: count ?? messageIds ?? 0, ...body };
  }
  const sentCount = Array.isArray(value.sent) ? value.sent.length : 0;
  const failedAt = typeof value.failedAt === "number" && Number.isInteger(value.failedAt) && value.failedAt >= 0 ? value.failedAt : undefined;
  return { ok: false, sentCount, ...(failedAt === undefined ? {} : { failedAt }), ...body };
}

function projectDeliveredMessages(part: Record<string, unknown>, sendResults: ReadonlyMap<string, HistoricalSendResult>): DeliveredTranscriptData | undefined {
  if (typeof part.toolCallId !== "string") return undefined;
  const result = sendResults.get(part.toolCallId);
  if (!result || (!result.ok && result.sentCount === 0)) return undefined;
  const input = result.deliveredMessages ?? (isRecord(part.input) ? part.input.messages : undefined);
  if (!Array.isArray(input)) return undefined;
  const messages = input.filter((value): value is string => typeof value === "string");
  const count = result.ok ? Math.min(result.sentCount || messages.length, messages.length) : Math.min(result.failedAt ?? 0, messages.length);
  const delivered = messages.slice(0, count).map(sanitizeDeliveredMessage).filter(Boolean);
  if (delivered.length === 0) return undefined;
  return { messages: delivered, deliveredCount: count, partial: !result.ok };
}

function collectSafeGeminiSendCalls(entries: readonly AgentEntry[], sendResults: ReadonlyMap<string, HistoricalSendResult>): Map<string, readonly string[]> {
  const calls = new Map<string, readonly string[]>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.data.role !== "assistant" || !Array.isArray(entry.data.content)) continue;
    for (const sourcePart of entry.data.content as readonly unknown[]) {
      if (!isRecord(sourcePart) || sourcePart.type !== "tool-call" || sourcePart.toolName !== HISTORICAL_OUTPUT_TOOL_NAME) continue;
      if (typeof sourcePart.toolCallId !== "string" || duplicates.has(sourcePart.toolCallId)) continue;
      if (calls.has(sourcePart.toolCallId)) {
        calls.delete(sourcePart.toolCallId);
        duplicates.add(sourcePart.toolCallId);
        continue;
      }
      const result = sendResults.get(sourcePart.toolCallId);
      const messages = readHistoricalSendMessages(sourcePart.input) ?? result?.deliveredMessages;
      // New actual-body receipts are projected as transcripts, never into signed old args.
      if (!result?.ok || result.deliveredMessages !== undefined || !messages || result.sentCount !== messages.length) continue;
      const sanitized = messages.map(sanitizeDeliveredMessage);
      if (sanitized.some((message) => message.length === 0)) continue;
      calls.set(sourcePart.toolCallId, sanitized);
    }
  }
  return calls;
}

function readHistoricalSendMessages(input: unknown): readonly string[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.messages)) return undefined;
  if (!input.messages.every((message): message is string => typeof message === "string" && message.length > 0)) return undefined;
  return input.messages;
}

function removedToolCallIdsFor(
  content: AgentAssistantMessage["content"],
  mode: HistoryProjectionMode,
  geminiSendCalls: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (!Array.isArray(content)) return [];
  return (content as readonly unknown[]).flatMap((part) => {
    if (!isRecord(part) || part.type !== "tool-call" || !isHistoricalToolCall(part)) return [];
    if (
      mode === "gemini-native" &&
      part.toolName === HISTORICAL_OUTPUT_TOOL_NAME &&
      typeof part.toolCallId === "string" &&
      geminiSendCalls.has(part.toolCallId)
    ) {
      return [];
    }
    return typeof part.toolCallId === "string" ? [part.toolCallId] : [];
  });
}

function removePrivateToolFields(input: Record<string, unknown>): boolean {
  let changed = false;
  for (const key of ["inner_thought", "reason"] as const) {
    if (!(key in input)) continue;
    delete input[key];
    changed = true;
  }
  return changed;
}

function isHistoricalToolCall(part: Record<string, unknown>): boolean {
  if (part.toolName === HISTORICAL_OUTPUT_TOOL_NAME) return true;
  if (typeof part.toolName === "string" && HISTORICAL_EPHEMERAL_TOOL_NAMES.has(part.toolName)) return true;
  if (part.toolName !== "read" || !isRecord(part.input)) return false;
  return typeof part.input.uri === "string" && part.input.uri.startsWith("artifact://");
}

function hasLegacyDeliveredMarker(text: string): boolean {
  return text.includes(LEGACY_DELIVERED_OPEN) || text.includes(LEGACY_DELIVERED_CLOSE);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Converts complete legacy delivered-message envelopes into typed transcript data without mutating
 * persisted text. Any lone, nested, or otherwise ambiguous marker fails closed and stays unchanged.
 */
function extractLegacyDeliveredMarkers(text: string): LegacyMarkerProjection | undefined {
  if (!hasLegacyDeliveredMarker(text)) return undefined;

  let result = "";
  let cursor = 0;
  let changed = false;
  const transcripts: DeliveredTranscriptData[] = [];
  while (cursor < text.length) {
    const open = text.indexOf(LEGACY_DELIVERED_OPEN, cursor);
    const closeBeforeOpen = text.indexOf(LEGACY_DELIVERED_CLOSE, cursor);
    if (closeBeforeOpen !== -1 && (open === -1 || closeBeforeOpen < open)) return undefined;
    if (open === -1) {
      result += text.slice(cursor);
      break;
    }

    const bodyStart = open + LEGACY_DELIVERED_OPEN.length;
    const close = text.indexOf(LEGACY_DELIVERED_CLOSE, bodyStart);
    if (close === -1) return undefined;
    const nested = text.indexOf(LEGACY_DELIVERED_OPEN, bodyStart);
    if (nested !== -1 && nested < close) return undefined;

    result += text.slice(cursor, open);
    const body = sanitizeDeliveredMessage(text.slice(bodyStart, close));
    if (body.length > 0) transcripts.push({ messages: [body], deliveredCount: 1, partial: false });
    cursor = close + LEGACY_DELIVERED_CLOSE.length;
    changed = true;
  }

  if (!changed) return undefined;
  if (result.includes(LEGACY_DELIVERED_OPEN) || result.includes(LEGACY_DELIVERED_CLOSE)) return undefined;
  return { text: result, transcripts };
}
