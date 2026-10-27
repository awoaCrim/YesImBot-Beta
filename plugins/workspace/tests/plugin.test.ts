import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => {
  const { Schema } = await import("@koishijs/core");
  return { Context: class {}, Logger: class {}, Schema };
});

import WorkspacePlugin, { isHostExecAllowed, isHostExecPotentiallyAllowed } from "../src/index.js";
import type { WorkspacePluginConfig } from "../src/types.js";

async function createWorkspace(config?: WorkspacePluginConfig) {
  const baseDir = await mkdtemp(join(tmpdir(), "yesimbot-workspace-test-"));
  const plugins: WorkspacePlugin[] = [];
  const readers: Array<{ scheme: string; setup: (...args: never[]) => unknown }> = [];
  const disposeAgent = vi.fn();
  const disposeReader = vi.fn();
  const ctx = {
    baseDir,
    logger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
    on: vi.fn(),
    yesimbot: {
      agent: {
        use: vi.fn((plugin: WorkspacePlugin) => {
          plugins.push(plugin);
          return disposeAgent;
        }),
      },
      resource: {
        use: vi.fn((reader: { scheme: string; setup: (...args: never[]) => unknown }) => {
          readers.push(reader);
          return disposeReader;
        }),
        get: vi.fn(async () => ({ path: baseDir, assets: {}, artifacts: {} })),
      },
    },
  };
  const resolvedConfig = config ?? { bash: { cwd: baseDir, timeoutMs: 1000, enableNetwork: false, mounts: [] } };
  const plugin = new WorkspacePlugin(ctx as never, resolvedConfig);
  return { baseDir, ctx, config: resolvedConfig, disposeAgent, disposeReader, plugin, plugins, readers };
}

