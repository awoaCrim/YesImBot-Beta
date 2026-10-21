import { constants } from "node:fs";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRequestProjection, createAgentChannel, createMemoryStorage, createPluginHost, createStateManager } from "@yesimbot/agent-runtime";
import { Context } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), stat: vi.fn(actual.stat) };
});

import { RESOURCE_MAX_BYTES } from "../../../core/src/resources/index.js";
import { buildCoreSystemPrompt } from "../../../core/src/runtimes/prompt.js";
import RoleplayPlugin, { type RoleplayPluginConfig } from "../src/index.js";
import { loadVisualReference, VISUAL_REFERENCE_INSTRUCTIONS } from "../src/visual-reference.js";

const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII=", "base64");
const scope = { type: "direct", platform: "test", selfId: "bot", channelId: "user" } as const;
const roots: string[] = [];
const plugins: RoleplayPlugin[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "yesimbot-role-visual-"));
  roots.push(value);
  return value;
}

async function fixture(settings: Partial<RoleplayPluginConfig> = {}) {
  const baseDir = await root();
  const data = Buffer.from(
    `ccv3\0${Buffer.from(
      JSON.stringify({
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: {
          name: "VisualFixture",
          description: "SYNTHETIC_VISUAL_CHARACTER",
          personality: "",
          scenario: "",
          first_mes: "",
          mes_example: "<START>\n{{user}}: SYNTHETIC_SEED_QUESTION\n{{char}}: SYNTHETIC_SEED_ANSWER",
          alternate_greetings: [],
          group_only_greetings: [],
          character_version: "1",
          creator_notes: "",
          system_prompt: "SYNTHETIC_CARD_RULE",
          post_history_instructions: "SYNTHETIC_POST_RULE",
          tags: [],
          creator: "",
          extensions: {},
        },
      }),
    ).toString("base64")}`,
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  await writeFile(join(baseDir, "card.png"), Buffer.concat([image.subarray(0, 8), length, Buffer.from("tEXt"), data, Buffer.alloc(4)]));
  const use = vi.fn(() => vi.fn());
  const config: RoleplayPluginConfig = { characterCard: "card.png", enableGreeting: false, ...settings };
  const ctx = {
    baseDir,
    logger: () => ({}),
    on: vi.fn(),
    yesimbot: { agent: { use } },
  } as unknown as Context;
  const plugin = new RoleplayPlugin(ctx, config);
  plugins.push(plugin);
  return { baseDir, plugin, config, use };
}

async function host(f: Awaited<ReturnType<typeof fixture>>, managed: boolean) {
  const profile = f.plugin.resolve(scope);
  const plugin = f.plugin.setup(scope, {} as never, managed ? ({ rolePromptsManaged: true } as never) : undefined);
  const storage = createMemoryStorage();
  const channel = createAgentChannel();
  const state = createStateManager({ storage });
  const value = createPluginHost({ plugins: [plugin], runtime: { id: "visual", channel, state, storage } });
  await value.init();
  const projection = new AgentRequestProjection();
  const context = { runtime: { id: "visual" }, channel, state, projection, turnId: "turn", stepNumber: 0 };
  return { profile, plugin, storage, value, projection, context };
}

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((plugin) => plugin.stop()));
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("visual self-reference settings and loading", () => {
  it("exposes a default-off toggle and a local image path in roleplay settings", () => {
    type Node = { type?: string; dict?: Record<string, number>; meta?: { default?: unknown; description?: string } };
    const schema = RoleplayPlugin.Config.toJSON() as { uid: number; refs: Record<string, Node> };
    const fields = schema.refs[String(schema.uid)]?.dict;
    const toggle = schema.refs[String(fields?.enableVisualReference)];
    expect(toggle).toMatchObject({ type: "boolean", meta: { default: false } });
    expect(toggle?.meta?.description).toMatch(/视觉|参照/);
    expect(schema.refs[String(fields?.visualReferenceImage)]?.meta?.description).toMatch(/图片|路径/);
  });

  it.each([undefined, false])("does not read or attribute an image when enabled=%s", async (enabled) => {
    const f = await fixture({ enableVisualReference: enabled, visualReferenceImage: "missing-reference.png" });
    await f.plugin.start();
    const h = await host(f, true);
    expect(h.profile?.roleInstructions).not.toContain(VISUAL_REFERENCE_INSTRUCTIONS);
    expect(h.plugin.prepareStep).toBeUndefined();
    expect(h.plugin.appendSystemPrompt).toBeUndefined();
    expect(await h.storage.read()).toEqual([]);
  });

  it.each([undefined, "", "   "])("rejects an enabled setting without an image path (%j)", async (path) => {
    const f = await fixture({ enableVisualReference: true, visualReferenceImage: path });
    await expect(f.plugin.start()).rejects.toThrow(/visualReferenceImage|image path|图片|路径/i);
    expect(f.use).not.toHaveBeenCalled();
  });

  it("fails without registration when the configured image is missing or unsupported", async () => {
    const f = await fixture({ enableVisualReference: true, visualReferenceImage: "reference.png" });
    await expect(f.plugin.start()).rejects.toThrow();
    await writeFile(join(f.baseDir, "reference.png"), "not an image");
    await expect(f.plugin.start()).rejects.toThrow(/PNG|JPEG|WebP|image/i);
    expect(f.use).not.toHaveBeenCalled();
  });

  it("retains the original bytes and detects MIME from content rather than extension", async () => {
    const directory = await root();
    const path = join(directory, "reference.data");
    await writeFile(path, image);
    const value = await loadVisualReference(path);
    expect(value.mediaType).toBe("image/png");
    expect(Buffer.from(value.image)).toEqual(image);
  });

  it.each([
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9])],
    ["image/webp", Buffer.from("RIFF0000WEBPVP8 ")],
  ] as const)("admits the existing detector's %s result", async (mediaType, bytes) => {
    const directory = await root();
    const path = join(directory, "reference.bin");
    await writeFile(path, bytes);
    const value = await loadVisualReference(path);
    expect(value.mediaType).toBe(mediaType);
    expect(Buffer.from(value.image)).toEqual(bytes);
  });

  it("rejects non-files, empty files, GIF and oversized files", async () => {
    const directory = await root();
    await expect(loadVisualReference(directory)).rejects.toThrow();
    const path = join(directory, "reference.bin");
    await writeFile(path, Buffer.alloc(0));
    await expect(loadVisualReference(path)).rejects.toThrow();
    await writeFile(path, Buffer.from("GIF89aSYNTHETIC"));
    await expect(loadVisualReference(path)).rejects.toThrow(/PNG|JPEG|WebP|image/i);
    await writeFile(path, Buffer.alloc(RESOURCE_MAX_BYTES + 1));
    await expect(loadVisualReference(path)).rejects.toThrow(/large|limit|MiB|bytes|大小/i);
    const boundary = Buffer.alloc(RESOURCE_MAX_BYTES);
    image.copy(boundary);
    await writeFile(path, boundary);
    expect((await loadVisualReference(path)).image.byteLength).toBe(RESOURCE_MAX_BYTES);
  });

  it("rejects a non-file before opening it, so a POSIX FIFO cannot block startup", async () => {
    vi.mocked(stat).mockResolvedValueOnce({ isFile: () => false } as Awaited<ReturnType<typeof stat>>);
    vi.mocked(open).mockClear();
    await expect(loadVisualReference("synthetic-fifo")).rejects.toThrow(/regular image file/);
    expect(open).not.toHaveBeenCalled();
  });

  it("uses a nonblocking open and closes a handle replaced with a non-file after precheck", async () => {
    vi.mocked(stat).mockResolvedValueOnce({ isFile: () => true } as Awaited<ReturnType<typeof stat>>);
    const close = vi.fn(async () => {});
    vi.mocked(open).mockResolvedValueOnce({ stat: async () => ({ isFile: () => false }), close } as Awaited<ReturnType<typeof open>>);
    await expect(loadVisualReference("changed-file")).rejects.toThrow(/regular image file/);
    expect(open).toHaveBeenLastCalledWith("changed-file", constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not register if stopped while the reference is loading", async () => {
    const f = await fixture({ enableVisualReference: true, visualReferenceImage: "reference.png" });
    await writeFile(join(f.baseDir, "reference.png"), image);
    const loading = f.plugin.start();
    await f.plugin.stop();
    await loading;
    expect(f.use).not.toHaveBeenCalled();
    await f.plugin.start();
    expect(f.use).toHaveBeenCalledOnce();
  });
});

