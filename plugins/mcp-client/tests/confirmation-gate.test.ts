import type { AgentPlugin, AgentTool } from "@yesimbot/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectMcpServer: vi.fn<() => Promise<unknown>>(),
  schema: {
    array: vi.fn<() => unknown>(),
    boolean: vi.fn<() => unknown>(),
    const: vi.fn<() => unknown>(),
    dict: vi.fn<() => unknown>(),
    intersect: vi.fn<() => unknown>(),
    object: vi.fn<() => unknown>(),
    string: vi.fn<() => unknown>(),
    union: vi.fn<() => unknown>(),
  },
}));

vi.mock("../src/transports", () => ({ connectMcpServer: mocks.connectMcpServer }));

vi.mock("koishi-plugin-yesimbot", () => ({
  formatElements: (elements: Array<{ attrs?: { content?: unknown }; type?: unknown }>) =>
    elements.map((element) => (element.type === "text" ? String(element.attrs?.content ?? "") : "")).join(""),
}));

vi.mock("koishi", () => {
  const chain = () => ({
    collapse: vi.fn<() => unknown>().mockReturnThis(),
    default: vi.fn<() => unknown>().mockReturnThis(),
    description: vi.fn<() => unknown>().mockReturnThis(),
    required: vi.fn<() => unknown>().mockReturnThis(),
    role: vi.fn<() => unknown>().mockReturnThis(),
  });
  for (const key of Object.keys(mocks.schema) as Array<keyof typeof mocks.schema>) {
    mocks.schema[key].mockImplementation(chain);
  }
  return { Context: class Context {}, Logger: class Logger {}, Schema: mocks.schema };
});

import {
  CONFIRMATION_TTL_MS,
  ConfirmationStore,
  canonicalizeArgs,
  classifyToolRisk,
  deriveChannelScopeKey,
  hashArgs,
  inspectLatestConfirmationInput,
  parseConfirmationCode,
  parseConfirmationFromMessages,
  pendingKey,
} from "../src/confirmation";
import McpClientPlugin from "../src/index";

const SCOPE_A = { type: "guild", platform: "qq", channelId: "room-a", guildId: "room-a" } as never;
const SCOPE_B = { type: "guild", platform: "qq", channelId: "room-b", guildId: "room-b" } as never;

const DEFAULT_TOOLS = [
  { name: "listShops", description: "查询门店列表", inputSchema: { type: "object" } },
  { name: "createOrder", description: "创建订单", inputSchema: { type: "object" } },
  { name: "frobnicate", description: "does something", inputSchema: { type: "object" } },
];

let nowSpy: ReturnType<typeof vi.spyOn> | undefined;

afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = undefined;
  vi.clearAllMocks();
});

function createLogger() {
  return {
    debug: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<() => void>(),
    info: vi.fn<() => void>(),
    success: vi.fn<() => void>(),
    warn: vi.fn<() => void>(),
  };
}

function createContext() {
  const scopedLogger = createLogger();
  const rootLogger = Object.assign(
    vi.fn(() => scopedLogger),
    scopedLogger,
  );
  const artifactWriter = { put: vi.fn(async () => "artifact://luckin-createOrder/019d3b7e-1bd0-7e4f-9c5d-5bf3fd41f1d4") };
  const ctx = {
    logger: rootLogger,
    on: vi.fn(),
    yesimbot: {
      agent: { use: vi.fn(() => vi.fn()) },
      resource: { get: vi.fn(async () => ({ path: "/tmp", assets: {}, artifacts: { forTool: vi.fn(() => artifactWriter) } })) },
    },
  };
  return { ctx, artifactWriter, scopedLogger };
}

function createClient(tools = DEFAULT_TOOLS) {
  return {
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "upstream-ok" }] })),
    close: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools })),
    setNotificationHandler: vi.fn(),
  };
}

async function buildPlugin(tools = DEFAULT_TOOLS) {
  const { ctx, artifactWriter, scopedLogger } = createContext();
  const client = createClient(tools);
  mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn(async () => undefined) } });
  const plugin = new McpClientPlugin(ctx as never, { mcpServers: { luckin: { type: "http", url: "https://example.test/mcp" } } });
  await plugin.start();
  return { plugin, client, artifactWriter, scopedLogger };
}

