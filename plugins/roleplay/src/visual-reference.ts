import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";

import type { AgentUserMessage } from "@yesimbot/agent-runtime";
import { detectImageMediaType, RESOURCE_MAX_BYTES } from "koishi-plugin-yesimbot";

export const VISUAL_REFERENCE_INSTRUCTIONS =
  "<role_visual_reference> 中的图片是当前角色的固定视觉自我参照，用于认识自身形象，不替代 PERSONA／角色卡中的身份、经历和行为定义。图中的服装代表该套造型，不意味着所有情境都穿同一套。它是角色背景，不是用户的新消息或当前请求，无需主动提及。";

export interface VisualReference {
  readonly image: Uint8Array;
  readonly mediaType: string;
}

/** Read an operator-selected local image once, without a remote reader or an unbounded allocation. */
export async function loadVisualReference(path: string): Promise<VisualReference> {
  if (!(await stat(path)).isFile()) throw new TypeError("Visual self-reference must be a regular image file");
  // O_NONBLOCK prevents a POSIX FIFO substituted after stat() from blocking before the FD check.
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new TypeError("Visual self-reference must be a regular image file");
    if (info.size > RESOURCE_MAX_BYTES) throw new RangeError("Visual self-reference exceeds the 5 MiB byte limit");
    const buffer = Buffer.alloc(Math.min(info.size, RESOURCE_MAX_BYTES) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    // A concurrent writer must not let a growing file escape the startup byte limit.
    if (length > RESOURCE_MAX_BYTES || length > info.size) throw new RangeError("Visual self-reference changed or exceeds the byte limit");
    const image = new Uint8Array(buffer.subarray(0, length));
    const mediaType = detectImageMediaType(image);
    if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp") {
      throw new TypeError("Visual self-reference must be a PNG, JPEG or WebP image");
    }
    return { image, mediaType };
  } finally {
    await file.close();
  }
}

/** Ordinary user-role transport for image support; no canonical message ID or timestamp. */
export function createVisualReferenceMessage(reference: VisualReference): Pick<AgentUserMessage, "role" | "content"> {
  return {
    role: "user",
    content: [
      { type: "text", text: "<role_visual_reference>\n固定角色视觉参考（非聊天消息）：" },
      { type: "image", image: reference.image, mediaType: reference.mediaType },
      { type: "text", text: "\n</role_visual_reference>" },
    ],
  };
}
