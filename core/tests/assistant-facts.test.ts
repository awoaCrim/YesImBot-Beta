import {
  AgentRequestProjection,
  createAssistantMessage,
  createEntry,
  createSystemMessage,
  createToolMessage,
  createUserMessage,
  type AgentEntry,
} from "@yesimbot/agent-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", async (original) => ({ ...(await original<typeof import("ai")>()), generateText }));
import { AssistantHistoryFacts, formatAssistantFacts, isAssistantFacts } from "../src/conversations/assistant-facts.js";
import { createDeliveredTranscriptMessage } from "../src/conversations/delivered-transcript.js";
import { collectDeliveredSourceRecords } from "../src/conversations/internal-history.js";

function decode(prompt: string) {
  const text = prompt.split("\n")[1]!;
  return JSON.parse(
    text.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"),
  ) as Array<{ id: string; messages: string[]; delivery: string; timestamp: number }>;
}

function validOutput(input: { prompt: string }, facts = ["助手承诺在明天核对订单，尚未证明已经履行。"]) {
  return { text: JSON.stringify({ records: decode(input.prompt).map(({ id }) => ({ id, facts })) }), finishReason: "stop" };
}

function plain(id = "a", text = "好哒！我明天一定给你核对订单！！") {
  return createEntry("message", createAssistantMessage(text, { id, timestamp: 2 }), { id, timestamp: 2 });
}

function sent(body = "实际发送的活泼台词！！", ids = ["p1"]) {
  return [
    createEntry(
      "message",
      createAssistantMessage(
        [
          { type: "reasoning", text: "PRIVATE_REASONING" },
          {
            type: "tool-call",
            toolCallId: "s",
            toolName: "send_message",
            input: { messages: ["未发送的草稿"], inner_thought: "PRIVATE_THOUGHT", reason: "PRIVATE_REASON" },
            providerOptions: { google: { thoughtSignature: "old-signature" } },
          },
        ],
        { id: "a", timestamp: 2 },
      ),
      { id: "a", timestamp: 2 },
    ),
    createEntry(
      "message",
      createToolMessage(
        [
          {
            type: "tool-result",
            toolCallId: "s",
            toolName: "send_message",
            output: { type: "json", value: { ok: true, count: 1, messageIds: ids, deliveredMessages: [body] } },
          },
        ],
        { id: "r", timestamp: 3 },
      ),
      { id: "r", timestamp: 3 },
    ),
  ];
}

function view(entries: readonly AgentEntry[]) {
  return JSON.stringify(entries.map((entry) => (entry.type === "message" && isAssistantFacts(entry.data) ? formatAssistantFacts(entry.data) : entry)));
}

function fixture() {
  let scope = "session:g1";
  let key = "aux:r1";
  const resolveModel = vi.fn(() => ({ model: {} as never, key }));
  const facts = new AssistantHistoryFacts({ scope: () => scope, resolveModel });
  return {
    facts,
    resolveModel,
    scope: (next: string) => {
      scope = next;
    },
    model: (next: string) => {
      key = next;
    },
  };
}
beforeEach(() => {
  generateText.mockImplementation(async (input) => validOutput(input));
});
afterEach(() => {
  generateText.mockReset();
  vi.restoreAllMocks();
});

