import { createHash } from "node:crypto";

import type { AgentMessage, AgentToolMessage } from "@yesimbot/agent-runtime";

import { RESOURCE_MAX_BYTES } from "../resources/index.js";
import { detectImageMediaType } from "../resources/media.js";

/** Verify completed built-in reads from trusted live history, not a URI or model assertion. */
export function hasCompletedImageRead(
  messages: readonly AgentMessage[],
  target: { readonly uri: string; readonly bytes: Uint8Array; readonly mediaType: string },
): boolean {
  if (!/^asset:\/\/[a-f0-9]{32}$/.test(target.uri) || !target.bytes.length || target.bytes.length > RESOURCE_MAX_BYTES) return false;
  const hash = createHash("sha256").update(target.bytes).digest("hex");
  if (target.uri !== `asset://${hash.slice(0, 32)}` || detectImageMediaType(target.bytes) !== target.mediaType) return false;
  for (const [callIndex, message] of messages.entries()) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const call of message.content) {
      if (call.type !== "tool-call" || (call.toolName !== "read" && call.toolName !== "describe_image")) continue;
      const input = record(call.input);
      if (input?.uri !== target.uri) continue;
      let calls = 0;
      const results: { index: number; part: AgentToolMessage["content"][number] }[] = [];
      let mismatch = false;
      for (const [index, candidate] of messages.entries()) {
        if ((candidate.role !== "assistant" && candidate.role !== "tool") || !Array.isArray(candidate.content)) continue;
        for (const part of candidate.content) {
          if ((part.type !== "tool-call" && part.type !== "tool-result") || part.toolCallId !== call.toolCallId) continue;
          if (part.toolName !== call.toolName) mismatch = true;
          if (part.type === "tool-call" && candidate.role === "assistant") calls++;
          if (part.type === "tool-result" && candidate.role === "tool") results.push({ index, part });
        }
      }
      if (mismatch || calls !== 1 || results.length !== 1 || results[0]!.index <= callIndex) continue;
      const result = results[0]!.part;
      if (result.type !== "tool-result") continue;
      const output = result.output;
      if (call.toolName === "read" && output.type === "content") {
        const images = output.value.filter((part) => part.type === "image-data");
        // Built-in native read projects exactly the opened bytes, unlike sampled Sticker frames.
        if (images.length === 1 && images[0]!.mediaType === target.mediaType && images[0]!.data === Buffer.from(target.bytes).toString("base64")) return true;
      }
      if (output.type !== "json") continue;
      const value = record(output.value);
      if (!value || value.error !== undefined || typeof value.text !== "string" || !value.text.trim()) continue;
      if (call.toolName === "describe_image") return true;
      if (value.uri === target.uri && value.imageMode === "vision" && value.mediaType === target.mediaType) return true;
    }
  }
  return false;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
