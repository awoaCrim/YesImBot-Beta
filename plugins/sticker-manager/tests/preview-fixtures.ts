import { createToolMessage, EphemeralImageProjectionStore, type AgentMessage, type AgentTool } from "@yesimbot/agent-runtime";
import type { ChannelContext, ImagePreviewCapability } from "koishi-plugin-yesimbot";
import { PNG } from "pngjs";
import { vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { sha256Hex } from "../src/files.js";
import { StickerPreviewGate, StickerSendSlot } from "../src/preview-evidence.js";
import { createStickerPreviewTool } from "../src/preview-tool.js";
import type { StickerStore } from "../src/store.js";
import { createStickerTools } from "../src/tools.js";
import type { StickerConfig, StickerProjection } from "../src/types.js";

export const scope: ChannelContext = { type: "guild", platform: "test", channelId: "room", guildId: "room" };

export const config: StickerConfig = {
  scope: "global",
  storagePath: "unused",
  classificationModel: "",
  classificationPrompt: "{{categories}}",
  maxImportFileBytes: 1024 * 1024,
  tagMode: false,
  fuzzyTagMatch: true,
  tagRandomRange: 1,
  sendStaticAsGif: false,
  stickerElement: true,
  enableSteal: true,
};

export const pngBytes = (() => {
  const png = new PNG({ width: 2, height: 1 });
  png.data.set([255, 0, 0, 255, 0, 0, 255, 255]);
  return new Uint8Array(PNG.sync.write(png));
})();

export const stickerId = sha256Hex(pngBytes);

export function sticker(overrides: Partial<StickerProjection> = {}): StickerProjection {
  return {
    id: stickerId,
    category: "meme",
    tags: [],
    mime: "image/png",
    size: pngBytes.length,
    source: { kind: "import" },
    usageCount: 0,
    lastUsedAt: null,
    createdAt: "2026-01-01",
    ...overrides,
  };
}

export function createDeps(overrides: Partial<StickerConfig> = {}, mode: "native" | "vision" | "unavailable" = "native") {
  const store = {
    listCategories: vi.fn(async () => [{ category: "meme", count: 1 }]),
    listTags: vi.fn(async () => []),
    get: vi.fn(async (): Promise<StickerProjection | null> => sticker()),
    save: vi.fn(async (input: { tags?: readonly string[] }) => ({ status: "created", sticker: sticker({ tags: [...(input.tags ?? [])] }) })),
    search: vi.fn(async () => [sticker()]),
    listByScopeKey: vi.fn(async () => [sticker()]),
    listCategory: vi.fn(async () => [sticker()]),
    random: vi.fn(async (): Promise<StickerProjection | null> => sticker()),
    readBytes: vi.fn(async () => pngBytes),
    markUsed: vi.fn(async () => sticker({ usageCount: 1 })),
  };
  const projection = new EphemeralImageProjectionStore();
  const gate = new StickerPreviewGate();
  const slot = new StickerSendSlot();
  const classifier = { classify: vi.fn(async () => ({ category: "meme", tags: ["搞笑"] })) };
  const sender = { send: vi.fn(async () => undefined) };
  const assets = { put: vi.fn(async () => "a".repeat(32)), get: vi.fn(async () => pngBytes), clear: vi.fn(async () => undefined) };
  const capability: ImagePreviewCapability = {
    mode,
    preview: (request) => (projection.stageFrames(request) ? { mode: "native" } : { mode: "unavailable", error: "resource_read_aborted" }),
    describe: vi.fn(async () => "红色与蓝色的画面"),
  };
  const effective = { ...config, ...overrides };
  const preview = createStickerPreviewTool({
    store: store as unknown as StickerStore,
    config: effective,
    scopeKey: "global",
    projection,
    previewCapability: capability,
    gate,
  });
  const tools = createStickerTools({
    store: store as unknown as StickerStore,
    classifier,
    sender,
    assets,
    scope,
    config: effective,
    previewGate: gate,
    sendSlot: slot,
  });
  const tool = (name: string) => tools.find((entry) => entry.name === name)!;
  const messages: AgentMessage[] = [];
  const execute = (target: AgentTool, input: unknown, turnId = "turn-1", signal?: AbortSignal) =>
    target.execute(input, {
      toolCallId: "call",
      turnId,
      messages: [...messages],
      abortSignal: signal,
    } as never);
  const view = async (input: Record<string, unknown> = { sticker_id: stickerId }, turnId = "turn-1", signal?: AbortSignal) => {
    const output = await preview.execute(input, { toolCallId: "preview-call", turnId, messages: [...messages], abortSignal: signal } as never);
    const modelOutput = await preview.toModelOutput!({ toolCallId: "preview-call", input, output });
    messages.push(createToolMessage([{ type: "tool-result", toolName: "sticker_preview", toolCallId: "preview-call", output: modelOutput }]));
    return output;
  };
  return { store, classifier, sender, assets, projection, gate, slot, capability, preview, tools, tool, messages, execute, view };
}
