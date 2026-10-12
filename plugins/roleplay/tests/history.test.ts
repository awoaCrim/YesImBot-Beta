import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentRequestProjection,
  createAgent,
  createAgentChannel,
  createMemoryStorage,
  createPluginHost,
  createStateManager,
  createUserMessage,
} from "@yesimbot/agent-runtime";
import { Context } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { Agents } from "../../../core/src/agents/index.js";
import { Conversation } from "../../../core/src/conversations/index.js";
import { ContextWorkspace } from "../../../core/src/runtimes/context-workspace.js";
import { buildCoreSystemPrompt } from "../../../core/src/runtimes/prompt.js";
import RoleplayPlugin from "../src/index.js";

const roots: string[] = [];
const plugins: RoleplayPlugin[] = [];
const scope = { type: "direct", platform: "test", selfId: "bot-a", channelId: "direct-user", userId: "direct-user" } as const;
const pair = "<START>\n{{user}}: SEED_QUESTION\n{{char}}: SEED_ANSWER";

async function fixture(examples: string, options: { enabled?: boolean; greeting?: boolean; nickname?: string; description?: string } = { enabled: true }) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-role-history-unit-"));
  roots.push(root);
  const data = Buffer.from(
    `ccv3\0${Buffer.from(
      JSON.stringify({
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: {
          name: "RoleFixture",
          ...(options.nickname ? { nickname: options.nickname } : {}),
          description: options.description ?? "SYNTHETIC_DEFINITION",
          personality: "",
          scenario: "",
          first_mes: "HELLO {{user}}",
          mes_example: examples,
          alternate_greetings: [],
          group_only_greetings: [],
          character_version: "1",
          creator_notes: "",
          system_prompt: "SYNTHETIC_SYSTEM",
          post_history_instructions: "SYNTHETIC_POST",
          tags: [],
          creator: "",
          extensions: {},
        },
      }),
    ).toString("base64")}`,
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  await writeFile(join(root, "card.png"), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), length, Buffer.from("tEXt"), data, Buffer.alloc(4)]));
  const agents = new Agents(new Context());
  const ctx = { baseDir: root, logger: () => ({}), on: vi.fn(), yesimbot: { agent: agents } } as unknown as Context;
  const plugin = new RoleplayPlugin(ctx, {
    characterCard: "card.png",
    enableGreeting: options.greeting ?? false,
    ...(options.enabled === undefined ? {} : { exampleDialoguesAsHistory: options.enabled }),
  });
  plugins.push(plugin);
  await plugin.start();
  return { root, agents, plugin };
}

