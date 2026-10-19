import type { AgentPlugin, AgentTool } from "@yesimbot/agent-runtime";
import { describe, expect, it, vi } from "vitest";

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

import McpClientPlugin from "../src/index";

type ToolListChangedHandler = () => unknown;

function createLogger() {
  return { debug: vi.fn<() => void>(), error: vi.fn<() => void>(), info: vi.fn<() => void>(), success: vi.fn<() => void>(), warn: vi.fn<() => void>() };
}

function createContext() {
  const scopedLogger = createLogger();
  const rootLogger = Object.assign(
    vi.fn<() => ReturnType<typeof createLogger>>(() => scopedLogger),
    createLogger(),
  );
  const plugins: AgentPlugin[] = [];
  const disposers: Array<ReturnType<typeof vi.fn<() => void>>> = [];
  const artifactWriter = { put: vi.fn(async () => "artifact://test-tool/019d3b7e-1bd0-7e4f-9c5d-5bf3fd41f1d4") };
  const ctx = {
    logger: rootLogger,
    on: vi.fn<() => void>(),
    yesimbot: {
      agent: {
        use: vi.fn((plugin: AgentPlugin) => {
          plugins.push(plugin);
          const dispose = vi.fn<() => void>();
          disposers.push(dispose);
          return dispose;
        }),
      },
      resource: { get: vi.fn(async () => ({ path: "/tmp", assets: {}, artifacts: { forTool: vi.fn(() => artifactWriter) } })) },
    },
  };

  return { ctx, disposers, plugins, artifactWriter };
}

function createClient(toolBatches: string[][]) {
  let batchIndex = 0;
  let toolListChanged: ToolListChangedHandler | undefined;
  const client = {
    callTool: vi.fn<() => Promise<unknown>>(),
    close: vi.fn<() => Promise<void>>(),
    listTools: vi.fn<() => Promise<{ tools: Array<{ name: string; description: string; inputSchema: { type: string } }> }>>(async () => {
      const names = toolBatches[Math.min(batchIndex, toolBatches.length - 1)] ?? [];
      batchIndex += 1;
      return { tools: names.map((name) => ({ name, description: `${name} description`, inputSchema: { type: "object" } })) };
    }),
    setNotificationHandler: vi.fn<(schema: unknown, handler: ToolListChangedHandler) => void>((_schema, handler) => {
      toolListChanged = handler;
    }),
  };

  return {
    client,
    async emitToolListChanged() {
      if (!toolListChanged) {
        throw new Error("tool list changed handler not registered");
      }
      await toolListChanged();
    },
  };
}

async function resolveTools(plugin: AgentPlugin): Promise<AgentTool[]> {
  const tools = typeof plugin.tools === "function" ? await plugin.tools({} as never) : plugin.tools;
  return tools ?? [];
}

async function resolveToolNames(plugin: AgentPlugin): Promise<string[]> {
  return (await resolveTools(plugin)).map((tool) => tool.name);
}

