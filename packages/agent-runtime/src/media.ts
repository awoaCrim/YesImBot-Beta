import type { AgentEntry } from "./entry.js";
import type { AgentMessage } from "./message.js";

const IMAGE_PAYLOAD_REMOVED = "image_payload_removed";
const VIDEO_PAYLOAD_REMOVED = "video_payload_removed";
// Data URLs may carry MIME parameters or percent-encoded (non-base64) media.
// Whitespace/quotes delimit an embedded URL; a standalone data URL is removed in full below.
const DATA_IMAGE_URL = /data:image\/[a-z0-9.+-]+(?:;[^,\s]*)?,[^\s"'<>`]*/gi;
const DATA_VIDEO_URL = /data:video\/[a-z0-9.+-]+(?:;[^,\s]*)?,[^\s"'<>`]*/gi;

/**
 * Produces the durable/history-safe representation of entries without mutating the live turn.
 * Structured image/video payloads are deliberately ephemeral: stable metadata and tool pairing
 * remain, while unrelated PDF/text content is preserved.
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
    return value.length > 0 ? { ...output, value } : removedOutput(output.value.some(isVideoPayloadPart) ? VIDEO_PAYLOAD_REMOVED : IMAGE_PAYLOAD_REMOVED);
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
    const removed = removedPayloadMarker(part);
    if (removed !== undefined) continue;
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
      result.push({ ...part, text: sanitizeText(part.text) });
      continue;
    }
    result.push(sanitizeUnknown(part));
  }
  return result;
}

/**
 * Returns the durable marker for a live media payload part, or undefined when the entry survives.
 * Image and video byte containers are dropped in favor of safe metadata; JSON tool outputs keep
 * their structure with only the payload replaced.
 */
function removedPayloadMarker(part: unknown): typeof IMAGE_PAYLOAD_REMOVED | typeof VIDEO_PAYLOAD_REMOVED | undefined {
  if (!isRecord(part)) return undefined;
  if (isVideoPayloadPart(part)) return VIDEO_PAYLOAD_REMOVED;
  if (isImagePayloadPart(part)) return IMAGE_PAYLOAD_REMOVED;
  return undefined;
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return value.slice();
  if (Array.isArray(value)) return sanitizeContentParts(value);
  if (isVideoPayloadPart(value)) return { error: VIDEO_PAYLOAD_REMOVED };
  if (isImagePayloadPart(value)) return { error: IMAGE_PAYLOAD_REMOVED };

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const videoContainer = isVideoContainer(record);
  const imageContainer = isImageContainer(record);
  for (const [key, item] of Object.entries(record)) {
    if ((videoContainer || imageContainer) && key === "data") continue;
    if (typeof item === "string" && (isDataImageUrl(item) || isDataVideoUrl(item)) && isMediaUrlKey(key)) {
      result[key] = `[${isDataVideoUrl(item) ? VIDEO_PAYLOAD_REMOVED : IMAGE_PAYLOAD_REMOVED}]`;
      continue;
    }
    result[key] = sanitizeUnknown(item);
  }
  return result;
}

function isMediaUrlKey(key: string): boolean {
  return key === "url" || key === "image_url" || key === "imageUrl" || key === "video_url" || key === "videoUrl";
}

function isImagePayloadPart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "image-data" || value.type === "input_image") return true;
  if (value.type === "image" && ("data" in value || "image" in value || "url" in value)) return true;
  if (value.type === "file" && isMediaType(value.mediaType, "image/") && "data" in value) return true;
  if (value.type === "image_url") return true;
  if (typeof value.url === "string" && isDataImageUrl(value.url)) return true;
  if (isRecord(value.image_url) && typeof value.image_url.url === "string" && isDataImageUrl(value.image_url.url)) return true;
  return false;
}

/** Native video can arrive as a file-data part, a provider file part, or an inlineData container. */
function isVideoPayloadPart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "video-data" || value.type === "input_video" || value.type === "video_url") return true;
  if (value.type === "video" && ("data" in value || "video" in value || "url" in value || "bytes" in value)) return true;
  if (value.type === "file" && isMediaType(value.mediaType, "video/") && ("data" in value || "url" in value)) return true;
  if (value.type === "file-data" && isMediaType(value.mediaType, "video/") && "data" in value) return true;
  if (isRecord(value.inlineData) && isMediaType(value.inlineData.mimeType, "video/")) return true;
  if (typeof value.url === "string" && isDataVideoUrl(value.url)) return true;
  return false;
}

function isVideoContainer(value: Record<string, unknown>): boolean {
  return (
    value.type === "video-data" ||
    value.type === "video" ||
    value.type === "input_video" ||
    (value.type === "file" && isMediaType(value.mediaType, "video/")) ||
    (value.type === "file-data" && isMediaType(value.mediaType, "video/")) ||
    (isRecord(value.inlineData) && isMediaType(value.inlineData.mimeType, "video/"))
  );
}

function isImageContainer(value: Record<string, unknown>): boolean {
  return (
    value.type === "image-data" || value.type === "image" || value.type === "input_image" || (value.type === "file" && isMediaType(value.mediaType, "image/"))
  );
}

function isMediaType(value: unknown, prefix: string): boolean {
  return typeof value === "string" && value.toLowerCase().startsWith(prefix);
}

function isDataImageUrl(value: string): boolean {
  return /^data:image\//i.test(value);
}

function isDataVideoUrl(value: string): boolean {
  return /^data:video\//i.test(value);
}

function sanitizeText(value: string): string {
  if (isDataImageUrl(value)) return `[${IMAGE_PAYLOAD_REMOVED}]`;
  if (isDataVideoUrl(value)) return `[${VIDEO_PAYLOAD_REMOVED}]`;
  return value.replace(DATA_IMAGE_URL, `[${IMAGE_PAYLOAD_REMOVED}]`).replace(DATA_VIDEO_URL, `[${VIDEO_PAYLOAD_REMOVED}]`);
}

function removedOutput(marker: typeof IMAGE_PAYLOAD_REMOVED | typeof VIDEO_PAYLOAD_REMOVED = IMAGE_PAYLOAD_REMOVED) {
  return { type: "json", value: { error: marker } } as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
