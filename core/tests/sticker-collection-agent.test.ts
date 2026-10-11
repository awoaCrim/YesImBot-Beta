import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createAgent, createUserMessage, EphemeralImageProjectionStore, type Agent } from "@yesimbot/agent-runtime";
import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));
import { StickerDeliveryService } from "../../plugins/sticker-manager/src/delivery.js";
import { StickerFileStore } from "../../plugins/sticker-manager/src/files.js";
import { StickerPreviewGate, StickerSendSlot } from "../../plugins/sticker-manager/src/preview-evidence.js";
import { StickerStore } from "../../plugins/sticker-manager/src/store.js";
import { createStickerTools } from "../../plugins/sticker-manager/src/tools.js";
import type { StickerRow } from "../../plugins/sticker-manager/src/types.js";
import { createMemoryModel } from "../../plugins/sticker-manager/tests/helpers.js";
import { config, pngBytes, scope, stickerId } from "../../plugins/sticker-manager/tests/preview-fixtures.js";
import { createReplyTools } from "../src/agents/reply-tools.js";
import { createDescribeImageTool, createReadTool, type ReadImagePolicy } from "../src/agents/tools.js";
import { beginReplyJournal, createReplyJournalHistoryPlugin } from "../src/conversations/reply-journal.js";
import { ChannelResources } from "../src/resources/index.js";

type Call = { toolName: string; input: object };

function mainModel(steps: Call[]) {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const call = steps[index];
      if (!call) throw new Error("unexpected model request");
      const id = `call-${index++}`;
      const input = JSON.stringify(call.input);
      return {
        stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([
          { type: "stream-start", warnings: [] },
          { type: "tool-input-start", id, toolName: call.toolName },
          { type: "tool-input-delta", id, delta: input },
          { type: "tool-input-end", id },
          { type: "tool-call", toolCallId: id, toolName: call.toolName, input },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          },
        ]),
      };
    },
  });
}

describe("actual SDK classified chat collection to modern reply", () => {
  it.each([
    { mode: "native" as const, manage: false },
    { mode: "vision" as const, manage: false },
    { mode: "describe_image" as const, manage: false },
    { mode: "native" as const, manage: true },
  ])("completed $mode -> classified save -> manage=$manage -> search -> exact-ID mixed send without sticker preview", async ({ mode, manage }) => {
    const dir = await mkdtemp(join(tmpdir(), "collection-agent-"));
    const projection = new EphemeralImageProjectionStore();
    const resources = new ChannelResources(dir, mode === "native");
    const assetId = await resources.assets.put(pngBytes);
    const uri = `asset://${assetId}`;
    const model = mainModel([
      { toolName: mode === "describe_image" ? "describe_image" : "read", input: { uri, ...(mode === "describe_image" ? { question: "what" } : {}) } },
      { toolName: "sticker_steal", input: { asset_id: assetId, category: "happy" } },
      ...(manage
        ? [
            { toolName: "sticker_manage", input: { action: "move", sticker_id: stickerId, category: "joy" } },
            { toolName: "sticker_manage", input: { action: "rename_category", source_category: "joy", category: "renamed" } },
            { toolName: "sticker_manage", input: { action: "merge_category", source_category: "renamed", category: "final" } },
          ]
        : []),
      { toolName: "sticker_search", input: { category: manage ? "final" : "happy" } },
      {
        toolName: "send_message",
        input: {
          parts: [
            { kind: "text", text: "before" },
            { kind: "sticker", sticker_id: stickerId },
            { kind: "text", text: "after" },
          ],
        },
      },
    ]);
    const vision = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: "actual red and blue image" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      }),
    });
    const policy: ReadImagePolicy = mode === "native" ? { mode: "native" } : { mode: "vision", visionModel: vision };
    const store = new StickerStore(createMemoryModel<StickerRow>() as never, new StickerFileStore(dir, "stickers"));
    await store.ensure();
    const classifier = { classify: vi.fn(async () => ({ category: "forbidden", tags: [] })) };
    const slot = new StickerSendSlot();
    const gate = new StickerPreviewGate();
    let sends = 0;
    const sendMessage = vi.fn(async (_channel: string, _elements: unknown[]) => [`platform-${++sends}`]);
    const delivery = new StickerDeliveryService({
      store,
      scope,
      config,
      sendSlot: slot,
      previewGate: gate,
      sender: { send: async () => {}, sendWithProof: () => sendMessage(scope.channelId, [{ type: "img" }]) },
    });
    let agent!: Agent;
    let invocations = 0;
    const reply = createReplyTools({
      bot: { platform: "test", sendMessage } as never,
      channelId: scope.channelId,
      resources,
      pacing: { charactersPerSecond: 1000, maxTotalDelayMs: 0 },
      innerThought: false,
      sticker: {
        revision: 1,
        status: (turnId) => delivery.status(turnId),
        catalog: () => delivery.catalog(),
        view: (turnId, messages) => delivery.view(turnId, messages),
        isViewCurrent: (view, turnId) => delivery.isViewCurrent(view, turnId),
        preflight: (input) => delivery.preflight(input),
      },
      journal: {
        begin: (input) =>
          beginReplyJournal({
            ...input,
            invocationId: `invocation-${++invocations}`,
            sessionId: "session",
            generation: 1,
            sink: { append: (entry) => agent.storage.append(entry).then(() => {}) },
          }),
      },
    });
    const tools = createStickerTools({
      store,
      classifier,
      sender: { send: async () => {} },
      assets: resources.assets,
      scope,
      config: { ...config, enableManage: manage },
      sendSlot: slot,
      previewGate: gate,
      delivery,
    });
    agent = createAgent({
      model,
      tools: [
        ...reply.tools,
        ...tools.filter((tool) => tool.name !== "sticker_send"),
        createReadTool(resources, policy, projection),
        ...(mode === "describe_image" ? [createDescribeImageTool(vision, resources)] : []),
      ],
      requireTerminalTool: true,
      plugins: [
        createReplyJournalHistoryPlugin(),
        {
          name: "lifecycle",
          onTurnFinish: async (_result, context) => {
            delivery.finishTurn(context.turnId);
            await reply.finishTurn(context.turnId);
          },
        },
      ],
    });
    try {
      const events: string[] = [];
      for await (const event of agent.run(createUserMessage(`chat image ${uri}`))) events.push(event.type);
      await agent.wait();
      expect(events).toContain("turn.done");
      expect(events).not.toContain("turn.failed");
      expect(model.doStreamCalls).toHaveLength(manage ? 7 : 4);
      expect(sendMessage.mock.calls.map((call) => (call[1][0] as { type: string }).type)).toEqual(["text", "img", "text"]);
      expect(await store.get("global", stickerId)).toMatchObject({ category: manage ? "final" : "happy", source: { kind: "steal" }, usageCount: 1 });
      expect(classifier.classify).not.toHaveBeenCalled();
      expect(vision.doGenerateCalls).toHaveLength(mode === "native" ? 0 : 1);
      const history = JSON.stringify(await agent.storage.read());
      expect(history).not.toContain('"type":"image-data"');
      expect(history).toContain("platform-2");
    } finally {
      await agent.stop();
      reply.invalidate();
      delivery.stop();
      projection.clearAll();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