function outputText(output: unknown): string {
  if (!Array.isArray(output)) throw new Error(`expected MCP content array, received ${typeof output}`);
  const block = output[0] as { type?: unknown; text?: unknown };
  if (block?.type !== "text" || typeof block.text !== "string") throw new Error("expected a single MCP text block");
  return block.text;
}
describe("mcp-client tool registry", () => {
  it("refreshes stable tools when a server reports tool list changes", async () => {
    const { client, emitToolListChanged } = createClient([["beta", "alpha"], ["gamma"]]);
    const { ctx, disposers, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn<() => Promise<void>>() } });

    const plugin = new McpClientPlugin(ctx as never, {
      allowedScopes: [{ platform: "test", channelId: "room" }],
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
    });

    await plugin.start();

    const channelScope = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as never;
    const runtimePlugin = await plugins[0]!.setup(channelScope, {} as never);
    expect(client.setNotificationHandler).toHaveBeenCalledOnce();
    expect(await resolveToolNames(runtimePlugin!)).toEqual(["docs-alpha", "docs-beta"]);

    await emitToolListChanged();

    expect(client.listTools).toHaveBeenCalledTimes(2);
    expect(disposers[0]).toHaveBeenCalledOnce();
    expect(ctx.yesimbot.agent.use).toHaveBeenCalledTimes(2);
    expect(await resolveToolNames(await plugins[1]!.setup(channelScope, {} as never))).toEqual(["docs-gamma"]);
  });
  it("invalidates pending confirmations when a catalog refresh publishes replacement tools", async () => {
    const { client, emitToolListChanged } = createClient([["createOrder"], ["createOrder"]]);
    client.callTool.mockResolvedValue({ content: [{ text: "upstream", type: "text" }] });
    const { ctx, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn<() => Promise<void>>() } });

    const plugin = new McpClientPlugin(ctx as never, {
      allowedScopes: [{ platform: "test", channelId: "room" }],
      mcpServers: { luckin: { type: "http", url: "https://example.test/mcp" } },
    });
    await plugin.start();

    const channelScope = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as never;
    const firstTools = await resolveTools(await plugins[0]!.setup(channelScope, {} as never));
    const firstTool = firstTools.find((tool) => tool.name === "luckin-createOrder");
    if (!firstTool) throw new Error("initial side-effect tool missing");

    const blocked = await firstTool.execute({}, { messages: [] } as never);
    const code = /确认短码: ([A-Z0-9]{6})/.exec(outputText(blocked))?.[1];
    if (!code) throw new Error("initial confirmation code missing");

    await emitToolListChanged();

    const refreshedTools = await resolveTools(await plugins[1]!.setup(channelScope, {} as never));
    const refreshedTool = refreshedTools.find((tool) => tool.name === "luckin-createOrder");
    if (!refreshedTool) throw new Error("refreshed side-effect tool missing");

    const replay = await refreshedTool.execute({}, { messages: [{ content: `确认 ${code}`, role: "user" }] } as never);
    expect(outputText(replay)).toContain("confirmation_required");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("applies the configured allowlist to group and direct runtimes", async () => {
    const { client } = createClient([["search"]]);
    const { ctx, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn<() => Promise<void>>() } });

    const plugin = new McpClientPlugin(ctx as never, {
      allowedScopes: [{ platform: "test", channelId: "room" }],
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
    });
    await plugin.start();

    const denied = await plugins[0]!.setup({ type: "guild", platform: "test", channelId: "other", guildId: "other" } as never, {} as never);
    expect(await resolveToolNames(denied!)).toEqual([]);

    const allowed = await plugins[0]!.setup({ type: "guild", platform: "test", channelId: "room", guildId: "room" } as never, {} as never);
    expect(await resolveToolNames(allowed!)).toEqual(["docs-search"]);

    const direct = await plugins[0]!.setup({ type: "direct", platform: "test", channelId: "private:100", userId: "100", selfId: "bot" } as never, {} as never);
    expect(await resolveToolNames(direct!)).toEqual([]);
  });

  it("checks group senders at exposure and execution without bypassing server confirmation", async () => {
    const { client } = createClient([["createOrder"]]);
    const { ctx, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn() } });
    const plugin = new McpClientPlugin(ctx as never, {
      allowedScopes: [{ platform: "test", channelId: "*", userId: "operator" }],
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
    });
    await plugin.start();
    const runtime = await plugins[0]!.setup({ type: "guild", platform: "test", channelId: "room", guildId: "room" } as never, { selfId: "bot" } as never);
    if (!runtime) throw new Error("MCP runtime missing");
    const tools = await resolveTools(runtime);
    const context = (actor: string) =>
      ({ turnId: "turn", stepNumber: 0, messages: [{ id: "input-id", role: "custom", type: "yesimbot.message", data: { user: { id: actor } } }] }) as never;
    expect(await runtime.filterTools?.(tools, context("operator"))).toBe(tools);
    expect(await runtime.filterTools?.(tools, context("other"))).toEqual([]);
    expect(await runtime.beforeToolCall?.({ toolName: "docs-createOrder", toolCallId: "call", args: { private: "SECRET" } }, context("other"))).toEqual({
      type: "block",
      reason: "当前消息发送者不在 MCP 工具白名单中",
    });
    expect(ctx.logger().info).toHaveBeenCalledWith("tool.access", expect.objectContaining({ phase: "execute", actorIds: ["other"], reason: "actor-denied" }));
    const blocked = await tools[0]!.execute({}, context("operator"));
    expect(outputText(blocked)).toContain("confirmation_required");
    expect(client.callTool).not.toHaveBeenCalled();
    await plugin.stop();
  });

  it("updates server-level confirmation for newly published catalog snapshots", async () => {
    const { client, emitToolListChanged } = createClient([["createOrder"], ["createOrder"]]);
    client.callTool.mockResolvedValue({ content: [{ text: "upstream", type: "text" }] });
    const { ctx, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn<() => Promise<void>>() } });
    const config = {
      allowedScopes: [{ platform: "test", channelId: "*" }],
      mcpServers: { orders: { type: "http" as const, url: "https://example.test/mcp", requireConfirmation: false } },
    };
    const plugin = new McpClientPlugin(ctx as never, config);
    await plugin.start();
    const scope = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as never;
    const first = (await resolveTools(await plugins[0]!.setup(scope, {} as never)))[0]!;
    expect(outputText(await first.execute({}, { messages: [] } as never))).toBe("upstream");
    config.mcpServers.orders.requireConfirmation = true;
    await emitToolListChanged();
    const refreshed = (await resolveTools(await plugins[1]!.setup(scope, {} as never)))[0]!;
    expect(outputText(await refreshed.execute({}, { messages: [] } as never))).toContain("confirmation_required");
    expect(client.callTool).toHaveBeenCalledOnce();
  });

  it("disambiguates exposed names after sanitization", async () => {
    const { client } = createClient([["search/tool", "search.tool"]]);
    const { ctx, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn<() => Promise<void>>() } });

    const plugin = new McpClientPlugin(ctx as never, {
      allowedScopes: [{ platform: "test", channelId: "room" }],
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
    });
    await plugin.start();

    const channelScope = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as never;
    const runtimePlugin = await plugins[0]!.setup(channelScope, {} as never);
    expect(await resolveToolNames(runtimePlugin!)).toEqual(["docs-search_tool", "docs-search_tool_2"]);
  });

  it("admits a user rule in any group but filters MCP tools by current sender", async () => {
    const { client } = createClient([["search"]]);
    const { ctx, plugins } = createContext();
    mocks.connectMcpServer.mockResolvedValueOnce({ client, transport: { close: vi.fn<() => Promise<void>>() } });

    const plugin = new McpClientPlugin(ctx as never, {
      allowedScopes: [{ platform: "test", channelId: "*", userId: "100" }],
      mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
    });
    await plugin.start();

    const channelScope = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as never;
    const runtimePlugin = await plugins[0]!.setup(channelScope, {} as never);
    const tools = await resolveTools(runtimePlugin!);
    const message = (userId: string) => ({ role: "custom", type: "yesimbot.message", data: { user: { id: userId } } });

    expect((await runtimePlugin!.filterTools?.(tools, { messages: [message("100")] } as never))?.map((tool) => tool.name)).toEqual(["docs-search"]);
    expect(await runtimePlugin!.filterTools?.(tools, { messages: [message("101")] } as never)).toEqual([]);
    expect(await runtimePlugin!.beforeToolCall?.({ toolCallId: "call", toolName: "docs-search", args: {} }, { messages: [message("101")] } as never)).toEqual({
      type: "block",
      reason: "当前消息发送者不在 MCP 工具白名单中",
    });
  });
});
