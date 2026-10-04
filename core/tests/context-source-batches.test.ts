import { AgentRequestProjection } from "@yesimbot/agent-runtime";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { contextCandidates, CONTEXT_REGION_SOURCE_BYTES } from "../src/runtimes/context-policy.js";

function sourceFixture() {
  const projection = new AgentRequestProjection();
  const messages: ModelMessage[] = [];
  const sourceCosts = new Map<string, number>();
  const append = (id: string, message: ModelMessage, safeBytes?: number) => {
    projection.register(message, { kind: "history", sourceEntryIds: [id], timestamp: messages.length });
    messages.push(message);
    if (safeBytes !== undefined) sourceCosts.set(id, safeBytes);
  };
  const publicSource = (id: string, safeBytes = 512) => append(id, { role: "user", content: `Visible dialogue ${id}` }, safeBytes);
  const toolPair = (id: string, resultBytes: number) => {
    append(`${id}-call`, { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "lookup", input: { query: "old request" } }] }, 0);
    append(
      `${id}-result`,
      { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "lookup", output: { type: "text", value: "x".repeat(resultBytes) } }] },
      0,
    );
  };
  const candidates = () => {
    // An indivisible recent public source exceeds the source cap and remains raw. Its
    // request cost fills the recent suffix allowance, making earlier units eligible.
    append("large-tail", { role: "user", content: "t".repeat(65000) }, 65000);
    return contextCandidates({ messages, projection, currentMessageIds: [] }, new Set(), 200000, 0.25, 0, sourceCosts);
  };
  return { append, publicSource, toolPair, candidates, sourceCosts };
}

describe("historian source-aware batching", () => {
  it("packs large completed tool traces alongside public dialogue without feeding the traces to the historian", () => {
    const f = sourceFixture();
    const expected: string[] = [];
    for (let i = 0; i < 40; i++) {
      f.publicSource(`public-${i}`);
      f.toolPair(`lookup-${i}`, 60000);
      expected.push(`public-${i}`, `lookup-${i}-call`, `lookup-${i}-result`);
    }
    const batches = f.candidates();
    // The old raw-byte packer skipped each >48k tool unit entirely. The safe-source
    // body is only about20k here; the complete units now share that one region.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(expected);
    expect(batches.flat()).not.toContain("large-tail");
    expect(batches[0]!.reduce((sum, id) => sum + f.sourceCosts.get(id)!, 0)).toBeLessThan(CONTEXT_REGION_SOURCE_BYTES);
  });

  it("enforces the safe-source byte cap and keeps call/result pairs in one batch", () => {
    const f = sourceFixture();
    f.publicSource("first", 30000);
    f.toolPair("first-tool", 100000);
    f.publicSource("second", 30000);
    f.toolPair("second-tool", 100000);
    const batches = f.candidates();
    expect(batches).toEqual([
      ["first", "first-tool-call", "first-tool-result"],
      ["second", "second-tool-call", "second-tool-result"],
    ]);
    for (const ids of batches) {
      expect(ids.reduce((sum, id) => sum + f.sourceCosts.get(id)!, 0) + Buffer.byteLength(JSON.stringify(ids))).toBeLessThan(CONTEXT_REGION_SOURCE_BYTES);
    }
  });

  it("retains missing or oversized public source costs rather than assuming zero", () => {
    const f = sourceFixture();
    f.append("unknown", { role: "user", content: "source cost was not captured" });
    f.publicSource("too-large", CONTEXT_REGION_SOURCE_BYTES + 1);
    f.publicSource("valid");
    expect(f.candidates()).toEqual([["valid"]]);
  });

  it("keeps a body-less cohort explicit so source validation can reject it without fabricated semantics", () => {
    const f = sourceFixture();
    f.toolPair("private-only", 100000);
    expect(f.candidates()).toEqual([["private-only-call", "private-only-result"]]);
    // A zero cost is a known absence of public text, not permission to synthesize a
    // summary or discard canonical records. Conversation validates the cohort later.
    expect(f.sourceCosts.get("private-only-call")).toBe(0);
  });
});
