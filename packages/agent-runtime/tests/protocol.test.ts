import type { LanguageModelV3, LanguageModelV3FinishReason, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAgent } from "../src/agent.js";
import { createUserMessage } from "../src/message.js";
import type { AgentTool, AgentToolSet } from "../src/tools.js";

const STOP = "stop" as unknown as LanguageModelV3FinishReason;
const TOOL_CALLS = "tool-calls" as unknown as LanguageModelV3FinishReason;

type ScriptedStep =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly toolName: string; readonly input: string }
  | { readonly kind: "empty" };

const USAGE = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };

function createScriptedModel(steps: readonly ScriptedStep[]) {
  let callCount = 0;
  const observedToolChoices: unknown[] = [];
  const observedPrompts: unknown[] = [];

  const model = {
    specificationVersion: "v3",
    provider: "mock-provider",
    modelId: "mock-model",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("not implemented");
    },
    async doStream(options: { toolChoice?: unknown; prompt?: unknown }) {
      observedToolChoices.push(options.toolChoice);
      observedPrompts.push(options.prompt);
      const index = callCount;
      callCount += 1;
      const step = steps[Math.min(index, steps.length - 1)] ?? { kind: "empty" };

      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (step.kind === "text") {
              controller.enqueue({ type: "text-start", id: `text_${index}` });
              controller.enqueue({ type: "text-delta", id: `text_${index}`, delta: step.text });
              controller.enqueue({ type: "text-end", id: `text_${index}` });
            }
            if (step.kind === "tool") {
              const id = `call_${index}`;
              controller.enqueue({ type: "tool-input-start", id, toolName: step.toolName });
              controller.enqueue({ type: "tool-input-delta", id, delta: step.input });
              controller.enqueue({ type: "tool-input-end", id });
              controller.enqueue({ type: "tool-call", toolCallId: id, toolName: step.toolName, input: step.input });
            }
            controller.enqueue({
              type: "finish",
              finishReason: step.kind === "tool" ? TOOL_CALLS : STOP,
              usage: USAGE,
            } as LanguageModelV3StreamPart);
            controller.close();
          },
        }),
      };
    },
    observedToolChoices,
    observedPrompts,
    get callCount() {
      return callCount;
    },
  };

  return model as unknown as LanguageModelV3 & { observedToolChoices: unknown[]; readonly callCount: number };
}

function createTerminalTools(execute = vi.fn(async () => ({ ok: true }))): { tools: AgentToolSet; execute: typeof execute } {
  const finalize: AgentTool = {
    name: "finalize",
    terminal: true,
    inputSchema: z.object({}),
    execute,
  };
  const inspect: AgentTool = { name: "inspect", inputSchema: z.object({}), execute: async () => "observed" };
  return { tools: [finalize, inspect], execute };
}

async function runTurn(agent: ReturnType<typeof createAgent>) {
  const events: string[] = [];
  let failure: { name: string; message: string } | undefined;
  for await (const event of agent.run(createUserMessage("hello"))) {
    events.push(event.type);
    if (event.type === "turn.failed") failure = event.error;
  }
  // The stream ends on the terminal event, one microtask before the turn's own cleanup finishes.
  await agent.wait();
  return { events, failure };
}