async function host(f: Awaited<ReturnType<typeof fixture>>, managed = true, target = scope) {
  const profile = f.plugin.resolve(target);
  const plugin = f.plugin.setup(target, {} as never, managed ? ({ rolePromptsManaged: true } as never) : undefined);
  const storage = createMemoryStorage();
  const channel = createAgentChannel();
  const state = createStateManager({ storage });
  const value = createPluginHost({ plugins: [plugin], runtime: { id: "unit", channel, state, storage } });
  await value.init();
  const projection = new AgentRequestProjection();
  const context = { runtime: { id: "unit" }, channel, state, projection, turnId: "turn", stepNumber: 0 };
  return { profile, plugin, storage, value, projection, context };
}

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((plugin) => plugin.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("historical example configuration and source parsing", () => {
  it("exposes a default-off control", () => {
    type Node = { dict?: Record<string, number>; type?: string; meta?: { default?: unknown } };
    const schema = RoleplayPlugin.Config.toJSON() as { uid: number; refs: Record<string, Node> };
    const root = schema.refs[String(schema.uid)];
    const control = schema.refs[String(root?.dict?.exampleDialoguesAsHistory)];
    expect(control).toMatchObject({ type: "boolean", meta: { default: false } });
  });

  it.each([undefined, false])("keeps unstructured legacy examples when enabled=%s", async (enabled) => {
    const f = await fixture("UNSTRUCTURED_LEGACY_EXAMPLE", { enabled });
    const h = await host(f);
    expect(h.profile?.roleInstructions).toContain("<example_dialogues>");
    expect(h.profile?.roleInstructions).toContain("UNSTRUCTURED_LEGACY_EXAMPLE");
    expect(h.plugin.prepareStep).toBeUndefined();
    expect(h.plugin.appendSystemPrompt).toBeUndefined();
  });

  it.each(["", " \r\n ", "<START>\n\n<start>\n", "{{comment:synthetic hidden line}}"])("does not add a hook for empty source %j", async (source) => {
    const f = await fixture(source, { enabled: true });
    const h = await host(f);
    expect(h.plugin.prepareStep).toBeUndefined();
    expect(h.profile?.roleInstructions).not.toContain("example_dialogue");
  });

  it.each([
    {
      source: "<START>\r\n{{user}}: SEED_USER\r\nratio: 1:2\r\n{{char}}: SEED_CHAR\r\nsecond line",
      nickname: undefined,
      expected: [
        { role: "user", content: "SEED_USER\nratio: 1:2" },
        { role: "assistant", content: "SEED_CHAR\nsecond line" },
      ],
    },
    {
      source: "<start>\n{{user}}: SEED_ONE\n{{char}}: SEED_TWO\n<START>\n{{char}}: SEED_THREE\n<START>\n{{char}}: SEED_FOUR",
      nickname: undefined,
      expected: [
        { role: "user", content: "SEED_ONE" },
        { role: "assistant", content: "SEED_TWO" },
        { role: "assistant", content: "SEED_THREE" },
        { role: "assistant", content: "SEED_FOUR" },
      ],
    },
    {
      source: "<START>\ndirect-user: SEED_USER\nFixtureAlias: SEED_CHAR",
      nickname: "FixtureAlias",
      expected: [
        { role: "user", content: "SEED_USER" },
        { role: "assistant", content: "SEED_CHAR" },
      ],
    },
    {
      source: "<START>\nRoleFixture: SEED_FULL_NAME\n<START>\nFixtureAlias: SEED_NICKNAME",
      nickname: "FixtureAlias",
      expected: [
        { role: "assistant", content: "SEED_FULL_NAME" },
        { role: "assistant", content: "SEED_NICKNAME" },
      ],
    },
    {
      source: "<START>\n{{ USER }}： SEED_USER {{user}}\n{{ CHAR }}： SEED_CHAR {{char}}",
      nickname: "direct-user",
      expected: [
        { role: "user", content: "SEED_USER direct-user" },
        { role: "assistant", content: "SEED_CHAR direct-user" },
      ],
    },
    {
      source: "<START>\ndirect-user: SEED_USER\nFixture.[x]+: SEED_CHAR",
      nickname: "Fixture.[x]+",
      expected: [
        { role: "user", content: "SEED_USER" },
        { role: "assistant", content: "SEED_CHAR" },
      ],
    },
    {
      source: "<START>\nRoleFixture: extended: SEED_CHAR",
      nickname: "RoleFixture: extended",
      expected: [{ role: "assistant", content: "SEED_CHAR" }],
    },
  ])("preserves explicit source turns without fictional balancing questions ($source)", async ({ source, nickname, expected }) => {
    const f = await fixture(source, { enabled: true, nickname });
    const h = await host(f);
    const current = { role: "user" as const, content: "REAL_CURRENT" };
    const result = await h.value.helpers.prepareStep([current], h.context);
    expect(result.slice(0, -1)).toEqual(expected);
    expect(result.at(-1)).toBe(current);
    for (const message of result.slice(0, -1)) expect(h.projection.origin(message)).toEqual({ kind: "mandatory", sourceEntryIds: [] });
    expect(h.profile?.roleInstructions).not.toMatch(/SEED_|example_dialogue/);
    expect(await h.storage.read()).toEqual([]);
  });

  it("handles the paired-plus-character-only reference shape without copying private source", async () => {
    const source = [
      ...Array.from({ length: 12 }, (_, index) => `<START>\n{{user}}: USER_${index}\n{{char}}: CHAR_${index}`),
      "<START>\n{{char}}: ORIGINAL_SUFFIX_ONE",
      "<START>\n{{char}}: ORIGINAL_SUFFIX_TWO",
    ].join("\n");
    const f = await fixture(source, { enabled: true });
    const h = await host(f);
    const result = await h.value.helpers.prepareStep([{ role: "user", content: "CURRENT" }], h.context);
    expect(result).toHaveLength(27);
    expect(result.slice(-3)).toEqual([
      { role: "assistant", content: "ORIGINAL_SUFFIX_ONE" },
      { role: "assistant", content: "ORIGINAL_SUFFIX_TWO" },
      { role: "user", content: "CURRENT" },
    ]);
  });

  it.each([
    "SECRET_UNLABELED_SOURCE",
    "<START>\nThirdSpeaker: SECRET_UNKNOWN_SOURCE",
    "<START>\n{{user}}: visible\n{{char}}:",
    "<START>\n{{char}}: visible\n<START>\nSECRET_UNOWNED_BLOCK",
    "<START>\n{{char}}: {{hidden_key:SECRET_RENDERED_EMPTY}}",
    "<START>\n{{char}}: visible\n{{speaker}}: SECRET_UNSUPPORTED_TOKEN",
  ])("rejects nonempty unsupported source without leaking it (%#)", async (source) => {
    const f = await fixture(source, { enabled: true });
    let failure: unknown;
    try {
      f.plugin.resolve(scope);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/mes_example|block|格式/i);
    expect(message).not.toContain("SECRET_");
  });

  it("rejects rendered speaker-label ambiguity", async () => {
    const f = await fixture("<START>\nRoleFixture: SECRET_AMBIGUOUS_SOURCE", { enabled: true });
    expect(() => f.plugin.resolve({ ...scope, channelId: "RoleFixture", userId: "RoleFixture" })).toThrow(/ambig|歧义|mes_example/i);
  });
});

describe("request-only role material lifecycle", () => {
  it.each([false, true])("keeps one batch after leading systems on every step (managed=%s)", async (managed) => {
    const f = await fixture(pair, { enabled: true });
    const h = await host(f, managed);
    const leading = { role: "system" as const, content: "LEADING_REFERENCE" };
    const current = { role: "user" as const, content: "CURRENT" };
    const messages = [leading, current];
    const first = await h.value.helpers.prepareStep(messages, h.context);
    const second = await h.value.helpers.prepareStep(first, { ...h.context, stepNumber: 1 });
    const rebuilt = await h.value.helpers.prepareStep(messages, { ...h.context, stepNumber: 2 });
    expect(first).toEqual([leading, { role: "user", content: "SEED_QUESTION" }, { role: "assistant", content: "SEED_ANSWER" }, current]);
    expect(second).toEqual(first);
    expect(rebuilt).toEqual(first);
    expect(first[0]).toBe(leading);
    expect(first.at(-1)).toBe(current);
    expect(await h.storage.read()).toEqual([]);
    if (managed) expect(h.value.stablePromptBlocks).toEqual([]);
    else {
      expect(h.value.stablePromptBlocks).toHaveLength(1);
      expect(JSON.stringify(h.value.stablePromptBlocks)).toContain("SYNTHETIC_SYSTEM");
      expect(JSON.stringify(h.value.stablePromptBlocks)).not.toMatch(/SEED_|example_dialogue/);
    }
  });

  it("retains real identical content rather than deduplicating by text", async () => {
    const f = await fixture(pair, { enabled: true });
    const h = await host(f);
    const identical = { role: "user" as const, content: "SEED_QUESTION" };
    const result = await h.value.helpers.prepareStep([identical], h.context);
    expect(result).toHaveLength(3);
    expect(result.at(-1)).toBe(identical);
  });

  it("renders random/roll once per bot and rerenders only after reload", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.99);
    const f = await fixture("<START>\n{{char}}: SEED_ROLL_{{roll:d6}}", { enabled: true, description: "CARD_{{random:calm,bright}}" });
    const beforeResolve = random.mock.calls.length;
    const profile = f.plugin.resolve(scope);
    expect(profile?.characterDefinition).toContain("CARD_bright");
    expect(random).toHaveBeenCalledTimes(beforeResolve + 2);
    f.plugin.setup(scope, {} as never, { rolePromptsManaged: true } as never);
    expect(random).toHaveBeenCalledTimes(beforeResolve + 2);
    const h = await host(f);
    // State-manager IDs may use Math.random; only measure subsequent role operations.
    const afterHost = random.mock.calls.length;
    expect(h.profile).toBe(profile);
    expect(f.plugin.resolve(scope)).toBe(h.profile);
    for (const stepNumber of [0, 1, 2]) {
      expect(await h.value.helpers.prepareStep([{ role: "user", content: "CURRENT" }], { ...h.context, stepNumber })).toContainEqual({
        role: "assistant",
        content: "SEED_ROLL_6",
      });
      expect(f.plugin.resolve(scope)).toBe(h.profile);
    }
    expect(random).toHaveBeenCalledTimes(afterHost);
    const other = f.plugin.resolve({ ...scope, selfId: "bot-b" });
    expect(other).not.toBe(h.profile);
    expect(random).toHaveBeenCalledTimes(afterHost + 2);
    await f.plugin.stop();
    await f.plugin.start();
    expect(f.plugin.resolve(scope)).not.toBe(h.profile);
    expect(random).toHaveBeenCalledTimes(afterHost + 4);
  });

  it("persists only the normal greeting when enabled", async () => {
    const f = await fixture(pair, { enabled: true, greeting: true });
    const h = await host(f);
    const entries = await h.storage.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "message", data: { role: "assistant", content: "HELLO direct-user" } });
    expect(JSON.stringify(entries)).not.toContain("SEED_");
  });

  it("retains mandatory seeds during the actual Runtime guard rebuild", async () => {
    const f = await fixture(pair, { enabled: true });
    const roleProfile = await f.agents.resolveRoleProfile(scope);
    const setup = await f.agents.setup(scope, {} as never, { rolePromptsManaged: true } as never);
    const projection = new AgentRequestProjection();
    const captured: unknown[] = [];
    const stream = vi.fn();
    const storage = createMemoryStorage();
    const agent = createAgent({
      id: "history-rebuild",
      plugins: setup,
      systemPrompt: () => buildCoreSystemPrompt({ basePath: f.root, channel: scope, selfId: "bot-a", roleProfile }),
      storage,
      requestProjection: projection,
      maxRetries: 0,
      model: { specificationVersion: "v3", provider: "synthetic", modelId: "synthetic", supportedUrls: {}, doStream: stream } as never,
      beforeModelRequest: async (context) => {
        const rebuilt = await context.rebuildMessages();
        expect(rebuilt).toEqual(context.messages);
        const seeds = rebuilt.filter((message) => typeof message.content === "string" && message.content.startsWith("SEED_"));
        expect(seeds).toHaveLength(2);
        expect(projection.describe(seeds)).toEqual([
          { kind: "mandatory", sourceEntryIds: [] },
          { kind: "mandatory", sourceEntryIds: [] },
        ]);
        captured.push(rebuilt);
        throw new Error("captured request without any provider call");
      },
    });
    await agent.init();
    for await (const _event of agent.run(createUserMessage("CURRENT"))) {
      /* consume */
    }
    expect(captured).toHaveLength(1);
    expect(stream).not.toHaveBeenCalled();
    expect(JSON.stringify(await storage.read())).not.toContain("SEED_");
    await agent.stop();
  });

  it("counts fixed seed budget and fails existing mandatory overflow without auxiliary work", async () => {
    const f = await fixture(`<START>\n{{char}}: ${"x".repeat(100000)}`, { enabled: true });
    const h = await host(f);
    const messages = await h.value.helpers.prepareStep([{ role: "user", content: "CURRENT" }], h.context);
    const conversation = new Conversation(join(f.root, "conversation"), { minMessages: 1, maxFailures: 3, mode: "compartment" }, { magicContext: true });
    await conversation.init();
    const model = {
      specificationVersion: "v3" as const,
      provider: "synthetic",
      modelId: "synthetic",
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: vi.fn(),
    };
    const workspace = new ContextWorkspace(conversation, h.projection, {
      config: { contextWindow: 10000, outputReserveTokens: 1000 },
      compactMode: "compartment",
      model,
    });
    try {
      workspace.capture([]);
      await expect(
        workspace.guard({
          model,
          system: "system",
          messages,
          tools: {},
          currentMessageIds: [],
          projection: h.projection,
          historyMode: "conversation",
          turnId: "turn",
          stepNumber: 0,
          signal: new AbortController().signal,
          rebuildMessages: async () => messages,
        }),
      ).rejects.toThrow("ContextBudgetExceeded");
      expect(model.doGenerate).not.toHaveBeenCalled();
      expect(model.doStream).not.toHaveBeenCalled();
      expect(await conversation.contextRegions()).toEqual([]);
      expect(await conversation.storage.read()).toEqual([]);
    } finally {
      workspace.stop();
    }
  });
});
