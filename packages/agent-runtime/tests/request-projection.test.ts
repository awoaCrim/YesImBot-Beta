import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { jsonSchema, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { createAgent, type Agent, type AgentModelRequestContext } from "../src/agent.js";
import { createEntry } from "../src/entry.js";
import { createUserMessage } from "../src/message.js";
import { AgentRequestProjection } from "../src/request-projection.js";
import { createMemoryStorage } from "../src/storage.js";

function modelWithCalls(count = 0, modelId = "model") {
  const requests: LanguageModelV3CallOptions[] = [];
  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "mock",
    modelId,
    supportedUrls: {},
    async doGenerate() {
      throw new Error("unused");
    },
    async doStream(options) {
      requests.push(structuredClone(options));
      const toolStep = requests.length <= count;
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (toolStep)
              for (let i = 0; i < 2; i++)
                controller.enqueue({ type: "tool-call", toolCallId: `call_${requests.length}_${i}`, toolName: "inspect", input: "{}" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: toolStep ? "tool-calls" : "stop", raw: undefined },
              usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 0, reasoning: 0 } },
            });
            controller.close();
          },
        }),
      };
    },
  };
  return { model, requests };
}

describe("request-only projection", () => {
  it("inherits fanout and unions mixed live/history as mandatory; metadata is not serialized", () => {
    const projection = new AgentRequestProjection();
    const history: ModelMessage = { role: "user", content: "history" };
    const live: ModelMessage = { role: "user", content: "live" };
    projection.register(history, { kind: "history", sourceEntryIds: ["old"] });
    projection.register(live, { kind: "live", sourceEntryIds: ["new"] });
    const merged: ModelMessage = { role: "user", content: "history+live" };
    projection.inherit(merged, [history, live]);
    expect(projection.origin(merged)).toMatchObject({ kind: "mandatory", sourceEntryIds: ["old", "new"] });
    expect(JSON.stringify(merged)).not.toContain("sourceEntryIds");
    expect(projection.origin({ ...history })).toBeUndefined();
    history.content = "changed";
    expect(projection.origin(history)).toBeUndefined();
    projection.inherit(merged, [history]);
    expect(projection.origin(history)).toBeUndefined();
  });
  it("protects all current inputs, joined inputs and multi-tool pairs at every provider boundary", async () => {
    const projection = new AgentRequestProjection();
    const { model, requests } = modelWithCalls(2);
    const guards: AgentModelRequestContext[] = [];
    const snapshots: { ids: readonly string[]; live: ModelMessage[]; history: ModelMessage[] }[] = [];
    let joined = false;
    let agent: Agent;
    agent = createAgent({
      model,
      requestProjection: projection,
      storage: createMemoryStorage([createEntry("message", createUserMessage("OLD"), { id: "old" })]),
      tools: [
        {
          name: "inspect",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
          execute() {
            if (!joined) {
              joined = true;
              agent.send(createUserMessage("JOIN"), { ifBusy: "join" });
            }
            return { result: "current tool result" };
          },
        },
      ],
      plugins: [
        {
          name: "new-plugin-message",
          prepareStep(messages) {
            return [...messages, { role: "assistant", content: "unknown plugin" }];
          },
        },
      ],
      beforeModelRequest: async (context) => {
        guards.push(context);
        const live = context.messages.filter((message) => projection.origin(message)?.kind === "live");
        const history = context.messages.filter((message) => projection.origin(message)?.kind === "history");
        snapshots.push({ ids: context.currentMessageIds, live, history });
        expect(projection.origin(context.messages.at(-1)!)).toBeUndefined();
        return context.messages.filter((message) => projection.origin(message)?.kind !== "history");
      },
    });
    const events = await Array.fromAsync(agent.run(createUserMessage("CURRENT")));
    expect(events.at(-1)?.type).toBe("turn.done");
    expect(requests).toHaveLength(3);
    expect(guards).toHaveLength(3);
    expect(snapshots[0]!.history).toHaveLength(1);
    expect(snapshots[0]!.live).toHaveLength(1);
    expect(snapshots[2]!.ids.length).toBeGreaterThan(snapshots[0]!.ids.length);
    expect(JSON.stringify(snapshots[2]!.live)).toContain("JOIN");
    const final = requests.at(-1)!;
    const parts = final.prompt.flatMap((message) => (Array.isArray(message.content) ? message.content : []));
    const calls = parts.filter((part) => part.type === "tool-call").map((part) => part.toolCallId);
    const results = parts.filter((part) => part.type === "tool-result").map((part) => part.toolCallId);
    expect(calls).toHaveLength(4);
    expect(results.sort()).toEqual(calls.sort());
    expect(new Set(calls).size).toBe(4);
    for (const request of requests) {
      expect(JSON.stringify(request)).not.toContain("sourceEntryIds");
      expect(JSON.stringify(request)).not.toContain("OLD");
      expect(JSON.stringify(request.prompt)).toContain("CURRENT");
      expect(request.maxOutputTokens).toBeUndefined();
    }
    expect(JSON.stringify(await agent.storage.read())).not.toContain("sourceEntryIds");
  });
  it("inherits provenance for custom one-to-many model projections but not unknown prepareStep clones", async () => {
    const projection = new AgentRequestProjection();
    const { model } = modelWithCalls();
    const origin = createEntry("message", { role: "custom", type: "test", data: {}, id: "custom", timestamp: 1 }, { id: "custom-entry" });
    const agent = createAgent({
      model,
      requestProjection: projection,
      storage: createMemoryStorage([origin]),
      plugins: [
        {
          name: "custom",
          toModelMessages(message) {
            if (message.role === "custom")
              return [
                { role: "assistant", content: "fanout1" },
                { role: "assistant", content: "fanout2" },
              ];
          },
          prepareStep(messages) {
            return [...messages, { ...messages[0]! }];
          },
        },
      ],
      beforeModelRequest: async (context) => {
        expect(projection.origin(context.messages[0]!)).toMatchObject({ kind: "history", sourceEntryIds: ["custom-entry"] });
        expect(projection.origin(context.messages[1]!)).toEqual(projection.origin(context.messages[0]!));
        expect(projection.origin(context.messages.at(-1)!)).toBeUndefined();
      },
    });
    expect((await Array.fromAsync(agent.run(createUserMessage("now")))).at(-1)?.type).toBe("turn.done");
  });
  it("applies a guard-selected active tool allow-list at the provider boundary", async () => {
    const projection = new AgentRequestProjection();
    const { model, requests } = modelWithCalls();
    const agent = createAgent({
      model,
      requestProjection: projection,
      tools: [
        { name: "ctx_load", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: () => ({ ok: true }) },
        { name: "finish", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: () => ({ ok: true }) },
      ],
      beforeModelRequest: async (context) => ({ messages: context.messages, activeTools: ["finish"] }),
    });
    await Array.fromAsync(agent.run(createUserMessage("now")));
    const tools = requests[0]?.tools as readonly { name?: string }[] | undefined;
    expect(tools?.map((tool) => tool.name)).toEqual(["finish"]);
  });

  it("resolves output cap using the actually plugin-selected model and preserves disabled requests", async () => {
    const initial = modelWithCalls();
    const selected = modelWithCalls(0, "replacement");
    const agent = createAgent({
      model: initial.model,
      maxOutputTokens: (model) => (typeof model !== "string" && model.modelId === "replacement" ? 1234 : 5678),
      plugins: [
        {
          name: "select",
          init(runtime) {
            runtime.setModel(selected.model);
          },
        },
      ],
    });
    await Array.fromAsync(agent.run(createUserMessage("now")));
    expect(initial.requests).toEqual([]);
    expect(selected.requests[0]?.maxOutputTokens).toBe(1234);
  });
});
