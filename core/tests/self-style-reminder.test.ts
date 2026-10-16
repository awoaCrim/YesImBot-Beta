import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import {
  AgentRequestProjection,
  createAgent,
  createAgentChannel,
  createMemoryStorage,
  createStateManager,
  createUserMessage,
  type PrepareStepContext,
} from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";
import { h } from "koishi";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("koishi", async () => import("@koishijs/core"));

import { Conversation } from "../src/conversations/index.js";
import { createMessage } from "../src/messages/index.js";
import { createModelInputPlugin } from "../src/runtimes/channel.js";
import { ContextWorkspace } from "../src/runtimes/context-workspace.js";
import { createSelfStyleReminderPlugin } from "../src/runtimes/prompt.js";
import { defaultMessageRecord } from "./helpers/index.js";

function context(projection?: AgentRequestProjection): PrepareStepContext {
  return {
    runtime: { id: "self-style-reminder-unit" },
    channel: createAgentChannel(),
    state: createStateManager({ storage: createMemoryStorage() }),
    turnId: "turn",
    stepNumber: 0,
    ...(projection ? { projection } : {}),
  };
}

function model() {
  return {
    specificationVersion: "v3" as const,
    provider: "synthetic",
    modelId: "synthetic",
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  };
}

describe("request-only self-style reminder", () => {
  it("keeps the tested text and appends mandatory source-free provenance without changing original objects", async () => {
    const plugin = createSelfStyleReminderPlugin();
    const projection = new AgentRequestProjection();
    const messages: ModelMessage[] = [
      { role: "system", content: "SYSTEM_AND_PERSONA" },
      { role: "user", content: "REAL_CURRENT" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "signed-call",
            toolName: "lookup",
            input: {},
            providerOptions: { google: { thoughtSignature: "synthetic-signature" } },
          },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "signed-call", toolName: "lookup", output: { type: "text", value: "REAL_TOOL_RESULT" } }],
      },
    ];
    const before = structuredClone(messages);
    const prepared = await plugin.prepareStep!(messages, context(projection));
    expect(plugin.enforce).toBe("post");
    expect(prepared).toHaveLength(messages.length + 1);
    expect(prepared!.slice(0, -1)).toEqual(before);
    messages.forEach((message, index) => expect(prepared![index]).toBe(message));
    expect(messages).toEqual(before);
    const reminder = prepared!.at(-1)!;
    expect(reminder.role).toBe("user");
    expect(typeof reminder.content).toBe("string");
    expect(createHash("sha256").update(String(reminder.content)).digest("hex")).toBe("7ecc9b0d2f1af61f185ca14e29ecbea88ff43de753c908b1422d824c0d7cd52d");
    expect(projection.origin(reminder)).toEqual({ kind: "mandatory", sourceEntryIds: [] });
    expect(JSON.stringify(reminder)).not.toMatch(/sourceEntryIds|timestamp|thoughtSignature|functionCall/);
  });

  it("reuses only its own object across steps and retains genuine identical speech", async () => {
    const plugin = createSelfStyleReminderPlugin();
    const initial = await plugin.prepareStep!([], context());
    const owned = initial![0]!;
    const genuine: ModelMessage = structuredClone(owned);
    const tail: ModelMessage = { role: "user", content: "NEXT_REAL_INPUT" };
    const source = [owned, genuine, owned, tail];
    const prepared = await plugin.prepareStep!(source, { ...context(), stepNumber: 1 });
    expect(source).toEqual([owned, genuine, owned, tail]);
    expect(prepared).toEqual([genuine, tail, owned]);
    expect(prepared![0]).toBe(genuine);
    expect(prepared!.at(-1)).toBe(owned);
    const again = await plugin.prepareStep!(prepared!, { ...context(), stepNumber: 2 });
    expect(again).toEqual(prepared);
    expect(again!.filter((message) => message === owned)).toHaveLength(1);
    const other = await createSelfStyleReminderPlugin().prepareStep!([], context());
    expect(other![0]).not.toBe(owned);
    expect(other![0]).toEqual(owned);
  });

  it("reinserts one reminder through actual Agent guard rebuilds without storing it", async () => {
    const projection = new AgentRequestProjection();
    const storage = createMemoryStorage();
    const fake = model();
    const captured: Array<readonly ModelMessage[]> = [];
    const agent = createAgent({
      id: "self-style-rebuild",
      plugins: [createSelfStyleReminderPlugin()],
      model: fake as never,
      storage,
      requestProjection: projection,
      maxRetries: 0,
      beforeModelRequest: async (request) => {
        const first = await request.rebuildMessages();
        const second = await request.rebuildMessages();
        const owned = request.messages.at(-1)!;
        expect(first).toEqual(request.messages);
        expect(second).toEqual(first);
        expect(first.at(-1)).toBe(owned);
        expect(second.filter((message) => message === owned)).toHaveLength(1);
        expect(projection.origin(owned)).toEqual({ kind: "mandatory", sourceEntryIds: [] });
        captured.push(second);
        throw new Error("captured before any provider transport");
      },
    });
    try {
      await agent.init();
      for await (const _event of agent.run(createUserMessage("REAL_CURRENT"))) {
        // Consume the intentionally blocked turn.
      }
      expect(captured).toHaveLength(1);
      expect(fake.doStream).not.toHaveBeenCalled();
      const stored = JSON.stringify(await storage.read());
      expect(stored).toContain("REAL_CURRENT");
      expect(stored).not.toContain("本次请求的表达约束");
    } finally {
      await agent.stop();
    }
  });

  it("keeps the admitted Core input marked through actual SDK tool steps and guard rebuilds", async () => {
    const storage = createMemoryStorage();
    const fake = model();
    const prompts: LanguageModelV3CallOptions["prompt"][] = [];
    fake.doStream.mockImplementation(async (options: LanguageModelV3CallOptions) => {
      const toolName = prompts.length === 0 ? "lookup" : "finish";
      prompts.push(options.prompt);
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "tool-call", toolCallId: `guard-call-${prompts.length}`, toolName, input: "{}" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 0, reasoning: 0 } },
            });
            controller.close();
          },
        }),
      };
    });
    const current = createMessage(defaultMessageRecord({ messageId: "guard-current", elements: [h.text("GUARD_CURRENT")] }));
    const other = createMessage(defaultMessageRecord({ messageId: "guard-unscoped", user: { id: "other" }, elements: [h.text("UNSCOPED_NOT_CURRENT")] }));
    let appended = false;
    const rebuilt: Array<readonly ModelMessage[]> = [];
    const agent = createAgent({
      model: fake as never,
      storage,
      plugins: [createModelInputPlugin(), createSelfStyleReminderPlugin()],
      tools: [
        { name: "lookup", inputSchema: z.object({}), execute: async () => ({ value: "GUARD_LOOKUP_RESULT" }) },
        { name: "finish", inputSchema: z.object({}), terminal: true, execute: async () => ({ ok: true }) },
      ],
      requireTerminalTool: true,
      maxRetries: 0,
      beforeModelRequest: async (request) => {
        if (!appended) {
          appended = true;
          await agent.append(other);
        }
        const first = await request.rebuildMessages();
        const second = await request.rebuildMessages();
        expect(second).toEqual(first);
        rebuilt.push(second);
        return second;
      },
    });
    try {
      const events = await Array.fromAsync(agent.run(current));
      expect(events.some((event) => event.type === "turn.failed")).toBe(false);
      expect(prompts).toHaveLength(2);
      expect(rebuilt).toHaveLength(2);
      for (const prompt of prompts) {
        const text = prompt
          .flatMap((message) =>
            typeof message.content === "string" ? [message.content] : message.content.filter((part) => part.type === "text").map((part) => part.text),
          )
          .join("\n");
        expect([...text.matchAll(/\[CURRENT_MESSAGE\]\n([\s\S]*?)\n\[\/CURRENT_MESSAGE\]/g)].map((match) => match[1])).toEqual(["GUARD_CURRENT"]);
        expect(text).toContain('id="guard-current"');
        expect(text).toContain("UNSCOPED_NOT_CURRENT");
        expect(text.split("本次请求的表达约束")).toHaveLength(2);
      }
      expect(JSON.stringify(prompts[1])).toContain("GUARD_LOOKUP_RESULT");
      const stored = JSON.stringify(await storage.read());
      expect(stored).not.toMatch(/本次请求的表达约束|activeInputs/);
    } finally {
      await agent.stop();
    }
  });

  it("counts the fixed reminder before Magic admission and preserves mandatory overflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-self-style-budget-"));
    const conversation = new Conversation(root, { minMessages: 1, maxFailures: 1, mode: "compartment" }, { magicContext: true });
    const projection = new AgentRequestProjection();
    const fake = model();
    await conversation.init();
    const workspace = new ContextWorkspace(conversation, projection, {
      config: { contextWindow: 2000, outputReserveTokens: 128, pageTokenBudget: 128 },
      compactMode: "compartment",
      model: fake as never,
    });
    try {
      workspace.capture([]);
      const current: ModelMessage = { role: "user", content: "x".repeat(2700) };
      projection.register(current, { kind: "live", sourceEntryIds: [] });
      const request = {
        model: fake as never,
        system: "SYSTEM",
        messages: [current],
        tools: {},
        currentMessageIds: [],
        projection,
        historyMode: "conversation" as const,
        turnId: "budget-turn",
        stepNumber: 0,
        signal: new AbortController().signal,
        rebuildMessages: async () => [current],
      };
      await expect(workspace.guard(request)).resolves.toEqual([current]);
      const messages = await createSelfStyleReminderPlugin().prepareStep!([current], context(projection));
      await expect(workspace.guard({ ...request, messages: messages!, rebuildMessages: async () => messages! })).rejects.toThrow("ContextBudgetExceeded");
      expect(fake.doGenerate).not.toHaveBeenCalled();
      expect(fake.doStream).not.toHaveBeenCalled();
      expect(await conversation.storage.read()).toEqual([]);
      expect(await conversation.contextRegions()).toEqual([]);
    } finally {
      workspace.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
