import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgent, createAgentChannel, createMemoryStorage, createPluginHost, createStateManager, createUserMessage } from "@yesimbot/agent-runtime";
import { Context } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { Agents } from "../../../core/src/agents/index.js";
import { buildCoreSystemPrompt } from "../../../core/src/runtimes/prompt.js";
import RoleplayPlugin from "../src/index.js";

const roots: string[] = [];

function createPng(card: unknown): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const data = Buffer.from(`ccv3\0${Buffer.from(JSON.stringify(card)).toString("base64")}`);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([signature, length, Buffer.from("tEXt"), data, Buffer.alloc(4)]);
}

async function createCardFile(
  overrides: { readonly description?: string; readonly firstMes?: string; readonly roleFields?: Record<string, string> } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-roleplay-plugin-"));
  roots.push(root);
  const path = join(root, "card.png");
  await writeFile(
    path,
    createPng({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "Athena",
        description: overrides.description ?? "",
        personality: "",
        scenario: "",
        first_mes: overrides.firstMes ?? "First {{user}}",
        mes_example: "",
        alternate_greetings: ["Alternate {{user}}"],
        group_only_greetings: [],
        character_version: "1",
        creator_notes: "",
        system_prompt: "",
        post_history_instructions: "",
        tags: [],
        creator: "",
        extensions: {},
        ...overrides.roleFields,
      },
    }),
  );
  return path;
}

