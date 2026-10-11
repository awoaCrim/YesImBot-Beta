import { jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
import type { Element } from "koishi";
import { hasCompletedImageRead, parseReply, RESOURCE_MAX_BYTES, withAbortSignal, type AssetStore, type ChannelContext } from "koishi-plugin-yesimbot";

import type { StickerClassifier } from "./classifier.js";
import { StickerDeliveryService } from "./delivery.js";
import { detectImageMediaType, sha256Hex } from "./files.js";
import type { StickerPreviewGate, StickerSendSlot } from "./preview-evidence.js";
import type { StickerSender } from "./sender.js";
import type { StickerStore } from "./store.js";
import { normalizeCategory, normalizeTags, scopeKeyFor, type StickerConfig } from "./types.js";

type ToolResult = { ok: true; message: string; [key: string]: unknown } | { ok: false; error: string };

type ManageStickerInput =
  | { action: "move"; sticker_id: string; category: string }
  | { action: "delete"; sticker_id: string }
  | { action: "rename_category" | "merge_category"; source_category: string; category: string };

export interface StickerToolsOptions {
  store: StickerStore;
  /** Compatibility for existing callers; Agent collection never invokes this classifier. */
  classifier?: StickerClassifier;
  sender: StickerSender;
  assets: AssetStore;
  scope: ChannelContext;
  config: StickerConfig;
  /** One successfully delivered sticker per turn, concurrency safe. */
  sendSlot: StickerSendSlot;
  /** Exact-content read evidence produced by `sticker_preview`. */
  previewGate: StickerPreviewGate;
  readonly captureTurn?: (turnId: string) => () => boolean;
  /** Shared modern/legacy delivery core, independent of optional viewing. */
  delivery?: StickerDeliveryService;
}

interface StealStickerInput {
  asset_id: string;
  category: string;
  tags?: string[];
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
  const { store, sender, assets, scope, config, sendSlot, previewGate, delivery } = options;
  const scopeKey = scopeKeyFor(scope, config);
  const deliveryService = delivery ?? new StickerDeliveryService({ store, sender, scope, config, sendSlot, previewGate, captureTurn: options.captureTurn });

  const stealTool: AgentTool<StealStickerInput, ToolResult> = {
    name: "sticker_steal",
    description: [
      "收藏当前聊天（含历史）中已经实际看过的一张图片；不占发送额度。",
      "asset_id 只传消息资源的完整 32 位十六进制 id，不接受 URI/路径，不要猜测。",
      "先完成同一 asset 的 read 原生图片或成功非空 read/describe_image 视觉描述；只有链接、元数据或旧原生结果已清理时必须重读。",
      "category 必填：根据画面选择已有或新的具体分类，不可为空或“未分类”；不会调用辅助分类模型。",
      "重复内容返回已有真实 ID/分类，不会暗中改类；旧未分类记录需要显式管理或管理员分类。",
      ...(config.tagMode ? ["可选 tags 最多 5 个，由你依据画面提供；也会包含分类标签。"] : []),
    ].join("\n"),
    inputSchema: jsonSchema<StealStickerInput>({
      type: "object",
      properties: {
        asset_id: { type: "string", pattern: "^[a-f0-9]{32}$", description: "当前聊天完整 32 位 asset id" },
        category: { type: "string", minLength: 1, description: "根据实际画面选择的具体分类，非未分类" },
        ...(config.tagMode ? { tags: { type: "array", maxItems: 5, items: { type: "string", maxLength: 32 } } } : {}),
      },
      required: ["asset_id", "category"],
      additionalProperties: false,
    }),
    execute: async (input, execution) => {
      const current = options.captureTurn?.(execution.turnId) ?? (() => true);
      const allowed = () => config.enableSteal === true && current();
      if (!allowed()) return { ok: false, error: "StickerCapabilityRetired" };
      if (execution.abortSignal?.aborted) return { ok: false, error: "resource_read_aborted" };
      if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["asset_id", "category", ...(config.tagMode ? ["tags"] : [])].includes(key)))
        return { ok: false, error: "invalid_collection_input" };
      const { asset_id: id, category, tags } = input;
      if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) return { ok: false, error: "invalid_asset_id" };
      const classified = typeof category === "string" ? normalizeCategory(category) : "";
      if (!classified || classified === "未分类") return { ok: false, error: "classification_required" };
      if (tags !== undefined && (!Array.isArray(tags) || tags.length > 5 || tags.some((tag) => typeof tag !== "string" || tag.length > 32)))
        return { ok: false, error: "invalid_tags" };
      let bytes: Uint8Array;
      try {
        bytes = await withAbortSignal(assets.get(id), execution.abortSignal);
      } catch {
        return { ok: false, error: execution.abortSignal?.aborted ? "resource_read_aborted" : "asset_not_found" };
      }
      if (!allowed()) return { ok: false, error: "StickerCapabilityRetired" };
      if (bytes.byteLength > RESOURCE_MAX_BYTES) return { ok: false, error: "resource_too_large" };
      const mediaType = detectImageMediaType(bytes);
      if (!mediaType) return { ok: false, error: "unsupported_image" };
      if (sha256Hex(bytes).slice(0, 32) !== id) return { ok: false, error: "asset_identity_mismatch" };
      if (!hasCompletedImageRead(execution.messages, { uri: `asset://${id}`, bytes, mediaType })) return { ok: false, error: "image_read_required" };
      try {
        // Duplicate detection and commit share the guarded queue; do not merge tags or move duplicates.
        const saved = await store.save(
          {
            scopeKey,
            bytes,
            mediaType,
            category: classified,
            tags: config.tagMode ? normalizeTags([classified, ...(tags ?? [])]) : undefined,
            source: { kind: "steal", platform: scope.platform, channelId: scope.channelId },
          },
          { signal: execution.abortSignal, stillAllowed: allowed, preserveDuplicate: true },
        );
        const actual = { status: saved.status, id: saved.sticker.id, category: saved.sticker.category, tags: saved.sticker.tags };
        if (!normalizeCategory(saved.sticker.category) || normalizeCategory(saved.sticker.category) === "未分类")
          return { ...actual, ok: false, error: "classification_required" };
        return {
          ...actual,
          ok: true,
          message: saved.status === "duplicate" ? `表情包已存在于分类：${saved.sticker.category}` : `已收藏到分类：${saved.sticker.category}`,
        };
      } catch {
        return {
          ok: false,
          error: execution.abortSignal?.aborted ? "resource_read_aborted" : !allowed() ? "StickerCapabilityRetired" : "sticker_collection_failed",
        };
      }
    },
  };

  const sendTool: AgentTool<SendStickerInput, ToolResult> = {
    name: "sticker_send",
    terminal: (input) => !input.continue,
    description: [
      "发送当前可见库的一张表情包，必须使用完整精确 sticker_id；sticker_preview 可选，不限制发送目标。",
      "同一轮最多实际发送一张；本轮成功或结果不确定后再次调用会返回 sticker_send_limit_reached。",
      "表情包可以单独作为回应，也可以放在文字之前或之后；顺序由你决定，没有固定搭配。",
      "默认发送后结束本轮；continue=true 时继续下一步，用于在表情包之后还要发送文字。",
      "不合适的场合可以直接省略表情包、只用文字回应，不要为了发送而选无关内容。",
      ...(config.sendStaticAsGif ? ["静态图片会自动转成单帧 GIF 后发送。"] : []),
    ].join("\n"),
    inputSchema: jsonSchema<SendStickerInput>({
      type: "object",
      properties: {
        sticker_id: { type: "string", description: "当前可见库的完整精确 64 位 sticker id，必须原样传入" },
        continue: { type: "boolean", description: "默认 false，发送后结束本轮；之后还要发送文字或其他内容时设为 true" },
      },
      required: ["sticker_id"],
      additionalProperties: false,
    }),
    execute: async ({ sticker_id, continue: shouldContinue }, execution) => {
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
      "搜索结果只是候选元数据，不代表你已经看过画面；可用 sticker_preview 查看实际画面，也可直接发送当前可见库的精确 id。",
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
        message: stickers.length ? "已返回当前搜索结果；这些只是元数据，可选 sticker_preview 查看画面" : "没有匹配的表情包",
      };
    },
  };

  const manageTool: AgentTool<ManageStickerInput, ToolResult> = {
    name: "sticker_manage",
    description:
      "管理当前可见库：move 单张重新分类；rename_category 分类改名；merge_category 分类合并；delete 删除精确单张（含管理员导入）。不支持整类或批量删除，不要循环单张删除模拟批量操作；批量需求交给管理员确认。分类通过记录创建，当前工具/查询结果比回合开始快照更新。",
    inputSchema: jsonSchema<ManageStickerInput>({
      oneOf: [
        {
          type: "object",
          properties: { action: { const: "move" }, sticker_id: { type: "string", pattern: "^[a-f0-9]{64}$" }, category: { type: "string", minLength: 1 } },
          required: ["action", "sticker_id", "category"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { action: { const: "delete" }, sticker_id: { type: "string", pattern: "^[a-f0-9]{64}$" } },
          required: ["action", "sticker_id"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            action: { enum: ["rename_category", "merge_category"] },
            source_category: { type: "string", minLength: 1 },
            category: { type: "string", minLength: 1 },
          },
          required: ["action", "source_category", "category"],
          additionalProperties: false,
        },
      ],
    }),
    execute: async (input, execution) => {
      const current = options.captureTurn?.(execution.turnId) ?? (() => true);
      const allowed = () => config.enableManage === true && current();
      if (!allowed()) return { ok: false, error: "StickerCapabilityRetired" };
      if (execution.abortSignal?.aborted) return { ok: false, error: "resource_read_aborted" };
      if (!input || typeof input !== "object") return { ok: false, error: "invalid_management_input" };
      const keys =
        input.action === "delete"
          ? ["action", "sticker_id"]
          : input.action === "move"
            ? ["action", "sticker_id", "category"]
            : ["action", "source_category", "category"];
      if (Object.keys(input).some((key) => !keys.includes(key)) || keys.some((key) => typeof (input as Record<string, unknown>)[key] !== "string"))
        return { ok: false, error: "invalid_management_input" };
      if (!["move", "delete", "rename_category", "merge_category"].includes(input.action)) return { ok: false, error: "invalid_management_input" };
      const category = "category" in input ? normalizeCategory(input.category) : undefined;
      if (category !== undefined && (!category || category === "未分类")) return { ok: false, error: "classification_required" };
      const guard = { signal: execution.abortSignal, stillAllowed: allowed };
      try {
        if (input.action === "move" || input.action === "delete") {
          if (!/^[a-f0-9]{64}$/.test(input.sticker_id)) return { ok: false, error: "invalid_sticker_id" };
          if (input.action === "delete") {
            const removed = await store.deleteSticker(scopeKey, input.sticker_id, guard);
            return removed.removed ? { ok: true, id: input.sticker_id, ...removed, message: "已删除指定单张记录" } : { ok: false, error: "sticker_not_found" };
          }
          const affected = await store.moveSticker(scopeKey, input.sticker_id, category!, guard);
          return affected
            ? { ok: true, id: input.sticker_id, category, affected, message: `已移动到分类：${category}` }
            : { ok: false, error: "sticker_not_found" };
        }
        if (input.source_category === category) return { ok: false, error: "category_unchanged" };
        const affected =
          input.action === "rename_category"
            ? await store.renameCategory(scopeKey, input.source_category, category!, guard)
            : await store.mergeCategories(scopeKey, input.source_category, category!, guard);
        return affected
          ? { ok: true, sourceCategory: input.source_category, category, affected, message: "已更新分类，当前查询已生效" }
          : { ok: false, error: "category_not_found" };
      } catch (cause) {
        return {
          ok: false,
          error: execution.abortSignal?.aborted
            ? "resource_read_aborted"
            : !allowed()
              ? "StickerCapabilityRetired"
              : cause instanceof Error && cause.message === "未找到该表情包"
                ? "sticker_not_found"
                : "sticker_management_failed",
        };
      }
    },
  };

  return [
    ...(config.enableSteal ? [stealTool] : []),
    ...(config.enableManage === true ? [manageTool] : []),
    sendTool,
    categoriesTool,
    searchTool,
    ...(tagsTool ? [tagsTool] : []),
  ];
}

/**
 * Delivery-boundary guard for `send_message`.
 *
 * Legacy sticker projection can leave `artifact://sticker/<id>.<ext>` URIs in assistant history, and
 * `prepareElement` turns any resolvable resource URI into real platform bytes. Passing one of those
 * URIs to `send_message` would therefore deliver a sticker without the exact-record admission or the per-turn
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
