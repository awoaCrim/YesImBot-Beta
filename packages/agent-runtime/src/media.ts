import type { AgentEntry } from "./entry.js";
import type { AgentMessage } from "./message.js";

const IMAGE_PAYLOAD_REMOVED = "image_payload_removed";
const DATA_IMAGE_URL = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;

/**
 * Produces the durable/history-safe representation of entries without mutating the live turn.
 * Structured image payloads are deliberately ephemeral: stable metadata and tool pairing remain.
 */
export function sanitizeAgentEntriesForPersistence(entries: readonly AgentEntry[]): AgentEntry[] {
  return entries.map((entry) =>
    entry.type === "message"
      ? {
          ...entry,
          data: sanitizeAgentMessageForPersistence(entry.data),
        }
      : structuredClone(entry),
  );
}

export function sanitizeAgentMessageForPersistence(message: AgentMessage): AgentMessage {
  const cloned = structuredClone(message) as AgentMessage;
  if (cloned.role === "custom" || cloned.role === "system") return cloned;

  if (cloned.role === "tool") {
    cloned.content = cloned.content.map((part) => sanitizeToolContentPart(part)) as typeof cloned.content;
    return cloned;
  }

  if (Array.isArray(cloned.content)) {
    cloned.content = sanitizeContentParts(cloned.content) as typeof cloned.content;
  } else if (typeof cloned.content === "string") {
    cloned.content = sanitizeText(cloned.content) as typeof cloned.content;
  }
  if ("providerOptions" in cloned && cloned.providerOptions !== undefined) {
    cloned.providerOptions = sanitizeUnknown(cloned.providerOptions) as typeof cloned.providerOptions;
  }
  return cloned;
}

function sanitizeToolContentPart<T>(part: T): T {
  if (!isRecord(part)) return part;
  const cloned = { ...part } as Record<string, unknown>;
  if ("output" in cloned) cloned.output = sanitizeToolOutput(cloned.output);
  if ("providerOptions" in cloned) cloned.providerOptions = sanitizeUnknown(cloned.providerOptions);
  return cloned as T;
}

function sanitizeToolOutput(output: unknown): unknown {
  if (!isRecord(output)) return sanitizeUnknown(output);
  if (output.type === "content" && Array.isArray(output.value)) {
    const value = sanitizeContentParts(output.value);
    return value.length > 0 ? { ...output, value } : removedOutput();
  }
  if ((output.type === "text" || output.type === "error-text") && typeof output.value === "string") {
    return { ...output, value: sanitizeText(output.value) };
  }
  if ("value" in output) return { ...output, value: sanitizeUnknown(output.value) };
  return sanitizeUnknown(output);
}

function sanitizeContentParts(parts: readonly unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const part of parts) {
    if (isImagePayloadPart(part)) continue;
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      result.push({ ...part, text: sanitizeText(part.text) });
      continue;
    }
    result.push(sanitizeUnknown(part));
  }
  return result;
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return value.slice();
  if (Array.isArray(value)) return sanitizeContentParts(value);
  if (isImagePayloadPart(value)) return { error: IMAGE_PAYLOAD_REMOVED };

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const imageContainer = isImageContainer(record);
  for (const [key, item] of Object.entries(record)) {
    if (imageContainer && key === "data") continue;
    if ((key === "url" || key === "image_url" || key === "imageUrl") && typeof item === "string" && item.startsWith("data:image/")) {
      result[key] = `[${IMAGE_PAYLOAD_REMOVED}]`;
      continue;
    }
    result[key] = sanitizeUnknown(item);
  }
  return result;
}

function isImagePayloadPart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "image-data" || value.type === "input_image") return true;
  if (value.type === "image" && ("data" in value || "image" in value || "url" in value)) return true;
  if (value.type === "file" && typeof value.mediaType === "string" && value.mediaType.startsWith("image/") && "data" in value) return true;
  if (value.type === "image_url") return true;
  if (typeof value.url === "string" && value.url.startsWith("data:image/")) return true;
  if (isRecord(value.image_url) && typeof value.image_url.url === "string" && value.image_url.url.startsWith("data:image/")) return true;
  return false;
}

function isImageContainer(value: Record<string, unknown>): boolean {
  return (
    value.type === "image-data" ||
    value.type === "image" ||
    value.type === "input_image" ||
    (value.type === "file" && typeof value.mediaType === "string" && value.mediaType.startsWith("image/"))
  );
}

function sanitizeText(value: string): string {
  return value.replace(DATA_IMAGE_URL, `[${IMAGE_PAYLOAD_REMOVED}]`);
}

function removedOutput() {
  return { type: "json", value: { error: IMAGE_PAYLOAD_REMOVED } } as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