async function entries(plugin: Parameters<typeof createPluginHost>[0]["plugins"][number]) {
  const storage = createMemoryStorage();
  const channel = createAgentChannel();
  const state = createStateManager({ storage });
  const host = createPluginHost({ plugins: [plugin], runtime: { id: "channel", channel, state, storage } });
  await host.init();
  return storage.read();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("RoleplayPlugin", () => {
  it("hands one frozen complete card to Core before interaction, without a per-step prefix", async () => {
    const path = await createCardFile({
      description: "CARD_SENTINEL {{pick:calm,bright}}",
      firstMes: "GREETING {{pick:calm,bright}}",
      roleFields: {
        personality: "PERSONALITY_SENTINEL",
        scenario: "SCENARIO_SENTINEL",
        system_prompt: "SYSTEM_SENTINEL",
        mes_example: "<START>\n{{char}}: EXAMPLE_SENTINEL",
        post_history_instructions: "POST_SENTINEL",
      },
    });
    const basePath = join(path, "..");
    await writeFile(join(basePath, "PERSONA.md"), "PRIMARY_PERSONA_SENTINEL");
    const agents = new Agents(new Context());
    const ctx = { baseDir: basePath, logger: () => ({}), on: vi.fn(), yesimbot: { agent: agents } } as unknown as Context;
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const plugin = new RoleplayPlugin(ctx, { characterCard: "card.png" });
    await plugin.start();
    const scope = { type: "direct", platform: "test", selfId: "bot", channelId: "user" } as const;
    const profile = await agents.resolveRoleProfile(scope);
    const plugins = await agents.setup(scope, {} as never, { polisherActive: false, rolePromptsManaged: true } as never);
    const systemPrompt = vi.fn(() => buildCoreSystemPrompt({ basePath, channel: scope, selfId: "bot", roleProfile: profile }));
    const requests: string[] = [];
    const agent = createAgent({
      id: "managed-role",
      plugins,
      systemPrompt,
      storage: createMemoryStorage(),
      maxRetries: 0,
      model: { specificationVersion: "v3", provider: "test", modelId: "test", supportedUrls: {}, doStream: vi.fn() } as never,
      beforeModelRequest: (context) => {
        requests.push(JSON.stringify([context.system, context.messages]));
        throw new Error("Captured request; no provider call needed");
      },
    });
    try {
      await agent.init();
      await writeFile(join(basePath, "PERSONA.md"), "EDITED_AFTER_INIT");
      for (const text of ["first", "second"])
        for await (const _event of agent.run(createUserMessage(text))) {
          /* consume */
        }
      expect(systemPrompt).toHaveBeenCalledOnce();
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.split("CARD_SENTINEL")).toHaveLength(2);
        expect(request).toContain("CARD_SENTINEL bright");
        expect(request).toContain("GREETING bright");
        for (const marker of ["PERSONALITY_SENTINEL", "SCENARIO_SENTINEL", "SYSTEM_SENTINEL", "EXAMPLE_SENTINEL", "POST_SENTINEL"]) {
          expect(request.split(marker)).toHaveLength(2);
          expect(request.indexOf(marker)).toBeLessThan(request.indexOf("# 互动策略"));
        }
        expect(request).toContain("style and behavior examples, not events from the current conversation");
        expect(request).not.toContain("EDITED_AFTER_INIT");
        expect(request.indexOf("PRIMARY_PERSONA_SENTINEL")).toBeLessThan(request.indexOf("CARD_SENTINEL"));
        expect(request.indexOf("CARD_SENTINEL")).toBeLessThan(request.indexOf("# 互动策略"));
        expect(request.indexOf("# 互动策略")).toBeLessThan(request.indexOf("# 能力与证据边界"));
      }
      expect(plugins[0]?.appendSystemPrompt).toBeUndefined();
      expect(plugins[0]?.prepareStep).toBeUndefined();
    } finally {
      await agent.stop();
      await plugin.stop();
    }
  });
  it("does not register a role when stopped while its card is loading", async () => {
    const path = await createCardFile();
    const dispose = vi.fn();
    const use = vi.fn(() => dispose);
    const profile = vi.fn(() => vi.fn());
    const ctx = {
      baseDir: join(path, ".."),
      logger: () => ({}),
      on: vi.fn(),
      yesimbot: { agent: { use }, polisher: { profile } },
    } as unknown as Context;
    const plugin = new RoleplayPlugin(ctx, { characterCard: "card.png" });
    const loading = plugin.start();
    await plugin.stop();
    await loading;
    expect(use).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
    // A later deliberate start still works and its registration can be disposed.
    await plugin.start();
    expect(use).toHaveBeenCalledOnce();
    await plugin.stop();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("seeds a greeting only for direct conversations", async () => {
    const path = await createCardFile();
    const plugins: RoleplayPlugin[] = [];
    const dispose = vi.fn();
    const disposeProfile = vi.fn();
    const profile = vi.fn(() => disposeProfile);
    const ctx = {
      baseDir: join(path, ".."),
      logger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() })),
      on: vi.fn(),
      yesimbot: {
        agent: {
          use: vi.fn((entry: RoleplayPlugin) => {
            plugins.push(entry);
            return dispose;
          }),
        },
        polisher: { profile },
      },
    } as unknown as Context;
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const plugin = new RoleplayPlugin(ctx, { characterCard: "card.png", useRandomGreeting: true });

    await plugin.start();

    const direct = await plugins[0]!.setup({ type: "direct", platform: "test", selfId: "bot", channelId: "direct-user" }, {} as never);
    const shared = await plugins[0]!.setup({ type: "guild", platform: "test", channelId: "group", guildId: "group" }, {} as never);

    await expect(entries(direct as never)).resolves.toEqual([
      expect.objectContaining({ type: "message", data: expect.objectContaining({ role: "assistant", content: "Alternate direct-user" }) }),
    ]);
    await expect(entries(shared as never)).resolves.toEqual([]);
    expect(Math.random).toHaveBeenCalledOnce();
    expect(profile).toHaveBeenCalledWith(plugin);
    expect(plugin.resolve({ type: "direct", platform: "test", selfId: "bot", channelId: "direct-user" })).toEqual({ characterDefinition: "Name: Athena" });
    await plugin.stop();
    expect(disposeProfile).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("shares per-channel card placeholder choices between the polisher profile and greeting", async () => {
    const path = await createCardFile({
      description: "Mood: {{pick:calm,bright}}.",
      firstMes: "I am {{pick:calm,bright}}.",
    });
    const ctx = {
      baseDir: join(path, ".."),
      logger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() })),
      on: vi.fn(),
      yesimbot: { agent: { use: vi.fn(() => vi.fn()) } },
    } as unknown as Context;
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const plugin = new RoleplayPlugin(ctx, { characterCard: "card.png" });
    const scope = { type: "direct", platform: "test", selfId: "bot", channelId: "direct-user" } as const;

    await plugin.start();
    const profile = plugin.resolve(scope);
    const delegated = plugin.setup(scope, {} as never, { polisherActive: true } as never);

    expect(profile?.characterDefinition).toContain("Mood: bright.");
    await expect(entries(delegated)).resolves.toEqual([
      expect.objectContaining({ type: "message", data: expect.objectContaining({ content: "I am bright." }) }),
    ]);
    await plugin.stop();
  });

  it("keeps role profiles separate for different bots speaking to the same direct user", async () => {
    const path = await createCardFile({ description: "Mood: {{pick:calm,bright}}.", firstMes: "" });
    const ctx = {
      baseDir: join(path, ".."),
      logger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() })),
      on: vi.fn(),
      yesimbot: { agent: { use: vi.fn(() => vi.fn()) } },
    } as unknown as Context;
    vi.spyOn(Math, "random").mockReturnValueOnce(0.01).mockReturnValueOnce(0.99);
    const plugin = new RoleplayPlugin(ctx, { characterCard: "card.png" });
    await plugin.start();

    const first = plugin.resolve({ type: "direct", platform: "test", selfId: "bot-a", channelId: "user", userId: "user" });
    const second = plugin.resolve({ type: "direct", platform: "test", selfId: "bot-b", channelId: "user", userId: "user" });
    expect(first?.characterDefinition).toContain("Mood: calm.");
    expect(second?.characterDefinition).toContain("Mood: bright.");
    await plugin.stop();
  });

  it("does not seed a greeting when disabled", async () => {
    const path = await createCardFile();
    const plugins: RoleplayPlugin[] = [];
    const ctx = {
      baseDir: join(path, ".."),
      logger: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn() })),
      on: vi.fn(),
      yesimbot: {
        agent: {
          use: vi.fn((entry: RoleplayPlugin) => {
            plugins.push(entry);
            return vi.fn();
          }),
        },
      },
    } as unknown as Context;
    const plugin = new RoleplayPlugin(ctx, { characterCard: "card.png", enableGreeting: false });

    await plugin.start();

    const direct = await plugins[0]!.setup({ type: "direct", platform: "test", selfId: "bot", channelId: "direct-user" }, {} as never);
    await expect(entries(direct as never)).resolves.toEqual([]);
  });
});
