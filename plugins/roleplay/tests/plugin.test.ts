import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentChannel, createMemoryStorage, createPluginHost, createStateManager } from "@yesimbot/agent-runtime";
import type { Context } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import RoleplayPlugin from "../src/index.js";

const roots: string[] = [];

function createPng(card: unknown): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const data = Buffer.from(`ccv3\0${Buffer.from(JSON.stringify(card)).toString("base64")}`);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([signature, length, Buffer.from("tEXt"), data, Buffer.alloc(4)]);
}

async function createCardFile(overrides: { readonly description?: string; readonly firstMes?: string } = {}): Promise<string> {
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