describe("WorkspacePlugin", () => {
  it("matches Host execution by allowlist fields and current group actors", () => {
    const rule = { platform: "onebot", channelId: "*", userId: "1049700117", selfId: "3535802886" };
    const group = { type: "guild" as const, platform: "onebot", channelId: "group-1", guildId: "group-1", selfId: "3535802886" };

    expect(isHostExecPotentiallyAllowed(group, [rule])).toBe(true);
    expect(isHostExecAllowed(group, [rule], ["1049700117"])).toBe(true);
    expect(isHostExecAllowed(group, [rule], ["other"])).toBe(false);
    expect(isHostExecAllowed(group, [rule])).toBe(false);
    expect(isHostExecAllowed({ type: "direct", platform: "onebot", channelId: "private:1049700117", selfId: "3535802886", userId: "1049700117" }, [rule])).toBe(
      true,
    );
    expect(isHostExecAllowed({ type: "direct", platform: "other", channelId: "private:1049700117", selfId: "3535802886", userId: "1049700117" }, [rule])).toBe(
      false,
    );
  });

  it("registers named ResourceReader objects and one agent plugin on start", async () => {
    const fixture = await createWorkspace();
    try {
      await fixture.plugin.start();

      expect(fixture.ctx.yesimbot.agent.use).toHaveBeenCalledOnce();
      expect(fixture.plugins).toHaveLength(1);
      expect(fixture.ctx.yesimbot.resource.use).toHaveBeenCalledOnce();
      expect(fixture.readers.map((reader) => reader.scheme)).toEqual(["workspace"]);
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it("initializes a channel-scoped workspace agent through resource.get", async () => {
    const fixture = await createWorkspace();
    try {
      await fixture.plugin.start();
      const agentPlugin = await fixture.plugins[0]!.setup({ type: "guild", platform: "test", channelId: "room", guildId: "room" }, { selfId: "bot" } as never);

      expect(agentPlugin).toBeTruthy();
      expect(fixture.ctx.yesimbot.resource.get).toHaveBeenCalledWith({ type: "guild", platform: "test", channelId: "room", guildId: "room", selfId: "bot" });
      const tools = typeof agentPlugin?.tools === "function" ? ((await agentPlugin.tools({} as never)) ?? []) : [];
      expect(tools.map((tool) => tool.name)).toEqual(["bash", "readFile", "writeFile", "editFile"]);
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it("exposes HTML rendering to scheduled turns without granting host execution", async () => {
    const fixture = await createWorkspace({ htmlRendererUrl: "http://renderer.internal/render", bash: { cwd: "/home/workspace", mounts: [] } });
    try {
      await fixture.plugin.start();
      const plugin = await fixture.plugin.setup({ type: "guild", platform: "test", channelId: "room", guildId: "room" });
      if (!plugin || typeof plugin.tools !== "function") throw new Error("Workspace tools missing");
      const tools = (await plugin.tools({} as never)) ?? [];
      const filtered = (await plugin.filterTools?.(tools, { messages: [] } as never)) ?? tools;
      expect(filtered.map((tool) => tool.name)).toContain("render_html");
      expect(filtered.map((tool) => tool.name)).not.toContain("hostExec");
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it("only provides the sandbox virtual filesystem backend", async () => {
    const fixture = await createWorkspace();
    try {
      await fixture.plugin.start();
      const agentPlugin = await fixture.plugins[0]!.setup({ type: "guild", platform: "test", channelId: "room", guildId: "room" }, { selfId: "bot" } as never);
      const tools = typeof agentPlugin?.tools === "function" ? ((await agentPlugin.tools({} as never)) ?? []) : [];

      expect(tools).toHaveLength(4);
      expect(tools.map((t) => t.name).sort()).toEqual(["bash", "editFile", "readFile", "writeFile"]);
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });

  it("admits hostExec in an authorized group and filters it by the current sender", async () => {
    const fixture = await createWorkspace({
      bash: { cwd: "/home/workspace", timeoutMs: 1000, enableNetwork: false, mounts: [] },
      hostExec: {
        enabled: true,
        allowedChannels: [{ platform: "test", channelId: "*", userId: "allowed", selfId: "bot" }],
        timeoutMs: 1000,
      },
    });
    try {
      await fixture.plugin.start();
      // Exercise real setup/gates on every test host without opening an SSH process.
      Reflect.set(fixture.plugin, "hostRunner", { run: vi.fn(), stop: vi.fn() });
      const agentPlugin = await fixture.plugins[0]!.setup({ type: "guild", platform: "test", channelId: "room", guildId: "room" }, { selfId: "bot" } as never);
      if (!agentPlugin) throw new Error("Workspace agent plugin was not created");
      const tools = typeof agentPlugin.tools === "function" ? ((await agentPlugin.tools({} as never)) ?? []) : (agentPlugin.tools ?? []);
      const message = (userId: string) => ({ id: "input-id", role: "custom", type: "yesimbot.message", data: { user: { id: userId } } });

      expect(tools.map((tool) => tool.name)).toContain("hostExec");
      expect((await agentPlugin.filterTools?.(tools, { messages: [message("allowed")] } as never))?.map((tool) => tool.name)).toContain("hostExec");
      expect((await agentPlugin.filterTools?.(tools, { messages: [message("other")] } as never))?.map((tool) => tool.name)).not.toContain("hostExec");
      expect(await agentPlugin.beforeToolCall?.({ toolCallId: "call", toolName: "hostExec", args: {} }, { messages: [message("other")] } as never)).toEqual({
        type: "block",
        reason: "当前消息发送者不在 Anon 来宾命令工具白名单中",
      });
      const logger = fixture.ctx.logger.mock.results[0]!.value;
      expect(logger.info).toHaveBeenCalledWith(
        "tool.access",
        expect.objectContaining({ phase: "execute", actorIds: ["other"], inputIds: ["input-id"], allowed: false }),
      );
    } finally {
      await fixture.plugin.stop();
      await rm(fixture.baseDir, { recursive: true, force: true });
    }
  });
});
