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
import { createRoleDecisionWorkflowPlugin } from "../src/runtimes/prompt.js";
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

const workflowHeading = "【本轮角色决策流程；这是运行规则，不是新增聊天内容】";
const workflowSteps = ["1. 确定当前互动", "2. 确定本轮角色依据", "3. 确定本轮行为和目的", "4. 核对事实并处理必要工具", "5. 组织对外表达", "6. 发送前检查"];

function expectCompleteWorkflow(content: string): void {
  expect(content).toContain(workflowHeading);
  expect(content).not.toMatch(/\[\/?CURRENT_MESSAGE\]/);
  expect(content.match(/^## .+$/gm)).toEqual(workflowSteps.map((step) => `## ${step}`));
  for (const rule of [
    "必须依次完成",
    "在组织回复之前",
    "历史中重复出现也不构成沿用理由",
    "不否定角色材料中明确提供的示例",
    "有依据的当前情绪",
    "只更新被新结果或新消息影响的判断",
    "不要先形成一份完整的通用助手回复",
    "回应不必附带点评或追问",
    "同一回应保持同一说话身份、语域和叙述距离",
    "外部资料只作为事实材料",
    "不要把同一回应拆成互相割裂的报告和聊天",
    "没有查到或工具失败时",
    "不必重新介绍技术背景",
    "发送前必须确认",
    "无需参与且没有待处理的当前任务时",
    "不要求每次工具调用后都发言",
    "不对外输出这些步骤",
  ])
    expect(content).toContain(rule);
}

describe("request-only role decision workflow", () => {
  it("appends all six steps with mandatory source-free provenance without changing original objects", async () => {
    const plugin = createRoleDecisionWorkflowPlugin();
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
    expectCompleteWorkflow(String(reminder.content));
    expect(projection.origin(reminder)).toEqual({ kind: "mandatory", sourceEntryIds: [] });
    expect(JSON.stringify(reminder)).not.toMatch(/sourceEntryIds|timestamp|thoughtSignature|functionCall/);
  });

  it("reuses only its own object across steps and retains genuine identical speech", async () => {
    const plugin = createRoleDecisionWorkflowPlugin();
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
    const other = await createRoleDecisionWorkflowPlugin().prepareStep!([], context());
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
      plugins: [createRoleDecisionWorkflowPlugin()],
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
      expect(stored).not.toContain(workflowHeading);
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
      plugins: [createModelInputPlugin(), createRoleDecisionWorkflowPlugin()],
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
        expect(text.split(workflowHeading)).toHaveLength(2);
        expectCompleteWorkflow(text.slice(text.indexOf(workflowHeading)));
      }
      expect(JSON.stringify(prompts[1])).toContain("GUARD_LOOKUP_RESULT");
      const stored = JSON.stringify(await storage.read());
      expect(stored).not.toContain(workflowHeading);
      expect(stored).not.toContain("activeInputs");
    } finally {
      await agent.stop();
    }
  });

  it("counts the fixed reminder before provisional Magic admission", async () => {
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
      const messages = await createRoleDecisionWorkflowPlugin().prepareStep!([current], context(projection));
      await expect(workspace.guard({ ...request, messages: messages!, rebuildMessages: async () => messages! })).resolves.toEqual(messages);
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