describe("agent protocol invariant", () => {
  it("passes a required tool choice to the provider only when configured", async () => {
    const required = createScriptedModel([{ kind: "tool", toolName: "finalize", input: "{}" }]);
    const requiredAgent = createAgent({ model: required, tools: createTerminalTools().tools, toolChoice: "required" });
    requiredAgent.send(createUserMessage("hello"));
    await requiredAgent.wait();

    expect(required.observedToolChoices[0]).toEqual({ type: "required" });

    const compatible = createScriptedModel([{ kind: "tool", toolName: "finalize", input: "{}" }]);
    const compatibleAgent = createAgent({ model: compatible, tools: createTerminalTools().tools });
    compatibleAgent.send(createUserMessage("hello"));
    await compatibleAgent.wait();

    expect(compatible.observedToolChoices[0]).toEqual({ type: "auto" });
  });

  it("fails a text-only turn when a terminal tool is required", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = createScriptedModel([{ kind: "text", text: "这段文本不是平台消息" }]);
    const { tools, execute } = createTerminalTools();
    const onTurnFinish = vi.fn();
    const agent = createAgent({ model, tools, requireTerminalTool: true, plugins: [{ name: "observer", onTurnFinish }] });

    try {
      const { events, failure } = await runTurn(agent);

      expect(events).not.toContain("turn.done");
      expect(events.at(-1)).toBe("turn.failed");
      expect(failure).toMatchObject({ name: "AgentProtocolError" });
      expect(failure?.message).toContain("text-only");
      expect(execute).not.toHaveBeenCalled();
      expect(model.callCount).toBe(1);
      expect(onTurnFinish).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }), expect.any(Object));

      const entries = await agent.storage.read();
      expect(entries.filter((entry) => entry.type === "event")).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ type: "turn.failed", error: expect.objectContaining({ name: "AgentProtocolError" }) }),
        }),
      ]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("repairs an intermediate-only turn with one request-only terminal step", async () => {
    const model = createScriptedModel([
      { kind: "tool", toolName: "inspect", input: "{}" },
      { kind: "empty" },
      { kind: "tool", toolName: "finalize", input: "{}" },
    ]);
    const { tools, execute } = createTerminalTools();
    const agent = createAgent({ model, tools, requireTerminalTool: true });

    const { events } = await runTurn(agent);

    expect(events).toContain("turn.done");
    expect(events).not.toContain("turn.failed");
    expect(execute).toHaveBeenCalledOnce();
    expect(model.callCount).toBe(3);
    expect(model.observedToolChoices.at(-1)).toEqual({ type: "required" });
    expect(JSON.stringify(model.observedPrompts.at(-1))).toContain("internal repair step");
    expect(JSON.stringify(await agent.storage.read())).not.toContain("internal repair step");
    expect((await agent.storage.read()).filter((entry) => entry.type === "message" && entry.data.role === "user")).toHaveLength(1);
  });

  it("preserves the protocol failure when terminal recovery also stops without a terminal tool", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = createScriptedModel([{ kind: "tool", toolName: "inspect", input: "{}" }, { kind: "empty" }, { kind: "empty" }]);
    const agent = createAgent({ model, tools: createTerminalTools().tools, requireTerminalTool: true });

    try {
      const { events, failure } = await runTurn(agent);

      expect(events).not.toContain("turn.done");
      expect(failure?.name).toBe("AgentProtocolError");
      expect(failure?.message).toContain("non-terminal-tool");
      expect(model.callCount).toBe(3);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("fails a turn that produced neither text nor a tool call", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const model = createScriptedModel([{ kind: "empty" }]);
    const agent = createAgent({ model, tools: createTerminalTools().tools, requireTerminalTool: true });

    try {
      const { events, failure } = await runTurn(agent);

      expect(events).not.toContain("turn.done");
      expect(failure?.message).toContain("empty-or-no-terminal-tool");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("accepts a terminal tool call that arrives after intermediate steps", async () => {
    const model = createScriptedModel([
      { kind: "tool", toolName: "inspect", input: "{}" },
      { kind: "tool", toolName: "finalize", input: "{}" },
    ]);
    const { tools, execute } = createTerminalTools();
    const agent = createAgent({ model, tools, requireTerminalTool: true });

    const { events } = await runTurn(agent);

    expect(events).toContain("turn.done");
    expect(events).not.toContain("turn.failed");
    expect(execute).toHaveBeenCalledOnce();
    expect(model.callCount).toBe(2);
  });

  it("keeps a predicate terminal tool with continue true non-terminal across steps", async () => {
    const continueSend = vi.fn(async () => ({ ok: true }));
    const finalize = vi.fn(async () => ({ ok: true }));
    const tools: AgentToolSet = [
      {
        name: "send_message",
        terminal: (input: { continue?: boolean }) => input.continue !== true,
        inputSchema: z.object({ continue: z.boolean().optional() }),
        execute: continueSend,
      },
      {
        name: "finalize",
        terminal: true,
        inputSchema: z.object({}),
        execute: finalize,
      },
    ];
    const model = createScriptedModel([
      { kind: "tool", toolName: "send_message", input: '{"continue":true}' },
      { kind: "tool", toolName: "finalize", input: "{}" },
    ]);
    const agent = createAgent({ model, tools, requireTerminalTool: true });

    const { events } = await runTurn(agent);

    expect(events).toContain("turn.done");
    expect(events).not.toContain("turn.failed");
    expect(continueSend).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
    expect(model.callCount).toBe(2);
  });

  it("does not accept an invalid terminal tool call as the end of a turn", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const execute = vi.fn(async () => ({ ok: true }));
    const tools: AgentToolSet = [
      {
        name: "finalize",
        terminal: true,
        inputSchema: z.object({ value: z.string() }),
        execute,
      },
    ];
    const model = createScriptedModel([{ kind: "tool", toolName: "finalize", input: "{}" }, { kind: "empty" }]);
    const agent = createAgent({ model, tools, requireTerminalTool: true });

    try {
      const { events, failure } = await runTurn(agent);

      expect(events).not.toContain("turn.done");
      expect(failure?.message).toContain("empty-or-no-terminal-tool");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("leaves intermediate-only turns untouched when a terminal tool is not required", async () => {
    const model = createScriptedModel([{ kind: "tool", toolName: "inspect", input: "{}" }, { kind: "empty" }]);
    const agent = createAgent({ model, tools: createTerminalTools().tools });

    const { events } = await runTurn(agent);

    expect(events).toContain("turn.done");
    expect(events).not.toContain("turn.failed");
    expect(model.callCount).toBe(2);
  });

  it("leaves plain text turns untouched when a terminal tool is not required", async () => {
    const model = createScriptedModel([{ kind: "text", text: "ok" }]);
    const agent = createAgent({ model, tools: createTerminalTools().tools });

    const { events } = await runTurn(agent);

    expect(events).toContain("turn.done");
    expect(events).not.toContain("turn.failed");
  });
});