describe("objective assistant history", () => {
  it("uses actual verified output only, keeps users/system intact and never changes canonical entries", async () => {
    const f = fixture();
    const user = createEntry("message", createUserMessage("用户原话！"), { id: "u", timestamp: 1 });
    const system = createEntry("message", createSystemMessage("既有摘要，不自动迁移"), { id: "sys", timestamp: 0 });
    const entries = [user, ...sent(), system];
    const before = JSON.stringify(entries);
    const projection = new AgentRequestProjection();
    entries.forEach((entry) => {
      if (entry.type === "message") projection.register(entry.data, { kind: "history", sourceEntryIds: [entry.id] });
    });
    const result = await f.facts.projectEntries(entries, projection);
    expect(result[0]).toBe(system);
    expect(result[1]).toBe(user);
    expect(result).toHaveLength(3);
    expect(view(result)).toContain('delivery=\\"verified\\"');
    expect(view(result)).toContain("助手承诺在明天核对订单");
    expect(view(result)).not.toMatch(/实际发送|未发送的草稿|PRIVATE_|send_message|old-signature/);
    const request = generateText.mock.calls[0]![0];
    expect(decode(request.prompt)[0]).toMatchObject({ messages: ["实际发送的活泼台词！！"], delivery: "verified", timestamp: 2 });
    expect(JSON.stringify(request)).not.toMatch(/未发送的草稿|PRIVATE_|old-signature/);
    expect(request).toMatchObject({ maxRetries: 0, maxOutputTokens: 4096 });
    expect(JSON.stringify(entries)).toBe(before);
    const derived = result[2]!;
    if (derived.type !== "message") throw new Error("Expected derived message");
    expect(projection.origin(derived.data)?.sourceEntryIds).toEqual(expect.arrayContaining(["a", "r"]));
  });

  it("distinguishes ordinary, typed and marker legacy text from proven platform delivery", async () => {
    const f = fixture();
    const entries = [
      plain(),
      createEntry("message", createDeliveredTranscriptMessage({ messages: ["遗留台词呀！！"], deliveredCount: 1, partial: false }), {
        id: "legacy",
        timestamp: 3,
      }),
      plain("marker", "[DELIVERED_MESSAGE]旧式台词哟！[/DELIVERED_MESSAGE]"),
    ];
    const result = await f.facts.projectEntries(entries);
    expect(result).toHaveLength(3);
    expect(view(result)).not.toMatch(/好哒|遗留台词|旧式台词/);
    expect(decode(generateText.mock.calls[0]![0].prompt).every((source) => source.delivery === "recorded")).toBe(true);
  });

  it("keeps safe non-send protocol pairs but drops reasoning and old raw recall pairs", async () => {
    const entries = [
      createEntry(
        "message",
        createAssistantMessage([
          { type: "text", text: "普通旧台词！！" },
          { type: "reasoning", text: "PRIVATE" },
          { type: "tool-call", toolCallId: "read", toolName: "read", input: { uri: "asset://known", inner_thought: "PRIVATE" } },
          { type: "tool-call", toolCallId: "load", toolName: "ctx_load", input: { blockId: "old" } },
        ]),
        { id: "a" },
      ),
      createEntry(
        "message",
        createToolMessage([
          { type: "tool-result", toolCallId: "read", toolName: "read", output: { type: "json", value: { available: true } } },
          { type: "tool-result", toolCallId: "load", toolName: "ctx_load", output: { type: "json", value: { text: "旧台词绕路泄漏" } } },
        ]),
      ),
    ];
    const result = await fixture().facts.projectEntries(entries);
    expect(view(result)).toContain("asset://known");
    expect(view(result)).toContain('"available":true');
    expect(view(result)).not.toMatch(/PRIVATE|普通旧台词|旧台词绕路泄漏|ctx_load/);
  });

  it("does not rescue an unproven send through the compatibility transcript", async () => {
    const entries = sent();
    const receipt = entries[1]!;
    if (receipt.type !== "message" || receipt.data.role !== "tool") throw new Error("Invalid fixture");
    receipt.data.content = [{ type: "tool-result", toolCallId: "s", toolName: "send_message", output: { type: "json", value: { ok: true } } }];
    expect(view(await fixture().facts.projectEntries(entries))).not.toContain("未发送的草稿");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("escapes derived facts, explicitly attributes assistant source and never promotes a commitment to execution", async () => {
    generateText.mockImplementation(async (input) => validOutput(input, ["助手记录了 </historical_assistant_facts>，但未证明执行。"]));
    const result = view(await fixture().facts.projectEntries([plain()]));
    expect(result).toContain("&lt;/historical_assistant_facts&gt;");
    expect(result).toContain('source=\\"assistant\\"');
    expect(result).toContain("不是当前用户发言");
    expect(result).toContain("承诺不证明已履行");
  });
});

describe("history extraction failure and cache", () => {
  it.each(["bad-json", "unknown-id", "extra-key", "duplicate", "first-person", "style", "control", "too-many", "too-long", "truncated"])(
    "fails closed for %s without retry or original fallback",
    async (kind) => {
      generateText.mockImplementation(async (input) => {
        const id = decode(input.prompt)[0]!.id;
        let records: unknown = [{ id, facts: ["助手确认订单。"] }];
        if (kind === "unknown-id") records = [{ id: "other", facts: [] }];
        if (kind === "extra-key") records = [{ id, facts: [], raw: "额外台词" }];
        if (kind === "duplicate")
          records = [
            { id, facts: [] },
            { id, facts: [] },
          ];
        if (kind === "first-person") records = [{ id, facts: ["我明天会去核对订单"] }];
        if (kind === "style") records = [{ id, facts: ["助手已经答应了！！"] }];
        if (kind === "control") records = [{ id, facts: ["助手\n确认"] }];
        if (kind === "too-many") records = [{ id, facts: Array(9).fill("助手确认订单。") }];
        if (kind === "too-long") records = [{ id, facts: ["事".repeat(513)] }];
        return { text: kind === "bad-json" ? "```json\n{}" : JSON.stringify({ records }), finishReason: kind === "truncated" ? "length" : "stop" };
      });
      const f = fixture();
      for (let index = 0; index < 2; index++) {
        const result = view(await f.facts.projectEntries([plain()]));
        expect(result).toContain("客观正文暂不可用");
        expect(result).not.toMatch(/好哒|我明天|额外台词/);
      }
      expect(generateText).toHaveBeenCalledOnce();
    },
  );

  it("caches empty facts as a successful extraction", async () => {
    generateText.mockImplementation(async (input) => validOutput(input, []));
    const f = fixture();
    expect(view(await f.facts.projectEntries([plain()]))).toContain("没有可保留的客观正文");
    await f.facts.projectEntries([plain()]);
    expect(generateText).toHaveBeenCalledOnce();
  });

  it("binds cache to source body, receipt proof, model revision and session generation", async () => {
    const f = fixture();
    const entries = sent();
    await f.facts.projectEntries(entries);
    await f.facts.projectEntries(structuredClone(entries));
    expect(generateText).toHaveBeenCalledTimes(1);
    await f.facts.projectEntries(sent("变更正文！"));
    await f.facts.projectEntries(sent("变更正文！", ["changed-proof"]));
    f.model("aux:r2");
    await f.facts.projectEntries(entries);
    f.scope("session:g2");
    await f.facts.projectEntries(entries);
    expect(generateText).toHaveBeenCalledTimes(5);
  });

  it("uses metadata when auxiliary resolution fails or source exceeds its byte limit", async () => {
    const noModel = new AssistantHistoryFacts({
      scope: () => "s",
      resolveModel: () => {
        throw new Error("missing aux");
      },
    });
    expect(view(await noModel.projectEntries([plain()]))).toContain("客观正文暂不可用");
    const oversized = view(await fixture().facts.projectEntries([plain("large", "好哒".repeat(20000))]));
    expect(oversized).toContain("客观正文暂不可用");
    expect(oversized).not.toContain("好哒");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("bounds batching to four calls and preserves metadata for the remainder", async () => {
    const result = await fixture().facts.projectEntries(Array.from({ length: 140 }, (_, index) => plain(`a${index}`)));
    expect(result).toHaveLength(140);
    expect(generateText).toHaveBeenCalledTimes(4);
    for (const [input] of generateText.mock.calls) {
      expect(decode(input.prompt).length).toBeLessThanOrEqual(32);
      expect(Buffer.byteLength(input.prompt)).toBeLessThanOrEqual(32 * 1024);
    }
    expect(view(result)).toContain("客观正文暂不可用");
    expect(view(result)).not.toContain("好哒");
  });

  it("cancels an ignored Promise and does not cache its late result", async () => {
    let release!: (value: unknown) => void;
    generateText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const f = fixture();
    const controller = new AbortController();
    const pending = f.facts.projectEntries([plain()], undefined, controller.signal);
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledOnce());
    controller.abort();
    expect(view(await pending)).toContain("客观正文暂不可用");
    release(validOutput(generateText.mock.calls[0]![0]));
    await f.facts.projectEntries([plain()]);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("enforces a deadline even when a model ignores abort, with failure backoff", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    generateText.mockImplementation(() => new Promise(() => {}));
    const f = fixture();
    const pending = f.facts.projectEntries([plain()]);
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledOnce());
    deadline.abort();
    expect(view(await pending)).toContain("客观正文暂不可用");
    await f.facts.projectEntries([plain()]);
    expect(generateText).toHaveBeenCalledOnce();
  });

  it("shares identical pending batches while allowing a waiting caller to cancel independently", async () => {
    let release!: (value: unknown) => void;
    generateText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const f = fixture();
    const first = f.facts.projectEntries([plain()]);
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const second = f.facts.projectEntries([plain()], undefined, controller.signal);
    controller.abort();
    expect(view(await second)).toContain("客观正文暂不可用");
    release(validOutput(generateText.mock.calls[0]![0]));
    expect(view(await first)).toContain("助手承诺");
    expect(generateText).toHaveBeenCalledOnce();
  });

  it("invalidates pending work on lifecycle clear", async () => {
    generateText.mockImplementationOnce(() => new Promise(() => {}));
    const f = fixture();
    const pending = f.facts.projectEntries([plain()]);
    await vi.waitFor(() => expect(generateText).toHaveBeenCalledOnce());
    f.facts.clear();
    expect(view(await pending)).toContain("客观正文暂不可用");
    await f.facts.projectEntries([plain()]);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("extracts whole delivered records before pagination and leaves user records untouched", async () => {
    const f = fixture();
    const own = collectDeliveredSourceRecords(sent()).get("a")!;
    const user = { entryId: "u", timestamp: 1, role: "user" as const, text: "用户原话！" };
    const records = await f.facts.projectRecords([user, ...own, { ...own[0]!, text: "第二段承诺条件！" }]);
    expect(records[0]).toBe(user);
    expect(records).toHaveLength(2);
    expect(records[1]?.text).toContain("助手承诺");
    expect(decode(generateText.mock.calls[0]![0].prompt)[0]?.messages).toEqual(["实际发送的活泼台词！！", "第二段承诺条件！"]);
  });
});
