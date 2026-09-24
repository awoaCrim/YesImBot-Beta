import { createMessageEntry, type AgentAssistantMessage, type AgentEntry, type AgentPlugin, type AgentToolMessage } from "@yesimbot/agent-runtime";

import { createDeliveredTranscriptMessage, isDeliveredTranscript, type DeliveredTranscriptData } from "./delivered-transcript.js";

/**
 * Internal tool arguments and historical platform output are useful in durable diagnostics but are not
 * dialogue. Keep tool calls and private control fields out of later model context while retaining a
 * typed, non-actionable transcript of successfully delivered speech.
 */
export const INTERNAL_HISTORY_PROJECTION_PLUGIN: AgentPlugin = {
  name: "core.internal-history-projection",
  enforce: "pre",
  transformEntries: stripInternalAssistantInputs,
};

/** The send_message tool is the only Core path that delivers model-authored text to a platform. */
const HISTORICAL_OUTPUT_TOOL_NAME = "send_message";
/** Image artifacts are ephemeral side effects; replaying their tool trace can resurrect an old image task. */
const HISTORICAL_EPHEMERAL_TOOL_NAMES = new Set(["edit_image", "generate_image"]);
/** Legacy durable records may still carry the delivered-message envelope this projection used to emit. */
const LEGACY_DELIVERED_OPEN = "[DELIVERED_MESSAGE]";
const LEGACY_DELIVERED_CLOSE = "[/DELIVERED_MESSAGE]";

interface HistoricalSendResult {
  readonly ok: boolean;
  readonly sentCount: number;
  readonly failedAt?: number;
}

interface LegacyMarkerProjection {
  readonly text: string;
  readonly transcripts: readonly DeliveredTranscriptData[];
}

export function stripInternalAssistantInputs(entries: readonly AgentEntry[]): AgentEntry[] {
  const sendResults = collectHistoricalSendResults(entries);
  const removedToolCallIds = new Set(
    entries.flatMap((entry) => (entry.type === "message" && entry.data.role === "assistant" ? removedToolCallIdsFor(entry.data.content) : [])),
  );
  const projected: AgentEntry[] = [];
  const transcripts: AgentEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") {
      projected.push(entry);
      continue;
    }

    if (entry.data.role === "custom" && entry.data.type === "yesimbot.event") {
      // Runtime events are external observations, not historical user requests. Keep them durable,
      // but never offer their untrusted payload as a later model-history message.
      continue;
    }

    if (entry.data.role === "assistant") {
      appendProjectedEntries(
        projected,
        transcripts,
        stripAssistantEntry(entry as Extract<AgentEntry, { type: "message" }> & { data: AgentAssistantMessage }, sendResults),
      );
      continue;
    }

    if (entry.data.role === "tool") {
      const data = stripToolContent(entry.data, removedToolCallIds);
      if (data) projected.push(data === entry.data ? entry : { ...entry, data });
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

function appendProjectedEntries(target: AgentEntry[], transcripts: AgentEntry[], entries: readonly AgentEntry[]): void {
  for (const entry of entries) {
    if (entry.type === "message" && isDeliveredTranscript(entry.data)) transcripts.push(entry);
    else target.push(entry);
  }
}

function stripAssistantEntry(
  entry: Extract<AgentEntry, { type: "message" }> & { data: AgentAssistantMessage },
  sendResults: ReadonlyMap<string, HistoricalSendResult>,
): AgentEntry[] {
  const transcripts: DeliveredTranscriptData[] = [];
  const data = stripAssistantContent(entry.data, sendResults, transcripts);
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
): AgentAssistantMessage | null {
  if (typeof message.content === "string") {
    const legacy = extractLegacyDeliveredMarkers(message.content);
    if (!legacy) return message;
    transcripts.push(...legacy.transcripts);
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
      const delivered = projectDeliveredMessages(sourcePart, sendResults);
      if (delivered) transcripts.push(delivered);
      continue;
    }
    if (sourcePart.type === "tool-call" && isHistoricalToolCall(sourcePart)) {
      changed = true;
      continue;
    }
    const part = structuredClone(sourcePart) as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      const legacy = extractLegacyDeliveredMarkers(part.text);
      if (legacy) {
        changed = true;
        transcripts.push(...legacy.transcripts);
        const text = legacy.text.trim();
        if (text.length === 0) continue;
        part.text = text;
      }
    }
    if (part.type === "tool-call" && isRecord(part.input)) {
      for (const key of ["inner_thought", "reason"] as const) {
        if (!(key in part.input)) continue;
        delete part.input[key];
        changed = true;
      }
    }
    content.push(part);
  }
  if (!changed) return message;
  return content.length === 0 ? null : { ...message, content: content as AgentAssistantMessage["content"] };
}