async function channelTools(plugin: McpClientPlugin, scope: unknown) {
  const agentPlugin: AgentPlugin = await plugin.setup(scope as never, {} as never);
  const tools = typeof agentPlugin.tools === "function" ? await agentPlugin.tools({} as never) : agentPlugin.tools;
  if (!tools) throw new Error("MCP runtime plugin published no tools");
  const byName = new Map(tools.map((tool) => [tool.name, tool] as const));
  return {
    agentPlugin,
    tool(name: string): AgentTool {
      const found = byName.get(name);
      if (!found) throw new Error(`missing tool ${name}`);
      return found;
    },
  };
}

function userMessage(content: unknown) {
  return { content, id: "user-1", role: "user", timestamp: 1 };
}

function rawYesimbotMessage(content: string, actorId: string, messageId = `message-${actorId}`) {
  return {
    data: {
      elements: [{ attrs: { content }, children: [], type: "text" }],
      messageId,
      user: { id: actorId },
    },
    id: `agent-${messageId}`,
    role: "custom",
    type: "yesimbot.message",
  };
}

function outputText(output: unknown): string {
  if (!Array.isArray(output)) throw new Error(`expected MCP content array, received ${typeof output}`);
  const block = output[0] as { type?: unknown; text?: unknown };
  if (block?.type !== "text" || typeof block.text !== "string") throw new Error("expected a single MCP text block");
  return block.text;
}

function readShortCode(text: string): string {
  const match = /确认短码: ([A-Z0-9]{6})/.exec(text);
  if (!match?.[1]) throw new Error(`short code missing from output: ${text}`);
  return match[1];
}

describe("classifyToolRisk", () => {
  it("recognizes explicit read-only vocabulary", () => {
    for (const name of ["listShops", "getStoreDetail", "searchProducts", "queryOrderList", "getMenuList", "门店查询"]) {
      expect(classifyToolRisk(name, "查询门店列表")).toBe("read-only");
    }
  });

  it("flags side-effect vocabulary", () => {
    for (const name of ["createOrder", "cancelOrder", "payOrder", "submitOrder", "checkout", "refundOrder", "deleteCoupon", "取消订单"]) {
      expect(classifyToolRisk(name, "创建订单")).toBe("side-effect");
    }
  });

  it("fails closed for ambiguous action-like vocabulary even with read-only nouns", () => {
    for (const name of ["couponOperation", "preferenceAction", "orderAction", "accountStatusAction"]) {
      expect(classifyToolRisk(name)).toBe("side-effect");
    }
  });

  it("fails closed for unknown tools and unknown descriptions", () => {
    expect(classifyToolRisk("frobnicate")).toBe("side-effect");
    expect(classifyToolRisk("snap", "take a screenshot")).toBe("side-effect");
    expect(classifyToolRisk("order", "订单相关操作")).toBe("side-effect");
  });

  it("lets a side-effect description override a read-only sounding name", () => {
    expect(classifyToolRisk("getOrderInfo", "创建订单并支付")).toBe("side-effect");
    expect(classifyToolRisk("queryMenu", "查询菜单")).toBe("read-only");
  });
});

