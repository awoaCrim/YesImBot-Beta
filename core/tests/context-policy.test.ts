import { AgentRequestProjection } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { contextCandidates, contextPressure, selectContextTiers } from "../src/runtimes/context-policy.js";

describe("Magic context policy", () => {
  it("triggers ordinary work only at 100000 measured main input tokens", () => {
    expect(contextPressure(undefined, 110000, 200000).ordinary).toBe(false);
    expect(contextPressure(NaN, 110000, 200000).ordinary).toBe(false);
    expect(contextPressure(99999, 110000, 200000).ordinary).toBe(false);
    expect(contextPressure(100000, 110000, 200000)).toMatchObject({ ordinary: true, emergency: false, target: 80000 });
  });
  it("uses safe capacity for 95% and predicted overflow, including smaller windows", () => {
    expect(contextPressure(37999, 39000, 40000).emergency).toBe(false);
    expect(contextPressure(38000, 39000, 40000)).toMatchObject({ emergency: true, unsafe: false, target: 32000 });
    expect(contextPressure(undefined, 40001, 40000)).toMatchObject({ emergency: true, unsafe: true, ordinary: false });
  });
  it("protects token-sized recent tail, current sources, unknown units and complete tool pairs", () => {
    const projection = new AgentRequestProjection();
    const messages: ModelMessage[] = Array.from({ length: 40 }, (_, index) => ({ role: "user", content: `${index}:` + "x".repeat(2000) }));
    messages.forEach((message, index) => projection.register(message, { kind: "history", sourceEntryIds: [`id${index}`], timestamp: index }));
    const call: ModelMessage = { role: "assistant", content: [{ type: "tool-call", toolCallId: "t", toolName: "read", input: {} }] };
    const result: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "t", toolName: "read", output: { type: "text", value: "x" } }] };
    projection.register(call, { kind: "history", sourceEntryIds: ["call"] });
    projection.register(result, { kind: "live", sourceEntryIds: ["result"] });
    messages.unshift(call, result, { role: "user", content: "unknown" });
    const batches = contextCandidates({ messages, projection, currentMessageIds: ["id0"] }, new Set(["id1"]), 100000, 1);
    const ids = batches.flat();
    expect(ids).not.toContain("id0");
    expect(ids).not.toContain("id1");
    expect(ids).not.toContain("call");
    expect(ids).not.toContain("result");
    expect(ids).not.toContain("id39");
    expect(ids).toContain("id2");
    expect(new Set(ids).size).toBe(ids.length);
    expect(batches.length).toBeGreaterThan(1);
  });
  it("shrinks the recent tail when mandatory current content consumes the safety capacity", () => {
    const projection = new AgentRequestProjection();
    const messages: ModelMessage[] = Array.from({ length: 20 }, (_, index) => {
      const message: ModelMessage = { role: "user", content: "x".repeat(1000) };
      projection.register(message, { kind: "history", sourceEntryIds: [String(index)], timestamp: index });
      return message;
    });
    const current: ModelMessage = { role: "user", content: "x".repeat(75000) };
    projection.register(current, { kind: "live", sourceEntryIds: ["current"] });
    messages.push(current);
    const candidates = contextCandidates({ messages, projection, currentMessageIds: ["current"] }, new Set(), 89000, 1).flat();
    expect(candidates.length).toBeGreaterThanOrEqual(15);
    expect(candidates).not.toContain("current");
  });
  it("does not make short history a candidate merely because it exceeds twenty messages", () => {
    const projection = new AgentRequestProjection();
    const messages: ModelMessage[] = Array.from({ length: 50 }, (_, index) => {
      const message: ModelMessage = { role: "user", content: String(index) };
      projection.register(message, { kind: "history", sourceEntryIds: [String(index)] });
      return message;
    });
    expect(contextCandidates({ messages, projection, currentMessageIds: [] }, new Set(), 200000, 0.25)).toEqual([]);
  });
  it("decays deterministically using newer-region count, importance and summary-only pressure", () => {
    const regions = Array.from({ length: 40 }, (_, index) => ({
      id: String(index),
      data: { importance: index === 0 ? 1 : 0, tiers: { P1: "a".repeat(1000), P2: "b".repeat(500), P3: "c".repeat(200), P4: "d".repeat(50) } },
    }));
    const ample = selectContextTiers(regions, 100000, 1);
    expect(ample.get("39")).toBe("P1");
    expect(ample.get("0")).not.toBeNull();
    expect(ample.get("1")).toBeNull();
    expect(selectContextTiers(regions, 100000, 1)).toEqual(ample);
    const pressured = selectContextTiers(regions, 0, 1);
    expect([...pressured.values()].every((tier) => tier === null)).toBe(true);
    expect(regions[0]!.data.tiers.P1).toHaveLength(1000);
  });
});
