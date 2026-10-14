import { readFileSync } from "node:fs";

import type { ReadVideoPolicy } from "../../src/agents/tools.js";

/** Non-private 3s H.264/AAC fixture: red -> green -> blue, continuous 700Hz tone. */
export const VIDEO_BYTES = new Uint8Array(readFileSync(new URL("../fixtures/synthetic-colors-tone.mp4", import.meta.url)));

export function createVideoPolicy(native = true): ReadVideoPolicy {
  const turns = new Set<string>();
  return {
    mode: native ? "native" : "unavailable",
    reserve: (turnId) => {
      if (turns.has(turnId)) return false;
      turns.add(turnId);
      return true;
    },
    release: (turnId) => {
      turns.delete(turnId);
    },
  };
}

/** Add an ISO BMFF free box without changing the original audio/video tracks. */
export function paddedVideo(size: number): Uint8Array {
  if (size < VIDEO_BYTES.length + 8) throw new Error("Padding must fit a free box");
  const result = new Uint8Array(size);
  result.set(VIDEO_BYTES);
  new DataView(result.buffer).setUint32(VIDEO_BYTES.length, size - VIDEO_BYTES.length);
  result.set(new TextEncoder().encode("free"), VIDEO_BYTES.length + 4);
  return result;
}
