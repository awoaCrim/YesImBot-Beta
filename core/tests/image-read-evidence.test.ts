import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAssistantMessage, createToolMessage, EphemeralImageProjectionStore, type AgentMessage } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));
import { hasCompletedImageRead } from "../src/agents/image-read-evidence.js";
import { createReadTool } from "../src/agents/tools.js";
import { ChannelResources } from "../src/resources/index.js";
import { PNG_BYTES } from "./helpers/index.js";

describe("completed built-in image reads", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), "read-evidence-"));
    dirs.push(dir);
    const resources = new ChannelResources(dir, true);
    const id = await resources.assets.put(PNG_BYTES);
    const uri = `asset://${id}`;
    const projection = new EphemeralImageProjectionStore();
    const tool = createReadTool(resources, { mode: "native" }, projection);
    const input = { uri };
    const result = await tool.execute(input, { toolCallId: "read", turnId: "turn", messages: [] } as never);
    const output = await tool.toModelOutput!({ toolCallId: "read", input, output: result });
    const call = createAssistantMessage([{ type: "tool-call", toolName: "read", toolCallId: "read", input }]);
    const receipt = createToolMessage([{ type: "tool-result", toolName: "read", toolCallId: "read", output }]);
    const target = { uri, bytes: PNG_BYTES, mediaType: "image/png" };
    return { call, receipt, target, result, projection };
  }
  it("uses real native read output despite the absence of a Sticker JSON receipt", async () => {
    const f = await fixture();
    expect(hasCompletedImageRead([f.call, f.receipt], f.target)).toBe(true);
    expect(hasCompletedImageRead([f.call], f.target)).toBe(false);
    expect(hasCompletedImageRead([f.receipt], f.target)).toBe(false);
    expect(hasCompletedImageRead([f.receipt, f.call], f.target)).toBe(false);
    f.projection.clearAll();
    expect(hasCompletedImageRead([f.call, f.receipt], f.target)).toBe(true); // Already projected bytes still qualify.
  });
  it("sanitized/metadata-only native history needs reread; duplicate/foreign pairs fail closed", async () => {
    const f = await fixture();
    const sanitized = createToolMessage([{ type: "tool-result", toolName: "read", toolCallId: "read", output: { type: "json", value: f.result } }]);
    expect(hasCompletedImageRead([f.call, sanitized], f.target)).toBe(false);
    expect(hasCompletedImageRead([f.call, f.call, f.receipt], f.target)).toBe(false);
    expect(hasCompletedImageRead([f.call, f.receipt, f.receipt], f.target)).toBe(false);
    expect(hasCompletedImageRead([f.call, f.receipt], { ...f.target, uri: `asset://${"f".repeat(32)}` })).toBe(false);
    const other = createAssistantMessage([{ type: "tool-call", toolName: "other", toolCallId: "read", input: { uri: f.target.uri } }]);
    expect(hasCompletedImageRead([f.call, other, f.receipt], f.target)).toBe(false);
  });
  it.each(["read", "describe_image"])("accepts only successful nonempty matching vision %s output", async (toolName) => {
    const f = await fixture();
    const call = createAssistantMessage([{ type: "tool-call", toolName, toolCallId: "vision", input: { uri: f.target.uri } }]);
    const history = (value: object): AgentMessage[] => [
      call,
      createToolMessage([{ type: "tool-result", toolName, toolCallId: "vision", output: { type: "json", value } }]),
    ];
    const good = { uri: f.target.uri, imageMode: "vision", mediaType: "image/png", text: "actual view" };
    expect(hasCompletedImageRead(history(good), f.target)).toBe(true);
    for (const value of [
      { ...good, text: "" },
      { ...good, text: "  " },
      { ...good, error: "vision_call_failed" },
    ])
      expect(hasCompletedImageRead(history(value), f.target)).toBe(false);
    if (toolName === "read") {
      expect(hasCompletedImageRead(history({ ...good, uri: "asset://foreign" }), f.target)).toBe(false);
      expect(hasCompletedImageRead(history({ ...good, imageMode: "unavailable" }), f.target)).toBe(false);
    }
  });
});
