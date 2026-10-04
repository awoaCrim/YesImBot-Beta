import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { estimateContextMessage } from "../src/runtimes/context-budget.js";
import { contextCostTokens, measureContextMessages, UNMEASURED_TOOL_TOKEN_RATIO } from "../src/runtimes/context-estimator.js";

function result(text = "PRIVATE tool body", id = "call"): ModelMessage {
  return { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "lookup", output: { type: "json", value: { text } } }] };
}

describe("provisional tool-result costs", () => {
  it("charges only unmeasured tool text at its own floor, without inflating ordinary history", () => {
    const history: ModelMessage = { role: "user", content: "history".repeat(1000) };
    const tool = result("网页结果".repeat(8000));
    const measured = measureContextMessages([history, tool]);
    expect(measured.bytes).toBe(estimateContextMessage(history) + estimateContextMessage(tool));
    expect(measured.unmeasuredToolBytes).toBe(estimateContextMessage(tool));
    expect(contextCostTokens(measured, 0.2)).toBeCloseTo(estimateContextMessage(history) * 0.2 + estimateContextMessage(tool) * 0.5);
    expect(UNMEASURED_TOOL_TOKEN_RATIO).toBe(0.5);
  });

  it("releases the premium only for unchanged material present in an accepted snapshot", () => {
    const message = result();
    const first = measureContextMessages([message]);
    const repeated = measureContextMessages([structuredClone(message)], first.toolResults);
    expect(repeated.unmeasuredToolBytes).toBe(0);
    expect(contextCostTokens(repeated, 0.23)).toBe(repeated.bytes * 0.23);
    expect(measureContextMessages([message]).unmeasuredToolBytes).toBe(first.bytes);
    const serialized = JSON.stringify([...first.toolResults]);
    expect(serialized).not.toContain("PRIVATE");
    expect([...first.toolResults.keys()][0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not trust equal-size changed text, reused objects, or new call IDs", () => {
    const original = result("AAAA");
    const first = measureContextMessages([original]);
    const changed = result("BBBB");
    expect(estimateContextMessage(changed)).toBe(estimateContextMessage(original));
    expect(measureContextMessages([changed], first.toolResults).unmeasuredToolBytes).toBe(first.bytes);
    expect(measureContextMessages([result("AAAA", "new-call")], first.toolResults).unmeasuredToolBytes).toBeGreaterThan(0);
    if (original.role !== "tool") throw new Error("Expected tool");
    original.content[0] = { type: "tool-result", toolCallId: "call", toolName: "lookup", output: { type: "text", value: "mutated" } };
    expect(measureContextMessages([original], first.toolResults).unmeasuredToolBytes).toBeGreaterThan(0);
  });

  it("uses occurrence counts, not a set that would exempt all copies", () => {
    const message = result();
    const once = measureContextMessages([message]);
    const twice = measureContextMessages([message, structuredClone(message)], once.toolResults);
    expect(twice.unmeasuredToolBytes).toBe(once.bytes);
    expect([...twice.toolResults.values()]).toEqual([2]);
    expect(measureContextMessages([message, message], twice.toolResults).unmeasuredToolBytes).toBe(0);
    expect(measureContextMessages([message], twice.toolResults).unmeasuredToolBytes).toBe(0);
    expect([...once.toolResults.values()]).toEqual([1]); // Measuring never consumes the stored sample.
  });

  it("canonicalizes object key order without keeping the source object", () => {
    const first: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c", toolName: "x", output: { type: "json", value: { a: 1, b: 2 } } }],
    };
    const reordered: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c", toolName: "x", output: { type: "json", value: { b: 2, a: 1 } } }],
    };
    expect(measureContextMessages([reordered], measureContextMessages([first]).toolResults).unmeasuredToolBytes).toBe(0);
  });

  it("bounds retained signatures and conservatively charges overflow", () => {
    const messages = Array.from({ length: 2049 }, (_, index) => result("body", String(index)));
    const first = measureContextMessages(messages);
    expect(first.toolResults.size).toBe(2048);
    const again = measureContextMessages(messages, first.toolResults);
    expect(again.unmeasuredToolBytes).toBe(estimateContextMessage(messages[2048]!));
    expect(again.toolResults.size).toBe(2048);
  });

  it("never serializes native media bodies into token costs or treats them as known text", () => {
    const media = (size: number): ModelMessage => ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "image",
          toolName: "read",
          output: { type: "content", value: [{ type: "image-data", data: "A".repeat(size), mediaType: "image/png" }] },
        },
      ],
    });
    const small = measureContextMessages([media(4)]);
    const large = measureContextMessages([media(1000000)], small.toolResults);
    expect(large.bytes).toBe(small.bytes);
    expect(large.bytes).toBeLessThan(1000);
    expect(large.toolResults.size).toBe(0);
    expect(large.unmeasuredToolBytes).toBe(large.bytes);
  });

  it("does not lower a measured density above the provisional floor", () => {
    const measured = measureContextMessages([result()]);
    expect(contextCostTokens(measured, 0.8)).toBe(measured.bytes * 0.8);
  });

  it("does not recursively mark model-authored JSON text as a tool result", () => {
    const text: ModelMessage = { role: "user", content: JSON.stringify(result()) };
    const measured = measureContextMessages([text]);
    expect(measured.unmeasuredToolBytes).toBe(0);
    expect(measured.toolResults.size).toBe(0);
  });
});
