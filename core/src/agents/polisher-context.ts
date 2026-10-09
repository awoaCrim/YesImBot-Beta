import type { AgentMessage } from "@yesimbot/agent-runtime";

import { formatElements, isMessage } from "../messages/index.js";
import type { PolisherTurnEntry } from "./polisher.js";

const POLISHER_CONTEXT_MAX_ENTRIES = 16;
const POLISHER_CONTEXT_MAX_ENTRY_CHARS = 4_000;
const POLISHER_CONTEXT_MAX_TOTAL_CHARS = 16_000;
const POLISHER_CONTEXT_MAX_DEPTH = 6;
const POLISHER_CONTEXT_MAX_CHILDREN = 32;
const POLISHER_CONTEXT_OMITTED = "[内容已省略]";
const POLISHER_IMAGE_OMITTED = "[图片输出已省略]";
const DROPPED_CONTEXT_KEYS = new Set([
  "abortsignal",
  "args",
  "base64",
  "buffer",
  "bytes",
  "channel",
  "continue",
  "data",
  "finishreason",
  "facts",
  "innerthought",
  "input",
  "mode",
  "messages",
  "provideroptions",
  "reason",
  "signal",
  "toolcallid",
  "toolname",
]);

/**
 * Projects only safe current-turn material for the independent polisher. Assistant messages are
 * deliberately ignored, so tool-call inputs and the main Agent's hidden reasoning cannot cross the
 * Core/polisher boundary.
 */
export function buildPolisherTurnContext(messages: readonly AgentMessage[], options: { readonly replyLayout?: boolean } = {}): readonly PolisherTurnEntry[] {
  const entries: PolisherTurnEntry[] = [];

  for (const message of messages) {
    const userContent = extractUserContext(message);
    if (userContent) entries.push({ kind: "user", content: userContent });

    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content as readonly unknown[]) {
      if (!isRecord(part) || part.type !== "tool-result") continue;
      const toolName = asString(part.toolName) ?? "unknown";
      if (
        toolName === "send_message" ||
        toolName === "prepare_reply" ||
        (options.replyLayout && (toolName === "sticker_send" || toolName === "sticker_preview"))
      )
        continue;
      const output = part.output;
      if (isImageOutput(toolName, output)) continue;
      const content = serializeToolOutput(output);
      if (content) entries.push({ kind: "tool-result", toolName: truncateText(toolName, 120), content });
    }
  }

  return boundTurnContext(entries);
}

function extractUserContext(message: AgentMessage): string | undefined {
  if (isMessage(message)) {
    const parts: string[] = [];
    if (message.data.quote?.elements.length) parts.push(`[引用] ${formatElements(message.data.quote.elements)}`);
    parts.push(formatElements(message.data.elements));
    return sanitizeContextText(parts.filter((part) => part.trim().length > 0).join("\n"));
  }

  if (message.role === "user") return extractUserContent(message.content);

  // Runtime events are current-turn input rather than historical conversation. Keep only their
  // visible text and never copy the surrounding event/control object.
  if (message.role === "custom" && message.type === "yesimbot.event" && isRecord(message.data)) {
    const text = asString(message.data.text);
    return text ? sanitizeContextText(`[运行事件] ${text}`) : undefined;
  }

  return undefined;
}

function extractUserContent(content: unknown): string | undefined {
  const parts: string[] = [];
  const values = Array.isArray(content) ? content : [content];

  for (const value of values) {
    if (typeof value === "string") {
      parts.push(value);
      continue;
    }
    if (!isRecord(value)) continue;

    const type = asString(value.type)?.toLowerCase();
    if (type === "text") {
      const text = asString(value.text);
      if (text) parts.push(text);
    } else if (type === "image") {
      parts.push("[图片]");
    } else if (type === "file" || type === "document") {
      const filename = asString(value.filename) ?? asString(value.name);
      const safeFilename = filename ? sanitizeContextText(filename) : undefined;
      parts.push(safeFilename ? `[文件：${safeFilename}]` : "[文件]");
    } else if (type === "audio") {
      parts.push("[音频]");
    } else if (type === "video") {
      parts.push("[视频]");
    }
  }

  return sanitizeContextText(parts.join(""));
}