describe("confirmation parsing", () => {
  it("accepts only the exact confirmation message", () => {
    expect(parseConfirmationCode("确认 ABCDEF")).toBe("ABCDEF");
    expect(parseConfirmationCode("确认 abcdef")).toBe("ABCDEF");
    expect(parseConfirmationCode("确认\u3000ABCDEF")).toBe("ABCDEF");
    expect(parseConfirmationCode("  确认 ABCDEF  ")).toBe("ABCDEF");
    expect(parseConfirmationCode("好的，确认 ABCDEF")).toBeUndefined();
    expect(parseConfirmationCode("确认 ABCDE")).toBeUndefined();
    expect(parseConfirmationCode("确认ABCDEF")).toBeUndefined();
    expect(parseConfirmationCode("确认 ABCDEF。")).toBeUndefined();
    expect(parseConfirmationCode("")).toBeUndefined();
    expect(parseConfirmationCode(undefined)).toBeUndefined();
  });

  it("reads text from both string and parts user content", () => {
    expect(parseConfirmationCode([{ text: "确认 ABCDEF", type: "text" }])).toBe("ABCDEF");
    expect(
      parseConfirmationCode([
        { image: "aGk=", mediaType: "image/png", type: "image" },
        { text: "确认 ABCDEF", type: "text" },
      ]),
    ).toBe("ABCDEF");
    expect(parseConfirmationCode([{ image: "aGk=", mediaType: "image/png", type: "image" }])).toBeUndefined();
  });

  it("parses raw yesimbot.message elements from the current turn", () => {
    expect(
      parseConfirmationFromMessages([
        {
          data: { elements: [{ attrs: { content: "确认 ABCDEF" }, children: [], type: "text" }] },
          role: "custom",
          type: "yesimbot.message",
        },
      ]),
    ).toBe("ABCDEF");
  });

  it("reports current carriers in order and selects the newest carrier", () => {
    const observation = inspectLatestConfirmationInput([
      rawYesimbotMessage("请下单", "alice", "702200343"),
      rawYesimbotMessage("确认 ABCDEF", "bob", "702200344"),
    ]);

    expect(observation.carriers).toHaveLength(2);
    expect(observation.carriers[0]).toEqual({
      carrier: "raw-yesimbot.message",
      platformMessageId: "702200343",
      agentMessageId: "agent-702200343",
      actorId: "alice",
      codeState: "invalid",
    });
    expect(observation.latest).toEqual({
      carrier: "raw-yesimbot.message",
      platformMessageId: "702200344",
      agentMessageId: "agent-702200344",
      actorId: "bob",
      codeState: "valid",
    });
    expect(observation.code).toBe("ABCDEF");
  });

  it("does not borrow an older raw actor when the newest carrier is normalized", () => {
    const observation = inspectLatestConfirmationInput([rawYesimbotMessage("确认 ABCDEF", "alice", "702200343"), userMessage("确认 ABCDEF")]);

    expect(observation.latest).toEqual({ carrier: "normalized-user", agentMessageId: "user-1", codeState: "valid" });
    expect(observation.latest?.actorId).toBeUndefined();
    expect(observation.code).toBe("ABCDEF");
  });

  it("treats a malformed newest raw carrier as the current input", () => {
    const observation = inspectLatestConfirmationInput([
      rawYesimbotMessage("确认 ABCDEF", "alice", "702200343"),
      { role: "custom", type: "yesimbot.message", data: null },
    ]);

    expect(observation.code).toBeUndefined();
    expect(observation.latest).toEqual({ carrier: "raw-yesimbot.message", codeState: "absent" });
  });

  it("uses only the newest user message of the current turn", () => {
    expect(parseConfirmationFromMessages(undefined)).toBeUndefined();
    expect(parseConfirmationFromMessages([])).toBeUndefined();
    expect(parseConfirmationFromMessages([{ content: "确认 ABCDEF", role: "user" }])).toBe("ABCDEF");
    expect(
      parseConfirmationFromMessages([
        { content: "确认 ABCDEF", role: "user" },
        { content: [{ text: "已下单", type: "text" }], role: "assistant" },
        { content: "好的", role: "user" },
      ]),
    ).toBeUndefined();
  });
});

describe("canonical argument hashing", () => {
  it("is stable across key order and sensitive to array order", () => {
    expect(canonicalizeArgs({ a: { c: [1, 2], d: 2 }, b: 1 })).toBe('{"a":{"c":[1,2],"d":2},"b":1}');
    expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ b: 2, a: 1 }));
    expect(hashArgs({ list: [1, 2] })).not.toBe(hashArgs({ list: [2, 1] }));
    expect(hashArgs({ a: 1 })).toBe(hashArgs({ a: 1, b: undefined }));
  });

  it("rejects arguments that cannot be canonicalized", () => {
    expect(() => hashArgs({ fn: () => undefined })).toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => hashArgs(circular)).toThrow();
    expect(() => hashArgs({ n: Number.NaN })).toThrow();
  });
});