describe("fixed visual request prefix", () => {
  it.each([false, true].flatMap((managed) => [false, true].map((history) => ({ managed, history }))))(
    "binds the image in the stable role, before optional examples and real dialogue (managed=$managed, history=$history)",
    async ({ managed, history }) => {
      const f = await fixture({ enableVisualReference: true, visualReferenceImage: "reference.png", exampleDialoguesAsHistory: history });
      await writeFile(join(f.baseDir, "reference.png"), image);
      await f.plugin.start();
      const h = await host(f, managed);
      const system = { role: "system" as const, content: "LEADING_SYSTEM" };
      const current = { role: "user" as const, content: "REAL_CURRENT" };
      const prepared = await h.value.helpers.prepareStep([system, current], h.context);
      expect(prepared[0]).toBe(system);
      const reference = prepared[1]!;
      expect(reference.role).toBe("user");
      expect(Array.isArray(reference.content)).toBe(true);
      if (!Array.isArray(reference.content)) throw new Error("Expected multimodal reference");
      expect(reference.content).toContainEqual(expect.objectContaining({ type: "image", image: new Uint8Array(image), mediaType: "image/png" }));
      expect(JSON.stringify(reference)).toContain("role_visual_reference");
      expect(reference).not.toHaveProperty("id");
      expect(reference).not.toHaveProperty("timestamp");
      expect(prepared.at(-1)).toBe(current);
      expect(prepared.slice(2, -1)).toEqual(
        history
          ? [
              { role: "user", content: "SYNTHETIC_SEED_QUESTION" },
              { role: "assistant", content: "SYNTHETIC_SEED_ANSWER" },
            ]
          : [],
      );
      for (const message of prepared.slice(1, -1)) expect(h.projection.origin(message)).toEqual({ kind: "mandatory", sourceEntryIds: [] });
      const prompts = managed
        ? await buildCoreSystemPrompt({ basePath: f.baseDir, channel: scope, selfId: "bot", roleProfile: h.profile })
        : h.value.stablePromptBlocks;
      const serialized = JSON.stringify(prompts);
      expect(
        prompts
          .map((message) => String(message.content))
          .join("\n")
          .split(VISUAL_REFERENCE_INSTRUCTIONS),
      ).toHaveLength(2);
      expect(serialized).not.toContain(image.toString("base64"));
      if (managed) {
        expect(h.plugin.appendSystemPrompt).toBeUndefined();
        const role = prompts.find((message) => String(message.content).startsWith("# 角色"));
        expect(role?.content).toContain(VISUAL_REFERENCE_INSTRUCTIONS);
      }
      expect(await h.storage.read()).toEqual([]);
    },
  );

  it("reinjects the same prefix on continuations/rebuilds and never deduplicates genuine matching messages", async () => {
    const f = await fixture({ enableVisualReference: true, visualReferenceImage: "reference.png", exampleDialoguesAsHistory: true });
    await writeFile(join(f.baseDir, "reference.png"), image);
    await f.plugin.start();
    const h = await host(f, true);
    const current = { role: "user" as const, content: "REAL_CURRENT" };
    const first = await h.value.helpers.prepareStep([current], h.context);
    const owned = first[0]!;
    const genuine = { ...owned };
    const call = { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "signed", toolName: "lookup", input: {} }] };
    const result = {
      role: "tool" as const,
      content: [{ type: "tool-result" as const, toolCallId: "signed", toolName: "lookup", output: { type: "text" as const, value: "LOOKUP_RESULT" } }],
    };
    for (const messages of [
      [...first, genuine, call, result],
      [genuine, current, call, result],
    ]) {
      const prepared = await h.value.helpers.prepareStep(messages, { ...h.context, stepNumber: 2 });
      expect(prepared.filter((message) => message === owned)).toHaveLength(1);
      expect(prepared[0]).toBe(owned);
      expect(prepared).toContain(genuine);
      expect(prepared.at(-2)).toBe(call);
      expect(prepared.at(-1)).toBe(result);
    }
    expect(await h.storage.read()).toEqual([]);
  });

  it("refreshes cached bytes on reload and removes instructions and prefix when disabled", async () => {
    const f = await fixture({ enableVisualReference: true, visualReferenceImage: "reference.png" });
    const path = join(f.baseDir, "reference.png");
    await writeFile(path, image);
    await f.plugin.start();
    const first = await host(f, true);
    const current = { role: "user" as const, content: "CURRENT" };
    await writeFile(path, "now invalid");
    expect((await first.value.helpers.prepareStep([current], first.context))[0]?.content).toContainEqual(
      expect.objectContaining({ type: "image", image: new Uint8Array(image) }),
    );
    await first.value.stop();
    const replacement = Buffer.concat([image, Buffer.from("SYNTHETIC_NEW_BYTES")]);
    await writeFile(path, replacement);
    await f.plugin.start();
    const reloaded = await host(f, true);
    const prepared = await reloaded.value.helpers.prepareStep([current], reloaded.context);
    expect(prepared[0]?.content).toContainEqual(expect.objectContaining({ type: "image", image: new Uint8Array(replacement) }));
    await reloaded.value.stop();
    f.config.enableVisualReference = false;
    f.config.visualReferenceImage = "missing-on-disabled-reload.png";
    await f.plugin.start();
    const disabled = await host(f, true);
    expect(disabled.profile?.roleInstructions).not.toContain(VISUAL_REFERENCE_INSTRUCTIONS);
    expect(disabled.plugin.prepareStep).toBeUndefined();
  });
});
