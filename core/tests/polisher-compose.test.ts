import type { AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import { describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));
import {
  createSendMessagePolisher,
  PolisherRegistry,
  validateComposedMessages,
  type MessagePolisherCapability,
  type SendMessagePolisher,
} from "../src/agents/polisher.js";
import { createSendMessageTool } from "../src/agents/tools.js";

const channel = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
function execution(signal?: AbortSignal) {
  return { toolCallId: "call", turnId: "turn", messages: [], abortSignal: signal } as unknown as AgentToolExecuteContext;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(polish?: SendMessagePolisher, sendMessage = vi.fn(async () => ["m"]), resources = {}) {
  const tool = createSendMessageTool({
    bot: { platform: "test", sendMessage } as never,
    channelId: "room",
    resources: resources as never,
    pacing: { charactersPerSecond: 1000, maxTotalDelayMs: 0 },
    innerThought: true,
    polisherMode: "compose",
    polish,
  });
  return { tool, sendMessage };
}

function registered(polish: MessagePolisherCapability["polish"], resolveProfile = async () => ({ persona: "PERSONA" })) {
  const registry = new PolisherRegistry();
  const capability: MessagePolisherCapability = { name: "compose", mode: "compose", polish };
  const dispose = registry.use(capability);
  const hook = createSendMessagePolisher({ registry, context: channel, resolveProfile, capability });
  return { registry, dispose, hook };
}
const input = { facts: ["订单确认完成。"], intent: "回答订单状态，不新增承诺", mode: "raw" as const };

describe("compose validation", () => {
  it("accepts variable bubbles and reorders protected anchors but preserves multiplicity", () => {
    expect(validateComposedMessages(["@alice 12 12 asset://a"], [], ["asset://a @alice", "12 和 12"])).toEqual(["asset://a @alice", "12 和 12"]);
    expect(validateComposedMessages(["12 12"], [], ["12"])).toBeUndefined();
    expect(validateComposedMessages(["12"], [], ["12 13"])).toBeUndefined();
    expect(validateComposedMessages(['<at id="7"/> @alice'], [], ['@alice <at id="8"/>'])).toBeUndefined();
  });
  it.each([[], [""], [" "], [42], "raw", Array(13).fill("多一条"), ["x".repeat(32768)]])("rejects invalid shape or limits: %j", (candidate) => {
    expect(validateComposedMessages([], [], candidate)).toBeUndefined();
  });
  it("keeps complete verbatim payload, not just numbers in a rewritten command", () => {
    const code = "npm run build\nnode app.js";
    expect(validateComposedMessages([], [code], ["执行命令：", code])).toEqual(["执行命令：", code]);
    expect(validateComposedMessages([], [code], ["npm build\nnode app.js"])).toBeUndefined();
  });
});

describe("compose sender", () => {
  it("requires facts/intent with no draft and leaves Core delivery controls intact", async () => {
    const capability = vi.fn(async () => ["已经核对完啦。", "订单没问题。"]);
    const { hook } = registered(capability);
    const { tool, sendMessage } = setup(hook);
    const schema = (tool.inputSchema as { jsonSchema: { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean } }).jsonSchema;
    expect(schema.required).toEqual(["facts", "intent"]);
    expect(schema.properties).not.toHaveProperty("messages");
    expect(schema.additionalProperties).toBe(false);
    const data = { ...input, channel: "other", continue: true };
    const before = JSON.stringify(data);
    await expect(tool.execute(data, execution())).resolves.toEqual({
      ok: true,
      count: 2,
      messageIds: ["m", "m"],
      deliveredMessages: ["已经核对完啦。", "订单没问题。"],
    });
    expect(capability).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "compose", messages: [], facts: input.facts, intent: input.intent, profile: { persona: "PERSONA" } }),
      channel,
      expect.any(AbortSignal),
    );
    expect(sendMessage.mock.calls.every((call) => call[0] === "other")).toBe(true);
    expect(tool.terminal instanceof Function && tool.terminal(data)).toBe(false);
    expect(JSON.stringify(data)).toBe(before);
  });
  it("permits an empty outward fact list for a simple acknowledgement", async () => {
    const { tool, sendMessage } = setup(async () => ["收到啦。"]);
    await expect(tool.execute({ facts: [], intent: "确认收到", mode: "raw" }, execution())).resolves.toMatchObject({ ok: true, count: 1 });
    expect(sendMessage).toHaveBeenCalledOnce();
  });
  it.each([
    { ...input, messages: ["不得回退的台词"] },
    { ...input, facts: [""] },
    { ...input, facts: Array(65).fill("信息") },
    { ...input, intent: "" },
    { ...input, intent: "x".repeat(2001) },
    { ...input, verbatim: Array(13).fill("命令") },
    { ...input, facts: ["x".repeat(32768)] },
  ])("rejects malformed or oversized compose input before invoking generation", async (data) => {
    const polish = vi.fn(async () => ["不该发送"]);
    const { tool, sendMessage } = setup(polish);
    await expect(tool.execute(data, execution())).resolves.toMatchObject({ ok: false, error: { name: "InvalidInput" }, sent: [] });
    expect(polish).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    async () => undefined,
    async () => [],
    async () => ["坏数字 999"],
    async () => {
      throw new Error("offline");
    },
  ])("does not send facts or intent on generation failure", async (polish) => {
    const { tool, sendMessage } = setup(polish);
    const result = await tool.execute(input, execution());
    expect(result).toMatchObject({ ok: false, error: { name: "CompositionUnavailable" }, sent: [], failedAt: 0 });
    expect(JSON.stringify(result)).not.toContain(input.facts[0]);
    expect(JSON.stringify(result)).not.toContain(input.intent);
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it("records only complete messages on partial failure and never regenerates or retries", async () => {
    const polish = vi.fn(async () => ["第一条", "第二条", "第三条"]);
    const sendMessage = vi.fn().mockResolvedValueOnce(["m1"]).mockRejectedValueOnce(new Error("offline"));
    const { tool } = setup(polish, sendMessage);
    await expect(tool.execute(input, execution())).resolves.toMatchObject({ ok: false, sent: ["m1"], failedAt: 1, deliveredMessages: ["第一条"] });
    expect(polish).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
  it("excludes a partially sent failed item from deliveredMessages", async () => {
    const file = '<file src="workspace://file/code"/>';
    const sendMessage = vi.fn().mockResolvedValueOnce(["segment1"]).mockRejectedValueOnce(new Error("offline"));
    const { tool } = setup(async () => [`开头<message/>${file}结尾`], sendMessage, {
      open: async () => ({ bytes: new Uint8Array([1, 2]), mediaType: "text/plain" }),
    });
    const result = await tool.execute({ facts: [], intent: "发送文件", verbatim: [file, "<message/>"], mode: "element" }, execution());
    expect(result).toMatchObject({ ok: false, failedAt: 0, sent: ["segment1"], deliveredMessages: [] });
  });
  it("does not mark an item complete when a later segment returns no IDs", async () => {
    const text = "开头<message/>结尾";
    const sendMessage = vi.fn().mockResolvedValueOnce(["m1"]).mockResolvedValueOnce([]);
    const { tool } = setup(async () => [text], sendMessage);
    expect(await tool.execute({ facts: [], intent: "发送两段", verbatim: ["<message/>"] }, execution())).toMatchObject({
      ok: false,
      failedAt: 0,
      sent: ["m1"],
      deliveredMessages: [],
      error: { name: "DeliveryUnconfirmed" },
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
  it("does not report an empty parsed item as a complete delivery", async () => {
    const polish = vi.fn(async () => ["收到", "<message/>"]);
    const { tool, sendMessage } = setup(polish);
    expect(await tool.execute({ facts: [], intent: "确认收到", verbatim: ["<message/>"] }, execution())).toMatchObject({
      ok: false,
      failedAt: 1,
      sent: ["m"],
      deliveredMessages: ["收到"],
      error: { name: "DeliveryUnconfirmed" },
    });
    expect(polish).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
  });
  it("fails closed when capability changes during profile lookup", async () => {
    const gate = deferred<{ persona: string }>();
    const capability = vi.fn(async () => ["不要发送"]);
    const { hook, dispose } = registered(capability, () => gate.promise);
    const { tool, sendMessage } = setup(hook);
    const pending = tool.execute(input, execution());
    dispose();
    gate.resolve({ persona: "PERSONA" });
    expect(await pending).toMatchObject({ ok: false, sent: [] });
    expect(capability).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it("fails closed when capability changes during generation", async () => {
    const gate = deferred<readonly string[]>();
    const capability = vi.fn(() => gate.promise);
    const { hook, dispose } = registered(capability);
    const { tool, sendMessage } = setup(hook);
    const pending = tool.execute(input, execution());
    await vi.waitFor(() => expect(capability).toHaveBeenCalledOnce());
    dispose();
    gate.resolve(["不要发送"]);
    expect(await pending).toMatchObject({ ok: false, sent: [] });
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it("rechecks registration after asynchronous resource preparation", async () => {
    const gate = deferred<{ bytes: Uint8Array; mediaType: string }>();
    const file = '<file src="workspace://file/code"/>';
    const { hook, dispose } = registered(async () => [file]);
    const open = vi.fn(() => gate.promise);
    const { tool, sendMessage } = setup(hook, undefined, { open });
    const pending = tool.execute({ facts: [], intent: "发送文件", verbatim: [file] }, execution());
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    dispose();
    gate.resolve({ bytes: new Uint8Array([1]), mediaType: "text/plain" });
    expect(await pending).toMatchObject({ ok: false, sent: [], deliveredMessages: [] });
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it("keeps per-result revision guards when another compose request succeeds", async () => {
    const { registry, hook } = registered(async () => ["同一回复"]);
    const request = { mode: "compose" as const, facts: [], messages: [], intent: "确认", turnContext: [] };
    const first = await hook(request);
    registry.profile({ name: "new-profile", resolve: () => ({ roleInstructions: "new" }) });
    const second = await hook(request);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(hook.isCurrent?.(first)).toBe(false);
    expect(hook.isCurrent?.(second)).toBe(true);
  });
  it("cancels even an unwrapped compose callback that ignores its signal", async () => {
    const { tool, sendMessage } = setup(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = tool.execute(input, execution(controller.signal));
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, sent: [] });
    expect(sendMessage).not.toHaveBeenCalled();
  });
  it("cancels even a profile provider that ignores its signal", async () => {
    const { hook } = registered(
      async () => ["不要发送"],
      () => new Promise(() => {}),
    );
    const { tool, sendMessage } = setup(hook);
    const controller = new AbortController();
    const pending = tool.execute(input, execution(controller.signal));
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, sent: [] });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