function stripToolContent(message: AgentToolMessage, removedToolCallIds: ReadonlySet<string>): AgentToolMessage | null {
  if (!Array.isArray(message.content)) return message;
  let changed = false;
  const content: unknown[] = [];
  for (const sourcePart of message.content as readonly unknown[]) {
    if (!isRecord(sourcePart)) {
      content.push(sourcePart);
      continue;
    }
    if (
      sourcePart.type === "tool-result" &&
      (sourcePart.toolName === HISTORICAL_OUTPUT_TOOL_NAME ||
        (typeof sourcePart.toolName === "string" && HISTORICAL_EPHEMERAL_TOOL_NAMES.has(sourcePart.toolName)) ||
        (typeof sourcePart.toolCallId === "string" && removedToolCallIds.has(sourcePart.toolCallId)))
    ) {
      changed = true;
      continue;
    }
    content.push(structuredClone(sourcePart));
  }
  if (!changed) return message;
  return content.length === 0 ? null : { ...message, content: content as AgentToolMessage["content"] };
}

function collectHistoricalSendResults(entries: readonly AgentEntry[]): ReadonlyMap<string, HistoricalSendResult> {
  const results = new Map<string, HistoricalSendResult>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.data.role !== "tool" || !Array.isArray(entry.data.content)) continue;
    for (const sourcePart of entry.data.content as readonly unknown[]) {
      if (!isRecord(sourcePart) || sourcePart.type !== "tool-result" || sourcePart.toolName !== HISTORICAL_OUTPUT_TOOL_NAME) continue;
      if (typeof sourcePart.toolCallId !== "string") continue;
      results.set(sourcePart.toolCallId, decodeHistoricalSendResult(sourcePart));
    }
  }
  return results;
}

function decodeHistoricalSendResult(part: Record<string, unknown>): HistoricalSendResult {
  const rawOutput = part.output;
  const rawValue = isRecord(rawOutput) && "value" in rawOutput ? rawOutput.value : rawOutput;
  const value = parseJsonValue(rawValue);
  if (!isRecord(value)) return { ok: false, sentCount: 0 };
  if (value.ok === true) {
    const count = typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 0 ? value.count : undefined;
    const messageIds = Array.isArray(value.messageIds) ? value.messageIds.length : undefined;
    return { ok: true, sentCount: count ?? messageIds ?? 0 };
  }
  const sentCount = Array.isArray(value.sent) ? value.sent.length : 0;
  const failedAt = typeof value.failedAt === "number" && Number.isInteger(value.failedAt) && value.failedAt >= 0 ? value.failedAt : undefined;
  return { ok: false, sentCount, ...(failedAt === undefined ? {} : { failedAt }) };
}

function projectDeliveredMessages(part: Record<string, unknown>, sendResults: ReadonlyMap<string, HistoricalSendResult>): DeliveredTranscriptData | undefined {
  if (typeof part.toolCallId !== "string") return undefined;
  const result = sendResults.get(part.toolCallId);
  if (!result || (!result.ok && result.sentCount === 0)) return undefined;
  const input = isRecord(part.input) ? part.input.messages : undefined;
  if (!Array.isArray(input)) return undefined;
  const messages = input.filter((value): value is string => typeof value === "string");
  const count = result.ok ? Math.min(result.sentCount || messages.length, messages.length) : Math.min(result.failedAt ?? 0, messages.length);
  const delivered = messages.slice(0, count).map(sanitizeDeliveredMessage).filter(Boolean);
  if (delivered.length === 0) return undefined;
  return { messages: delivered, deliveredCount: count, partial: !result.ok };
}

function sanitizeDeliveredMessage(value: string): string {
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

function removedToolCallIdsFor(content: AgentAssistantMessage["content"]): string[] {
  if (!Array.isArray(content)) return [];
  return (content as readonly unknown[]).flatMap((part) => {
    if (!isRecord(part) || part.type !== "tool-call" || !isHistoricalToolCall(part)) return [];
    return typeof part.toolCallId === "string" ? [part.toolCallId] : [];
  });
}

function isHistoricalToolCall(part: Record<string, unknown>): boolean {
  if (part.toolName === HISTORICAL_OUTPUT_TOOL_NAME) return true;
  if (typeof part.toolName === "string" && HISTORICAL_EPHEMERAL_TOOL_NAMES.has(part.toolName)) return true;
  if (part.toolName !== "read" || !isRecord(part.input)) return false;
  return typeof part.input.uri === "string" && part.input.uri.startsWith("artifact://");
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
  if (!text.includes(LEGACY_DELIVERED_OPEN) && !text.includes(LEGACY_DELIVERED_CLOSE)) return undefined;

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