describe("ConfirmationStore", () => {
  it("reuses an unexpired code for identical bindings", () => {
    const store = new ConfirmationStore(() => 1_000);
    const input = { argsHash: "h", channelKey: "c", serverName: "s", upstreamToolName: "t" };
    const first = store.register(input);
    expect(store.register(input).code).toBe(first.code);
    expect(store.size).toBe(1);
  });

  it("rotates the code after expiry and consumes codes once", () => {
    let now = 1_000;
    const store = new ConfirmationStore(() => now);
    const input = { argsHash: "h", channelKey: "c", serverName: "s", upstreamToolName: "t" };
    const first = store.register(input);
    now += CONFIRMATION_TTL_MS + 1;
    expect(store.consume(pendingKey(input.channelKey, input.serverName, input.upstreamToolName))).toBeUndefined();
    const second = store.register(input);
    expect(second.code).not.toBe(first.code);
    expect(store.size).toBe(1);
  });

  it("bounds the pending set and clears on demand", () => {
    const store = new ConfirmationStore(() => 1_000, 4);
    for (let index = 0; index < 12; index += 1) {
      store.register({ argsHash: `h${index}`, channelKey: "c", serverName: "s", upstreamToolName: `t${index}` });
    }
    expect(store.size).toBe(4);
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe("deriveChannelScopeKey", () => {
  it("derives a stable per-channel key and fails closed on incomplete scopes", () => {
    expect(deriveChannelScopeKey({ channelId: "r", guildId: "r", platform: "qq", type: "guild" })).toBe("guild:qq:r");
    expect(deriveChannelScopeKey({ channelId: "c", guildId: "g", platform: "qq", type: "channel" })).toBe("channel:qq:g:c");
    expect(deriveChannelScopeKey({ channelId: "c", platform: "qq", selfId: "s", type: "direct", userId: "u" })).toBe("direct:qq:u:s");
    expect(deriveChannelScopeKey({ channelId: "r", guildId: "r", platform: "", type: "guild" })).toBeUndefined();
    expect(deriveChannelScopeKey({ channelId: "c", platform: "qq", selfId: "", type: "direct", userId: "u" })).toBeUndefined();
    expect(deriveChannelScopeKey(undefined)).toBeUndefined();
  });
});

describe("mcp-client confirmation gate", () => {
  it("returns confirmation_required without calling upstream for a side-effect tool", async () => {
    const { plugin, client } = await buildPlugin();
    const { tool } = await channelTools(plugin, SCOPE_A);

    const output = await tool("luckin-createOrder").execute({ item: "coffee" }, { messages: [] } as never);
    const text = outputText(output);

    expect(text).toContain("confirmation_required");
    expect(text).toContain("reason: awaiting-confirmation");
    expect(readShortCode(text)).toMatch(/^[A-Z0-9]{6}$/);
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("allows exactly one upstream call for the exact current-turn confirmation", async () => {
    const { plugin, client } = await buildPlugin();
    const { tool } = await channelTools(plugin, SCOPE_A);
    const createOrder = tool("luckin-createOrder");

    const blocked = await createOrder.execute({ item: "coffee" }, { messages: [] } as never);
    const code = readShortCode(outputText(blocked));
    const confirmed = [userMessage(`确认 ${code}`)];

    const allowed = await createOrder.execute({ item: "coffee" }, { messages: confirmed } as never);
    expect(outputText(allowed)).toBe("upstream-ok");
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledWith({ arguments: { item: "coffee" }, name: "createOrder" });

    const replayed = await createOrder.execute({ item: "coffee" }, { messages: confirmed } as never);
    expect(outputText(replayed)).toContain("confirmation_required");
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("binds raw yesimbot confirmations to the original sender when available", async () => {
    const { plugin, client } = await buildPlugin();
    const { tool } = await channelTools(plugin, SCOPE_A);
    const createOrder = tool("luckin-createOrder");

    const blocked = await createOrder.execute({ item: "coffee" }, { messages: [rawYesimbotMessage("请下单", "alice")] } as never);
    const code = readShortCode(outputText(blocked));

    const otherSender = await createOrder.execute({ item: "coffee" }, { messages: [rawYesimbotMessage(`确认 ${code}`, "bob")] } as never);
    expect(outputText(otherSender)).toContain("confirmation_required");
    expect(client.callTool).not.toHaveBeenCalled();

    const originalSender = await createOrder.execute({ item: "coffee" }, { messages: [rawYesimbotMessage(`确认 ${code}`, "alice")] } as never);
    expect(outputText(originalSender)).toBe("upstream-ok");
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("does not rotate an actor-bound pending when the confirmation loses its trusted actor", async () => {
    const { plugin, client } = await buildPlugin();
    const { tool } = await channelTools(plugin, SCOPE_A);
    const createOrder = tool("luckin-createOrder");

    const blocked = await createOrder.execute({ item: "coffee" }, { messages: [rawYesimbotMessage("请下单", "alice", "702200343")] } as never);
    const code = readShortCode(outputText(blocked));

    const lostCarrier = await createOrder.execute({ item: "coffee" }, { messages: [userMessage(`确认 ${code}`)] } as never);
    const text = outputText(lostCarrier);
    expect(text).toContain("confirmation_unavailable");
    expect(text).toContain("reason: trusted-actor-unavailable");
    expect(text).not.toContain("确认短码:");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("records carrier and binding metadata without confirmation text or full arguments", async () => {
    const { plugin, client, scopedLogger } = await buildPlugin();
    const { tool } = await channelTools(plugin, SCOPE_A);
    const createOrder = tool("luckin-createOrder");

    const blocked = await createOrder.execute({ item: "coffee" }, { messages: [rawYesimbotMessage("请下单", "alice", "702200343")] } as never);
    const code = readShortCode(outputText(blocked));
    await createOrder.execute({ item: "coffee" }, { messages: [rawYesimbotMessage(`确认 ${code}`, "alice", "702200344")] } as never);

    const bindingCalls = scopedLogger.debug.mock.calls.filter(([event]) => event === "mcp.confirmation.binding");
    expect(bindingCalls).toHaveLength(2);
    const serialized = JSON.stringify(bindingCalls);
    expect(serialized).toContain("702200343");
    expect(serialized).toContain("702200344");
    expect(serialized).toContain("alice");
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain("coffee");
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("accepts a parts-array user message as the confirmation carrier", async () => {
    const { plugin, client } = await buildPlugin();
    const { tool } = await channelTools(plugin, SCOPE_A);
    const createOrder = tool("luckin-createOrder");

    const blocked = await createOrder.execute({ item: "coffee" }, { messages: [] } as never);
    const code = readShortCode(outputText(blocked));
    const parts = [userMessage([{ text: `确认 ${code}`, type: "text" }])];

    const allowed = await createOrder.execute({ item: "coffee" }, { messages: parts } as never);
    expect(outputText(allowed)).toBe("upstream-ok");
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("blocks wrong, imprecise, stale, and mismatched confirmations", async () => {
    const { plugin, client } = await buildPlugin();
    const { tool } = await channelTools(plugin, SCOPE_A);
    const createOrder = tool("luckin-createOrder");

    const blocked = await createOrder.execute({ item: "coffee" }, { messages: [] } as never);
    const code = readShortCode(outputText(blocked));

    const wrong = await createOrder.execute({ item: "coffee" }, { messages: [userMessage("确认 ZZZZZZ")] } as never);
    expect(outputText(wrong)).toContain("reason: short-code-mismatch");

    const imprecise = await createOrder.execute({ item: "coffee" }, { messages: [userMessage(`好的，确认 ${code}`)] } as never);
    expect(outputText(imprecise)).toContain("confirmation_required");

    const historyOnly = await createOrder.execute({ item: "coffee" }, {
      messages: [userMessage(`确认 ${code}`), { content: "继续", id: "a", role: "assistant", timestamp: 2 }, userMessage("再来一杯")],
    } as never);
    expect(outputText(historyOnly)).toContain("confirmation_required");

    const changedArgs = await createOrder.execute({ item: "tea" }, { messages: [userMessage(`确认 ${code}`)] } as never);
    expect(outputText(changedArgs)).toContain("reason: short-code-mismatch");

    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("fails closed when the pending confirmation expired", async () => {
    const { plugin, client } = await buildPlugin();
    const { tool } = await channelTools(plugin, SCOPE_A);
    const createOrder = tool("luckin-createOrder");

    const blocked = await createOrder.execute({ item: "coffee" }, { messages: [] } as never);
    const code = readShortCode(outputText(blocked));

    const realNow = Date.now();
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(realNow + CONFIRMATION_TTL_MS + 1_000);
    const expired = await createOrder.execute({ item: "coffee" }, { messages: [userMessage(`确认 ${code}`)] } as never);
    const expiredText = outputText(expired);

    expect(expiredText).toContain("confirmation_required");
    expect(expiredText).toContain("reason: short-code-mismatch");
    expect(readShortCode(expiredText)).not.toBe(code);
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("isolates pending confirmations per channel", async () => {
    const { plugin, client } = await buildPlugin();
    const channelA = await channelTools(plugin, SCOPE_A);
    const channelB = await channelTools(plugin, SCOPE_B);

    const blocked = await channelA.tool("luckin-createOrder").execute({ item: "coffee" }, { messages: [] } as never);
    const code = readShortCode(outputText(blocked));

    const crossChannel = await channelB.tool("luckin-createOrder").execute({ item: "coffee" }, { messages: [userMessage(`确认 ${code}`)] } as never);
    expect(outputText(crossChannel)).toContain("confirmation_required");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("never reaches upstream when arguments cannot be bound", async () => {
    const { plugin, client } = await buildPlugin();
    const { tool } = await channelTools(plugin, SCOPE_A);

    const output = await tool("luckin-createOrder").execute({ runner: () => undefined }, { messages: [] } as never);
    const text = outputText(output);

    expect(text).toContain("confirmation_unavailable");
    expect(text).toContain("reason: args-unhashable");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("invalidates a pending code when the same tool arguments change", async () => {
    const { plugin, client } = await buildPlugin();
    const { tool } = await channelTools(plugin, SCOPE_A);
    const createOrder = tool("luckin-createOrder");

    const first = await createOrder.execute({ item: "coffee" }, { messages: [] } as never);
    const firstCode = readShortCode(outputText(first));
    const changed = await createOrder.execute({ item: "tea" }, { messages: [] } as never);
    const changedText = outputText(changed);
    expect(changedText).toContain("confirmation_required");
    expect(readShortCode(changedText)).not.toBe(firstCode);

    const stale = await createOrder.execute({ item: "coffee" }, { messages: [userMessage(`确认 ${firstCode}`)] } as never);
    expect(outputText(stale)).toContain("confirmation_required");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("does not carry a pending code into a newly created runtime snapshot", async () => {
    const { plugin, client } = await buildPlugin();
    const first = await channelTools(plugin, SCOPE_A);
    const firstCall = first.tool("luckin-createOrder");
    const blocked = await firstCall.execute({ item: "coffee" }, { messages: [] } as never);
    const code = readShortCode(outputText(blocked));

    const second = await channelTools(plugin, SCOPE_A);
    const replay = await second.tool("luckin-createOrder").execute({ item: "coffee" }, { messages: [userMessage(`确认 ${code}`)] } as never);
    expect(outputText(replay)).toContain("confirmation_required");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("keeps read-only tools ungated", async () => {
    const { plugin, client } = await buildPlugin();
    const { tool } = await channelTools(plugin, SCOPE_A);

    const output = await tool("luckin-listShops").execute({ city: "上海" }, { messages: [] } as never);
    expect(outputText(output)).toBe("upstream-ok");
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("gates unknown tools until the user confirms", async () => {
    const { plugin, client } = await buildPlugin();
    const { tool } = await channelTools(plugin, SCOPE_A);
    const unknown = tool("luckin-frobnicate");

    const blocked = await unknown.execute({}, { messages: [] } as never);
    const code = readShortCode(outputText(blocked));
    expect(client.callTool).not.toHaveBeenCalled();

    const allowed = await unknown.execute({}, { messages: [userMessage(`确认 ${code}`)] } as never);
    expect(outputText(allowed)).toBe("upstream-ok");
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it("keeps the short code visible through the artifact wrapper", async () => {
    const { plugin } = await buildPlugin();
    const { tool } = await channelTools(plugin, SCOPE_A);
    const createOrder = tool("luckin-createOrder");

    const output = await createOrder.execute({ item: "coffee" }, { messages: [] } as never);
    const code = readShortCode(outputText(output));

    if (typeof createOrder.toModelOutput !== "function") throw new Error("toModelOutput unavailable");
    const modelOutput = await createOrder.toModelOutput({ output, toolCallId: "call-1" });
    const value = (modelOutput as { value: string }).value;

    expect(value).toContain("confirmation_required");
    expect(value).toContain(code);
  });

  it("clears pending confirmations when the plugin stops", async () => {
    const { plugin, client } = await buildPlugin();
    const { tool } = await channelTools(plugin, SCOPE_A);
    const createOrder = tool("luckin-createOrder");

    const blocked = await createOrder.execute({ item: "coffee" }, { messages: [] } as never);
    const code = readShortCode(outputText(blocked));

    await plugin.stop();

    const afterStop = await createOrder.execute({ item: "coffee" }, { messages: [userMessage(`确认 ${code}`)] } as never);
    expect(outputText(afterStop)).toContain("confirmation_required");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("publishes both guidance blocks once and keeps remote descriptions", async () => {
    const { plugin } = await buildPlugin();
    const { agentPlugin, tool } = await channelTools(plugin, SCOPE_A);

    expect(tool("luckin-createOrder").description).toBe("创建订单");
    if (typeof agentPlugin.appendSystemPrompt !== "function") throw new Error("appendSystemPrompt unavailable");
    const prompt = String(await agentPlugin.appendSystemPrompt({} as never));

    expect(prompt.match(/artifact:\/\//g)?.length).toBe(1);
    expect(prompt).toContain("确认 <短码>");
  });
});
