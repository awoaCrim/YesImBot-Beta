import { jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
import type { Element } from "koishi";
import { parseReply, type AssetStore, type ChannelContext } from "koishi-plugin-yesimbot";

import type { StickerClassifier } from "./classifier.js";
import { StickerDeliveryService } from "./delivery.js";
import { detectImageMediaType, sha256Hex } from "./files.js";
import type { StickerPreviewGate, StickerSendSlot } from "./preview-evidence.js";
import type { StickerSender } from "./sender.js";
import type { StickerStore } from "./store.js";
import { normalizeCategory, normalizeTags, scopeKeyFor, type StickerConfig } from "./types.js";

type ToolResult = { ok: true; message: string; [key: string]: unknown } | { ok: false; error: string };

export interface StickerToolsOptions {
  store: StickerStore;
  classifier: StickerClassifier;
  sender: StickerSender;
  assets: AssetStore;
  scope: ChannelContext;
  config: StickerConfig;
  /** One successfully delivered sticker per turn, concurrency safe. */
  sendSlot: StickerSendSlot;
  /** Exact-content read evidence produced by `sticker_preview`. */
  previewGate: StickerPreviewGate;
  /** Shared modern/legacy delivery core; the legacy tool keeps its own strict same-step gate. */
  delivery?: StickerDeliveryService;
}

interface StealStickerInput {
  asset_id: string;
  category?: string;
}

interface SendStickerInput {
  sticker_id: string;
  continue?: boolean;
}

interface SearchStickerInput {
  category?: string;
  keyword?: string;
  tags?: string[];
  limit?: number;
}

export function createStickerTools(options: StickerToolsOptions): AgentTool[] {
  const { store, classifier, sender, assets, scope, config, sendSlot, previewGate, delivery } = options;
  const scopeKey = scopeKeyFor(scope, config);
  const deliveryService = delivery ?? new StickerDeliveryService({ store, sender, scope, config, sendSlot, previewGate });

  const stealTool: AgentTool<StealStickerInput, ToolResult> = {
    name: "sticker_steal",
    description: [
      "收藏当前消息中的一张表情包图片。",
      "asset_id 必须来自消息里的 [图片：asset://<id>]，只传 32 位十六进制 id，不要拼接或猜测。",
      "category 可选；不提供时会使用视觉模型自动分类，失败则归入“未分类”。",
      ...(config.tagMode ? ["实验性 tag 模式开启时，收藏后会按分类自动打 tag。"] : []),
    ].join("\n"),
    inputSchema: jsonSchema<StealStickerInput>({
      type: "object",
      properties: { asset_id: { type: "string", description: "当前消息图片的 32 位 asset id" }, category: { type: "string", description: "可选分类名" } },
      required: ["asset_id"],
      additionalProperties: false,
    }),
    execute: async ({ asset_id, category }, execution) => {
      const id = asset_id.replace(/^asset:\/\//, "");
      if (!/^[a-f0-9]{32}$/.test(id)) return { ok: false, error: "invalid_asset_id" };
      let bytes: Uint8Array;
      try {
        bytes = await assets.get(id);
      } catch {
        return { ok: false, error: "asset_not_found" };
      }
      const mediaType = detectImageMediaType(bytes);
      if (!mediaType) return { ok: false, error: "unsupported_image" };
      const contentId = sha256Hex(bytes);
      const existing = await store.get(scopeKey, contentId);
      if (existing) {
        return {
          ok: true,
          status: "duplicate",
          id: existing.id,
          category: existing.category,
          tags: existing.tags,
          message: `表情包已存在于分类：${existing.category}`,
        };
      }

      const categories = (await store.listCategories(scopeKey)).map((item) => item.category);
      const autoClassified = category ? undefined : await classifier.classify({ bytes, mediaType, categories, signal: execution.abortSignal });
      const classified = category ? normalizeCategory(category) : (autoClassified?.category ?? "未分类");

      const saved = await store.save({
        scopeKey,
        bytes,
        mediaType,
        category: classified,
        tags: config.tagMode ? normalizeTags([classified, ...(autoClassified?.tags ?? [])]) : undefined,
        source: { kind: "steal", platform: scope.platform, channelId: scope.channelId },
      });
      return {
        ok: true,
        status: saved.status,
        id: saved.sticker.id,
        category: saved.sticker.category,
        tags: saved.sticker.tags,
        message: saved.status === "duplicate" ? `表情包已存在于分类：${saved.sticker.category}` : `已收藏到分类：${saved.sticker.category}`,
      };
    },
  };

  const sendTool: AgentTool<SendStickerInput, ToolResult> = {
    name: "sticker_send",
    terminal: (input) => !input.continue,
    description: [
      "发送一张已经用 sticker_preview 查看过的表情包；sticker_id 必须是这一步返回的同一个 id。",
      "同一轮最多实际发送一张；本轮成功或结果不确定后再次调用会返回 sticker_send_limit_reached。",
      "表情包可以单独作为回应，也可以放在文字之前或之后；顺序由你决定，没有固定搭配。",
      "默认发送后结束本轮；continue=true 时继续下一步，用于在表情包之后还要发送文字。",
      "不合适的场合可以直接省略表情包、只用文字回应，不要为了发送而选无关内容。",
      ...(config.sendStaticAsGif ? ["静态图片会自动转成单帧 GIF 后发送。"] : []),
    ].join("\n"),
    inputSchema: jsonSchema<SendStickerInput>({
      type: "object",
      properties: {
        sticker_id: { type: "string", description: "sticker_preview 返回的 id，必须原样传入" },
        continue: { type: "boolean", description: "默认 false，发送后结束本轮；之后还要发送文字或其他内容时设为 true" },
      },
      required: ["sticker_id"],
      additionalProperties: false,
    }),
    execute: async ({ sticker_id, continue: shouldContinue }, execution) => {
      if (!sticker_id) return { ok: false, error: "sticker_preview_required" };
      const prepared = await deliveryService.preflight({
        stickerId: sticker_id,
        turnId: execution.turnId,
        messages: execution.messages,
        signal: execution.abortSignal,
        proofRequired: false,
      });
      if ("error" in prepared) return { ok: false, error: prepared.error };
      const result = await prepared.lease.send(execution.abortSignal);
      if (result.status !== "confirmed") return { ok: false, error: result.error ?? "sticker_delivery_uncertain" };
      return {
        ok: true,
        id: prepared.lease.stickerId,
        category: prepared.lease.category,
        tags: prepared.lease.tags,
        continued: shouldContinue === true,
        ...(result.warning ? { warning: result.warning } : {}),
        message: `已发送 ${prepared.lease.category} 分类的表情包`,
      };
    },
  };

  const categoriesTool: AgentTool<Record<string, never>, ToolResult> = {
    name: "sticker_categories",
    description: config.enableSteal
      ? "列出当前可见的表情包分类和每类数量，用于选择 sticker_steal 或 sticker_preview 的分类。"
      : "列出当前可见的表情包分类和每类数量，用于选择 sticker_preview 的分类。",
    inputSchema: jsonSchema<Record<string, never>>({ type: "object", additionalProperties: false }),
    execute: async () => {
      const categories = await store.listCategories(scopeKey);
      return { ok: true, categories, message: categories.length ? "已返回分类列表" : "暂无分类" };
    },
  };

  const tagsTool = config.tagMode
    ? ({
        name: "sticker_tags",
        description: "实验性：列出当前可见表情包的标签和数量，用于 sticker_preview 按标签选定目标。",
        inputSchema: jsonSchema<Record<string, never>>({ type: "object", additionalProperties: false }),
        execute: async () => {
          const tags = await store.listTags(scopeKey);
          return { ok: true, tags, message: tags.length ? "已返回标签列表" : "暂无标签" };
        },
      } satisfies AgentTool<Record<string, never>, ToolResult>)
    : null;

  const searchTool: AgentTool<SearchStickerInput, ToolResult> = {
    name: "sticker_search",
    description: [
      "搜索当前可见的表情包，返回紧凑 id 候选列表。",
      "category 按完整分类名精确匹配；keyword 只是分类名、id 或标签的单个子串，不支持 OR/AND 运算，也不按图片画面或人物进行语义搜索。",
      "搜索结果只是候选元数据，不代表你已经看过画面；确定目标后先用 sticker_preview 查看，再用返回的同一 id 发送。",
      "绝不能把返回的 id 拼成 artifact:// 等资源 URI。",
      ...(config.tagMode ? ["实验性 tag 模式开启时，可按 tags 过滤。"] : []),
    ].join("\n"),
    inputSchema: jsonSchema<SearchStickerInput>({
      type: "object",
      properties: {
        category: { type: "string", description: "已有分类的完整名称，精确匹配" },
        keyword: { type: "string", description: "分类名、id 或标签的单个子串（忽略大小写）；不支持 OR/AND 或画面语义搜索" },
        ...(config.tagMode ? { tags: { type: "array", items: { type: "string" }, maxItems: 5, description: "实验性标签列表，匹配任一标签即可" } } : {}),
        limit: { type: "integer", minimum: 1, maximum: 50, description: "返回数量上限" },
      },
      additionalProperties: false,
    }),
    execute: async (query) => {
      const stickers = await store.search(scopeKey, query);
      return {
        ok: true,
        stickers: stickers.map((sticker) => ({
          id: sticker.id,
          category: sticker.category,
          tags: sticker.tags,
          mime: sticker.mime,
          size: sticker.size,
          usageCount: sticker.usageCount,
        })),
        message: stickers.length ? "已返回搜索结果；这些只是元数据，发送前需先 sticker_preview 查看画面" : "没有匹配的表情包",
      };
    },
  };

  return [...(config.enableSteal ? [stealTool] : []), sendTool, categoriesTool, searchTool, ...(tagsTool ? [tagsTool] : [])];
}

/**
 * Delivery-boundary guard for `send_message`.
 *
 * Legacy sticker projection can leave `artifact://sticker/<id>.<ext>` URIs in assistant history, and
 * `prepareElement` turns any resolvable resource URI into real platform bytes. Passing one of those
 * URIs to `send_message` would therefore deliver a sticker without the preview gate or the per-turn
 * quota. This returns a block reason for exactly that case and never inspects unrelated payloads.
 */
export function stickerSendMessageBlockReason(input: unknown): string | undefined {
  const value = input as { messages?: unknown; verbatim?: unknown; parts?: unknown; mode?: unknown } | null;
  if (!value || value.mode === "raw") return undefined;
  const texts = [
    ...(Array.isArray(value.messages) ? value.messages : []),
    ...(Array.isArray(value.verbatim) ? value.verbatim : []),
    ...(Array.isArray(value.parts) ? value.parts.flatMap((part) => (part?.kind === "text" ? [part.text] : [])) : []),
  ];
  const restricted = (element: Element): boolean =>
    element.type === "sticker" ||
    ((element.type === "img" || element.type === "file") && /^artifact:\/\/sticker\//i.test(String(element.attrs.src ?? ""))) ||
    element.children.some(restricted);
  return texts.some((message) => typeof message === "string" && parseReply(message).some((segment) => segment.some(restricted)))
    ? "sticker_send_required"
    : undefined;
}

export { pickBestTaggedSticker } from "./tag-selection.js";