function serializeToolOutput(value: unknown): string | undefined {
  const normalized = unwrapToolOutput(value);
  if (normalized === undefined || normalized === null) return undefined;
  const sanitized = sanitizeContextValue(normalized);
  if (sanitized === undefined) return undefined;
  const text = typeof sanitized === "string" ? sanitized : safeJson(sanitized);
  return sanitizeContextText(text);
}

function unwrapToolOutput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const type = asString(value.type);
  if (type === "json" || type === "text") return value.value;
  if (type === "content" && Array.isArray(value.value)) {
    return value.value
      .map((part) => {
        if (!isRecord(part)) return undefined;
        if (part.type === "text") return asString(part.text);
        if (part.type === "file") return "[文件]";
        if (part.type === "image-data" || part.type === "image-url") return POLISHER_IMAGE_OMITTED;
        return undefined;
      })
      .filter((part): part is string => typeof part === "string")
      .join("\n");
  }
  return value;
}

function sanitizeContextValue(value: unknown, depth = 0): unknown {
  if (depth > POLISHER_CONTEXT_MAX_DEPTH) return POLISHER_CONTEXT_OMITTED;
  if (typeof value === "string") return sanitizeContextText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value === null) return null;
  if (typeof value === "bigint") return String(value);
  if (isBinary(value)) return "[二进制已省略]";

  if (Array.isArray(value)) {
    return value.slice(0, POLISHER_CONTEXT_MAX_CHILDREN).map((item) => sanitizeContextValue(item, depth + 1));
  }
  if (!isRecord(value)) return undefined;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, POLISHER_CONTEXT_MAX_CHILDREN)) {
    if (DROPPED_CONTEXT_KEYS.has(normalizeContextKey(key))) continue;
    const next = sanitizeContextValue(child, depth + 1);
    if (next !== undefined) result[key] = next;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isImageOutput(toolName: string, value: unknown): boolean {
  const normalizedName = toolName.toLowerCase();
  if (normalizedName === "generate_image" || normalizedName === "edit_image" || normalizedName.includes("image_generation")) return true;
  if (!isRecord(value)) return containsImagePart(value);
  if (value.imageMode === "native") return true;
  return containsImagePart(value);
}

function containsImagePart(value: unknown, depth = 0): boolean {
  if (depth > POLISHER_CONTEXT_MAX_DEPTH || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => containsImagePart(item, depth + 1));
  if (!isRecord(value)) return false;

  const type = asString(value.type)?.toLowerCase();
  if (type === "image-data" || type === "image-url") return true;
  if (type === "file" && asString(value.mediaType)?.toLowerCase().startsWith("image/")) return true;
  if (asString(value.imageMode)?.toLowerCase() === "native") return true;
  return Object.values(value).some((child) => containsImagePart(child, depth + 1));
}

function boundTurnContext(entries: readonly PolisherTurnEntry[]): readonly PolisherTurnEntry[] {
  const result: PolisherTurnEntry[] = [];
  let remaining = POLISHER_CONTEXT_MAX_TOTAL_CHARS;

  for (const entry of entries.slice(0, POLISHER_CONTEXT_MAX_ENTRIES)) {
    if (remaining <= 0) break;
    const content = truncateText(entry.content, Math.min(POLISHER_CONTEXT_MAX_ENTRY_CHARS, remaining));
    if (content.length === 0) continue;
    result.push({ kind: entry.kind, content, ...(entry.toolName ? { toolName: entry.toolName } : {}) });
    remaining -= content.length;
  }

  return result;
}

function sanitizeContextText(value: string): string | undefined {
  const cleaned = value
    .replace(/<\/?(?:inner_thought|think|analysis|reason)\b[^>]*>[\s\S]*?<\/(?:inner_thought|think|analysis|reason)\s*>/gi, "")
    .replace(/<\/?(?:inner_thought|think|analysis|reason)\b[^>]*\/?\s*>/gi, "")
    .replace(/\[(?:CURRENT_MESSAGE|\/CURRENT_MESSAGE|SYSTEM_NOTIFICATION|\/SYSTEM_NOTIFICATION)\]/gi, "")
    .trim();
  return cleaned.length > 0 ? truncateText(cleaned, POLISHER_CONTEXT_MAX_ENTRY_CHARS) : undefined;
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = `\n${POLISHER_CONTEXT_OMITTED}`;
  return `${value.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function normalizeContextKey(key: string): string {
  return key.replace(/[\s_-]/g, "").toLowerCase();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBinary(value: unknown): boolean {
  return value instanceof Uint8Array || (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer);
}
