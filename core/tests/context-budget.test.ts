import { AgentRequestProjection } from "@yesimbot/agent-runtime";
import { jsonSchema, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { estimateContextBase, estimateContextMessage, estimateContextValue, planContextRequest, resolveContextBudget } from "../src/runtimes/context-budget.js";

const budget = () => resolveContextBudget({ contextWindow: 20_000, outputReserveTokens: 1000, pageTokenBudget: 1024 }, "compartment");
function optional(
  projection: AgentRequestProjection,
  text: string,
  id: string,
  kind: "history" | "summary" | "loaded" | "recall" = "history",
  timestamp = 1,
): ModelMessage {
  const message: ModelMessage = { role: "user", content: text };
  projection.register(message, { kind, sourceEntryIds: [id], timestamp, ...(kind === "loaded" ? { blockId: id } : {}) });
  return message;
}

describe("request budget", () => {
  it("resolves only explicit limits, reserves output and margin, and caps history", () => {
    expect(resolveContextBudget({}, "compartment", { context: 200_000, output: 4000 })).toMatchObject({
      contextWindow: 200_000,
      outputTokens: 4000,
      marginTokens: 20_000,
      inputTokens: 176_000,
      historyTokens: 20_000,
    });
    expect(resolveContextBudget({ contextWindow: 20_000, pageTokenBudget: 1024 }, "compartment", { context: 40_000, output: 2000 })).toMatchObject({
      contextWindow: 20_000,
      outputTokens: 2000,
    });
  });
  it.each([
    {},
    { contextWindow: Infinity },
    { contextWindow: 1 },
    { contextWindow: 20_000, historyBudgetPercentage: NaN },
    { contextWindow: 20_000, pageTokenBudget: 5000 },
    { contextWindow: 50_000, maxLoadedBlocks: 5 },
    { contextWindow: 50_000, retainTurns: 3 },
  ])("rejects invalid configuration %j", (config) => {
    expect(() => resolveContextBudget(config, "compartment")).toThrow("InvalidContextBudget");
  });
  it("accepts a positive fractional history percentage when its effective page/history budgets fit", () => {
    expect(resolveContextBudget({ contextWindow: 200_000, historyBudgetPercentage: 0.5, pageTokenBudget: 512 }, "compartment")).toMatchObject({
      historyTokens: 859,
      pageTokens: 512,
    });
    expect(() => resolveContextBudget({ contextWindow: 200_000, historyBudgetPercentage: 0 }, "compartment")).toThrow("InvalidContextBudget");
  });
  it("does not silently enable a budget in summary mode", () => {
    expect(() => resolveContextBudget({ contextWindow: 20_000 }, "summary")).toThrow("InvalidContextBudget");
  });
  it("includes UTF-8, framing, system, tool schema and extension arguments", async () => {
    expect(estimateContextValue("中文")).toBe(8);
    expect(estimateContextMessage({ role: "user", content: "中文" })).toBeGreaterThan(32 + 8);
    const empty = await estimateContextBase({ system: [], tools: {}, toolChoice: "auto" });
    const full = await estimateContextBase({
      system: ["system"],
      tools: {
        inspect: {
          description: "details",
          inputSchema: jsonSchema({ type: "object", properties: { value: { type: "string", description: "x".repeat(2000) } } }),
        },
      },
      toolChoice: "auto",
    });
    expect(full - empty).toBeGreaterThan(2000);
  });
  it("never estimates media using payload length and requires explicit reserve", () => {
    const image = { type: "image", image: new Uint8Array(100_000) };
    expect(() => estimateContextValue(image)).toThrow("UnsupportedBudgetMedia");
    expect(estimateContextValue(image, 2000)).toBe(estimateContextValue({ type: "image", image: new Uint8Array(1) }, 2000));
    expect(() => estimateContextValue(new Uint8Array(10), 2000)).toThrow("UnsupportedBudgetMedia");
    expect(estimateContextValue({ ...image, providerOptions: { extension: "x".repeat(5000) } }, 2000)).toBeGreaterThan(7000);
  });
  it("reduces history on the first request without provider usage, preserving current and unknown additions", () => {
    const projection = new AgentRequestProjection();
    const old = Array.from({ length: 100 }, (_, index) => optional(projection, "历史".repeat(100), String(index), "history", index));
    const live: ModelMessage = { role: "user", content: "current" };
    projection.register(live, { kind: "live", sourceEntryIds: ["live"] });
    const plugin: ModelMessage = { role: "assistant", content: "plugin" };
    const plan = planContextRequest({ messages: [...old, live, plugin], projection }, budget(), 1000);
    expect(plan.messages).toContain(live);
    expect(plan.messages).toContain(plugin);
    expect(plan.messages).not.toContain(old[0]);
    expect(plan.messages).toContain(old.at(-1));
    expect(plan.optionalTokens).toBeLessThanOrEqual(budget().historyTokens);
    expect(plan.estimatedInputTokens).toBeLessThanOrEqual(budget().inputTokens);
  });
  it("removes recall, loaded, history then summaries and reports evicted blocks", () => {
    const projection = new AgentRequestProjection();
    const messages = ["recall", "loaded", "history", "summary"].map((kind) => optional(projection, "x".repeat(1500), kind, kind as "history"));
    const plan = planContextRequest({ messages, projection }, { ...budget(), historyTokens: 1700 }, 128);
    expect(plan.messages).toEqual([messages[3]]);
    expect(plan.evictedBlockIds).toEqual(["loaded"]);
  });
  it("counts protected context-tool directory receipts against the same history budget without deleting the active chain", () => {
    const projection = new AgentRequestProjection();
    const result: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "directory", toolName: "ctx_blocks", output: { type: "json", value: { blocks: "x".repeat(1000) } } }],
    };
    projection.register(result, { kind: "live", sourceEntryIds: ["result"] });
    const history = optional(projection, "old".repeat(1000), "old");
    const small = { ...budget(), historyTokens: 2000 };
    const plan = planContextRequest({ messages: [history, result], projection }, small, 128);
    expect(plan.messages).toEqual([result]);
    expect(plan.mandatoryHistoryTokens).toBeGreaterThan(1000);
    expect(plan.estimatedHistoryTokens).toBeLessThanOrEqual(small.historyTokens);
    expect(() => planContextRequest({ messages: [result], projection }, { ...small, historyTokens: 100 }, 128)).toThrow("ContextBudgetExceeded");
  });
  it("groups complete historical tool chains and all fan-out from one entry atomically", () => {
    const projection = new AgentRequestProjection();
    const call: ModelMessage = { role: "assistant", content: [{ type: "tool-call", toolCallId: "call", toolName: "inspect", input: {} }] };
    const result: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call", toolName: "inspect", output: { type: "text", value: "result" } }],
    };
    const fanout = optional(projection, "fanout", "call-source");
    projection.register(call, { kind: "history", sourceEntryIds: ["call-source"] });
    projection.register(result, { kind: "history", sourceEntryIds: ["result-source"] });
    expect(planContextRequest({ messages: [call, fanout, result], projection }, { ...budget(), historyTokens: 1 }, 128).messages).toEqual([]);
    projection.register(result, { kind: "live", sourceEntryIds: ["result-source"] });
    expect(planContextRequest({ messages: [call, fanout, result], projection }, { ...budget(), historyTokens: 1 }, 128).messages).toEqual([
      call,
      fanout,
      result,
    ]);
  });
  it("protects malformed tool pairs, in-place mutations and unknown clones", () => {
    const projection = new AgentRequestProjection();
    const call: ModelMessage = { role: "assistant", content: [{ type: "tool-call", toolCallId: "orphan", toolName: "inspect", input: {} }] };
    projection.register(call, { kind: "history", sourceEntryIds: ["old"] });
    const mutated = optional(projection, "old", "mutated");
    mutated.content = "plugin rewrote this";
    const clone = { ...optional(projection, "clone", "cloned") };
    expect(planContextRequest({ messages: [call, mutated, clone], projection }, { ...budget(), historyTokens: 1 }, 128).messages).toEqual([
      call,
      mutated,
      clone,
    ]);
  });
  it("refuses mandatory overflow rather than truncating current input", () => {
    expect(() => planContextRequest({ messages: [{ role: "user", content: "x".repeat(30_000) }] }, budget(), 128)).toThrow("ContextBudgetExceeded");
  });
  it("calibration only increases estimated costs", () => {
    const projection = new AgentRequestProjection();
    const messages = [optional(projection, "x".repeat(2000), "old")];
    const plan = planContextRequest({ messages, projection }, budget(), 128, 3);
    expect(plan.messages).toEqual([]);
    expect(plan.estimatedInputTokens).toBe(384);
  });
});
