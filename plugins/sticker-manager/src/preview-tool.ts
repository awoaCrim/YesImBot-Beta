import { jsonSchema, type AgentTool, type EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import type { ImagePreviewCapability, ImagePreviewFrame } from "koishi-plugin-yesimbot";

import { detectImageMediaType, sha256Hex } from "./files.js";
import { sampleGifFrames, staticFrameToPng } from "./frames.js";
import type { StickerPreviewGate } from "./preview-evidence.js";
import type { StickerStore } from "./store.js";
import { pickBestTaggedSticker } from "./tag-selection.js";
import type { StickerConfig } from "./types.js";

export const STICKER_PREVIEW_MAX_FRAMES = 6;
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

export type StickerPreviewResult =
  | {
      ok: true;
      previewed: true;
      id: string;
      contentHash: string;
      mode: "native" | "description";
      category: string;
      mime: string;
      frameCount: number;
      totalFrames: number;
      sampled: boolean;
      frames: string[];
      description?: string;
      message: string;
    }
  | { ok: false; error: string };

export interface StickerPreviewToolOptions {
  readonly store: StickerStore;
  readonly config: StickerConfig;
  readonly scopeKey: string;
  readonly projection: EphemeralImageProjectionStore;
  readonly previewCapability: ImagePreviewCapability | undefined;
  readonly gate: StickerPreviewGate;
  readonly deliveryMode?: "legacy" | "authored" | "delegated";
}

interface PreviewStickerInput {
  sticker_id?: string;
  category?: string;
  index?: number;
  tags?: string[];
}

/** Selection is read-only and resolves once; send never re-randomizes the chosen target. */
export function createStickerPreviewTool(options: StickerPreviewToolOptions): AgentTool<PreviewStickerInput, StickerPreviewResult> {
  const { store, config, scopeKey, projection, previewCapability, gate } = options;
  return {
    name: "sticker_preview",
    description: [
      "查看已有表情包的实际画面。发送前必须先查看；分类、标签和搜索元数据不算看过。",
      "可传精确 sticker_id，或按 category/index/tags 选定一张；不传参数随机挑选候选供查看，不会直接发送。",
      options.deliveryMode === "delegated"
        ? "按 prepare_reply 的原样 selector 查看；本步骤完成后，在更后一步只用 preparation_id 继续准备，不能自行编写视觉说明或角色台词。"
        : options.deliveryMode === "authored"
          ? "返回实际画面或视觉描述及精确 id；查看完成后，在更后一步把同一 id 放入 send_message 完整 parts。不要并列查看和发送。"
          : "返回实际画面或视觉描述及精确 id；等看到结果并判断合适后，再用同一 id 调用 sticker_send，不要在同一步并列调用查看与发送。",
      "查看不会发送、不会增加使用次数，也不代表必须发送。动图可能只提供标明位置的采样帧，不要假设看到了整个动画。",
    ].join("\n"),
    inputSchema: jsonSchema<PreviewStickerInput>({
      type: "object",
      properties: {
        sticker_id: { type: "string", description: "sticker_search 返回的精确 id" },
        category: { type: "string", description: "已有分类完整名称；仅传分类时随机选择候选供查看" },
        index: { type: "integer", minimum: 1, description: "分类内 1-based 序号" },
        ...(config.tagMode ? { tags: { type: "array", items: { type: "string" }, maxItems: 5, description: "按标签选择候选" } } : {}),
      },
      additionalProperties: false,
    }),
    execute: async ({ sticker_id, category, index, tags }, execution) => {
      const ticket = gate.begin(execution.turnId);
      projection.clear(execution.toolCallId);
      if (execution.abortSignal?.aborted) return { ok: false, error: "resource_read_aborted" };
      if (!previewCapability || previewCapability.mode === "unavailable") return { ok: false, error: "image_input_unavailable" };
      try {
        const sticker = sticker_id
          ? await store.get(scopeKey, sticker_id)
          : index !== undefined
            ? await indexedSticker(store, scopeKey, category, index)
            : tags?.length && config.tagMode
              ? await pickBestTaggedSticker(store, scopeKey, tags, category, config.fuzzyTagMatch, config.tagRandomRange)
              : await store.random(scopeKey, category);
        if (!sticker) return { ok: false, error: "sticker_not_found" };
        if (sticker.size > MAX_PREVIEW_BYTES) return { ok: false, error: "sticker_preview_too_large" };
        const bytes = await store.readBytes(sticker);
        if (execution.abortSignal?.aborted) return { ok: false, error: "resource_read_aborted" };
        if (bytes.byteLength > MAX_PREVIEW_BYTES) return { ok: false, error: "sticker_preview_too_large" };
        const mediaType = detectImageMediaType(bytes);
        if (!mediaType) return { ok: false, error: "sticker_preview_unavailable" };
        const contentHash = sha256Hex(bytes);
        const preview = buildFrames(bytes, mediaType);
        if (!preview || preview.frames.reduce((n, frame) => n + frame.bytes.byteLength, 0) > MAX_PREVIEW_BYTES) {
          return { ok: false, error: "sticker_preview_unavailable" };
        }
        let description: string | undefined;
        if (previewCapability.mode === "native") {
          const outcome = previewCapability.preview({
            toolCallId: execution.toolCallId,
            turnId: execution.turnId,
            frames: preview.frames,
            signal: execution.abortSignal,
          });
          if (outcome.mode !== "native") return { ok: false, error: outcome.error };
        } else {
          description = await previewCapability.describe({
            frames: preview.frames,
            question: "请读出清晰可见的文字、描述角色动作和表情，再说明可能表达的情绪；只描述提供的画面，采样帧以外的动作无法确认。",
            signal: execution.abortSignal,
          });
          if (!description?.trim()) return { ok: false, error: "sticker_preview_unavailable" };
        }
        const mode = description ? ("description" as const) : ("native" as const);
        if (
          !gate.record(
            execution.turnId,
            { stickerId: sticker.id, contentHash, mediaType, mode, toolCallId: execution.toolCallId },
            ticket,
            execution.abortSignal,
          )
        ) {
          projection.clear(execution.toolCallId);
          return { ok: false, error: "resource_read_aborted" };
        }
        // Capture the exact content the model just saw, so a later cleanup or preview cannot revive
        // a stale candidate and the expression owner receives the same bounded evidence.
        const retained = gate.recordSnapshot(
          execution.turnId,
          {
            stickerId: sticker.id,
            contentHash,
            mediaType,
            mode,
            frames: preview.frames.map((frame) => ({ bytes: frame.bytes, mediaType: frame.mediaType, label: frame.label })),
            ...(description ? { description } : {}),
          },
          ticket,
          execution.abortSignal,
        );
        if (!retained) {
          projection.clear(execution.toolCallId);
          return { ok: false, error: "resource_read_aborted" };
        }
        return {
          ok: true,
          previewed: true,
          id: sticker.id,
          contentHash,
          mode,
          category: sticker.category,
          // Echo the authorized selector so a resume matches this exact completed call/result.
          requested: { ...(sticker_id ? { sticker_id } : {}), ...(category ? { category } : {}), ...(index === undefined ? {} : { index }) },
          mime: mediaType,
          frameCount: preview.frames.length,
          totalFrames: preview.totalFrames,
          sampled: preview.frames.length < preview.totalFrames,
          frames: preview.frames.map((frame) => frame.label),
          ...(description ? { description } : {}),
          message: "请根据提供的画面/描述判断是否适合当前语境；需要发送时使用本结果的 id。采样不代表完整动画。",
        };
      } catch {
        return { ok: false, error: execution.abortSignal?.aborted ? "resource_read_aborted" : "sticker_preview_unavailable" };
      }
    },
    toModelOutput: ({ toolCallId, output }) => {
      if (!output.ok || output.mode !== "native") return { type: "json", value: output };
      const frames = projection.getFrames(toolCallId);
      if (!frames.length) return { type: "json", value: { ok: false, error: "sticker_preview_expired" } };
      return {
        type: "content",
        value: [
          { type: "text", text: JSON.stringify(output) },
          ...frames.map((frame) => ({ type: "image-data" as const, data: Buffer.from(frame.bytes).toString("base64"), mediaType: frame.mediaType })),
        ],
      };
    },
  };
}

async function indexedSticker(store: StickerStore, scopeKey: string, category: string | undefined, index: number) {
  const stickers = category
    ? await store.listCategory(scopeKey, category)
    : (await store.listByScopeKey(scopeKey)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return stickers[index - 1];
}

function buildFrames(bytes: Uint8Array, mediaType: string): { frames: ImagePreviewFrame[]; totalFrames: number } | undefined {
  if (mediaType === "image/gif") {
    const sampling = sampleGifFrames(bytes, { maxFrames: STICKER_PREVIEW_MAX_FRAMES });
    return (
      sampling && {
        frames: sampling.samples.map((sample) => ({ ...sample.png, label: `frame ${sample.index + 1}/${sampling.totalFrames}, ${sample.timeMs}ms` })),
        totalFrames: sampling.totalFrames,
      }
    );
  }
  // WebP is already a supported model image format; no server-side decompression is needed.
  if (mediaType === "image/webp") return { frames: [{ bytes, mediaType, label: "WebP 画面（若为动画，不保证所有帧可见）" }], totalFrames: 1 };
  const still = staticFrameToPng(bytes, mediaType);
  return still && { frames: [{ ...still, label: "静态画面" }], totalFrames: 1 };
}
