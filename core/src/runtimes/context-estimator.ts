import { createHash, type Hash } from "node:crypto";

import type { ModelMessage } from "ai";

import { estimateContextMessage } from "./context-budget.js";

/** A provisional text-density floor, not a provider tokenizer or a bound on native media. */
export const UNMEASURED_TOOL_TOKEN_RATIO = 0.5;
const MAX_TOOL_SIGNATURES = 2048;

export interface ContextCost {
  readonly bytes: number;
  readonly unmeasuredToolBytes: number;
}

export interface ContextMeasurement extends ContextCost {
  readonly messages: readonly ContextCost[];
  /** Only digests/counts from this request; never retained tool bodies. */
  readonly toolResults: ReadonlyMap<string, number>;
}

/** Keep fractional costs until the complete request is rounded once. */
export function contextCostTokens(cost: ContextCost, multiplier: number): number {
  return cost.bytes * multiplier + cost.unmeasuredToolBytes * Math.max(0, UNMEASURED_TOOL_TOKEN_RATIO - multiplier);
}

export function measureContextMessages(messages: readonly ModelMessage[], measured: ReadonlyMap<string, number> = new Map()): ContextMeasurement {
  const remaining = new Map(measured);
  const toolResults = new Map<string, number>();
  const costs = messages.map((message): ContextCost => {
    const bytes = estimateContextMessage(message);
    if (message.role !== "tool" || !message.content.some((part) => part.type === "tool-result")) return { bytes, unmeasuredToolBytes: 0 };
    const hash = createHash("sha256");
    // Unknown/native-media representations cannot authorize reuse of a previous measurement.
    const signature = hashValue(hash, message, new Set(), 0) ? hash.digest("hex") : undefined;
    if (signature !== undefined) {
      const count = toolResults.get(signature);
      if (count !== undefined || toolResults.size < MAX_TOOL_SIGNATURES) toolResults.set(signature, (count ?? 0) + 1);
      const available = remaining.get(signature) ?? 0;
      if (available > 0) {
        remaining.set(signature, available - 1);
        return { bytes, unmeasuredToolBytes: 0 };
      }
    }
    return { bytes, unmeasuredToolBytes: bytes };
  });
  return {
    bytes: costs.reduce((sum, cost) => sum + cost.bytes, 0),
    unmeasuredToolBytes: costs.reduce((sum, cost) => sum + cost.unmeasuredToolBytes, 0),
    messages: costs,
    toolResults,
  };
}

/** Stream a canonical JSON-like digest; do not serialize binary payloads or cache raw values. */
function hashValue(hash: Hash, value: unknown, ancestors: Set<object>, depth: number): boolean {
  if (depth > 64) return false;
  if (value === undefined) {
    hash.update("undefined;");
    return true;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    hash.update(JSON.stringify(value));
    hash.update(";");
    return true;
  }
  if (typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || ancestors.has(value)) return false;
  if (value instanceof URL) {
    hash.update("url:");
    hash.update(JSON.stringify(value.href));
    return true;
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string" && ["image", "file", "image-data", "image-url", "file-data", "file-url", "media"].includes(record.type)) return false;
  ancestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    hash.update("[");
    for (const entry of value) {
      if (!hashValue(hash, entry, ancestors, depth + 1)) {
        valid = false;
        break;
      }
    }
    hash.update("]");
  } else {
    hash.update("{");
    for (const key of Object.keys(record).sort()) {
      hash.update(JSON.stringify(key));
      hash.update(":");
      if (!hashValue(hash, record[key], ancestors, depth + 1)) {
        valid = false;
        break;
      }
    }
    hash.update("}");
  }
  ancestors.delete(value);
  return valid;
}
