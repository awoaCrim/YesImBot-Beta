import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import { Context } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { Agents } from "../src/agents/index.js";
import { buildCoreSystemPrompt, DEFAULT_PERSONA, ensureDefaultPersona } from "../src/runtimes/prompt.js";

const roots: string[] = [];
const scope = { type: "direct", platform: "test", channelId: "user", selfId: "bot" } as const;
const card = {
  characterDefinition: "CARD_DEFINITION_SENTINEL",
  roleInstructions: "CARD_INSTRUCTION_SENTINEL\n<example_dialogues>EXAMPLE_SENTINEL</example_dialogues>",
};
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function root() {
  const path = await mkdtemp(join(tmpdir(), "yesimbot-role-prompt-"));
  roots.push(path);
  return path;
}

describe("unified main-Agent role ownership", () => {
  it.each([
    { name: "default", persona: undefined, profile: undefined, identity: DEFAULT_PERSONA, hasCard: false },
    { name: "custom", persona: "CUSTOM_PERSONA_SENTINEL", profile: undefined, identity: "CUSTOM_PERSONA_SENTINEL", hasCard: false },
    { name: "card-only", persona: undefined, profile: card, identity: undefined, hasCard: true },
    { name: "both", persona: "CUSTOM_PERSONA_SENTINEL", profile: card, identity: "CUSTOM_PERSONA_SENTINEL", hasCard: true },
    { name: "blank persona and card", persona: "  \n", profile: card, identity: undefined, hasCard: true },
    { name: "legacy generated default and card", persona: "  " + DEFAULT_PERSONA + "\n", profile: card, identity: undefined, hasCard: true },
    {
      name: "edited legacy persona and card",
      persona: DEFAULT_PERSONA + "\nCUSTOM_CHANGE",
      profile: card,
      identity: DEFAULT_PERSONA + "\nCUSTOM_CHANGE",
      hasCard: true,
    },
    { name: "empty profile", persona: undefined, profile: { characterDefinition: "  ", roleInstructions: "\n" }, identity: DEFAULT_PERSONA, hasCard: false },
  ])("assembles $name before interaction and capabilities", async ({ persona, profile, identity, hasCard }) => {
    const basePath = await root();
    if (persona !== undefined) await writeFile(join(basePath, "PERSONA.md"), persona);
    await writeFile(join(basePath, "AGENTS.md"), "AGENTS_SENTINEL");
    const blocks = await buildCoreSystemPrompt({ basePath, channel: scope, selfId: "bot", roleProfile: profile });
    const all = blocks.map((block) => String(block.content)).join("\n");
    const order = ["# 运行契约", "# 角色", "# 互动策略", "# 能力与证据边界", "AGENTS_SENTINEL", "<runtime_context>"];
    // runtime_context is mentioned as reference in interaction; the actual data block is last.
    const offsets = order.slice(0, -1).map((value) => all.indexOf(value));
    expect(offsets.every((offset) => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(String(blocks.at(-1)?.content)).toMatch(/^<runtime_context>/);
    if (identity) expect(all).toContain("<persona>\n" + identity + "\n</persona>");
    else expect(all).not.toContain("Athena");
    expect(all.split("CARD_DEFINITION_SENTINEL")).toHaveLength(hasCard ? 2 : 1);
    if (hasCard) {
      expect(all.indexOf("CARD_DEFINITION_SENTINEL")).toBeLessThan(all.indexOf("CARD_INSTRUCTION_SENTINEL"));
      expect(all.indexOf("EXAMPLE_SENTINEL")).toBeLessThan(all.indexOf("# 互动策略"));
      if (identity) expect(all).toContain("补充角色材料：服从主身份与行为文档");
    }
    if (persona !== undefined) expect(await readFile(join(basePath, "PERSONA.md"), "utf8")).toBe(persona);
  });

  it("creates a blank template, preserves existing files and does not blend default with a card", async () => {
    const basePath = await root();
    await ensureDefaultPersona(basePath);
    expect(await readFile(join(basePath, "PERSONA.md"), "utf8")).toBe("");
    const all = JSON.stringify(await buildCoreSystemPrompt({ basePath, channel: scope, selfId: "bot", roleProfile: card }));
    expect(all).toContain("CARD_DEFINITION_SENTINEL");
    expect(all).not.toContain("Athena");
    await writeFile(join(basePath, "PERSONA.md"), "CUSTOM_PERSONA_SENTINEL");
    await ensureDefaultPersona(basePath);
    expect(await readFile(join(basePath, "PERSONA.md"), "utf8")).toBe("CUSTOM_PERSONA_SENTINEL");
  });

  it("keeps card and persona out of the delegated main Agent", async () => {
    const basePath = await root();
    await writeFile(join(basePath, "PERSONA.md"), "CUSTOM_PERSONA_SENTINEL");
    const all = JSON.stringify(await buildCoreSystemPrompt({ basePath, channel: scope, selfId: "bot", roleProfile: card, delegated: true }));
    expect(all).not.toMatch(/CUSTOM_PERSONA_SENTINEL|CARD_DEFINITION_SENTINEL|EXAMPLE_SENTINEL/);
    expect(all).toContain("facts");
  });

  it("resolves in registration order, ignores empty providers, and rejects competing identities", async () => {
    const agents = new Agents(new Context());
    const empty = vi.fn(() => ({ characterDefinition: "  " }));
    const first = vi.fn(() => card);
    agents.use({ roleProfile: { resolve: empty }, setup: () => null });
    agents.use({ roleProfile: { resolve: first }, setup: () => null });
    await expect(agents.resolveRoleProfile(scope)).resolves.toEqual(card);
    expect(empty).toHaveBeenCalledBefore(first);
    const dispose = agents.use({ roleProfile: { resolve: () => ({ roleInstructions: "SECOND" }) }, setup: () => null });
    await expect(agents.resolveRoleProfile(scope)).rejects.toThrow("Multiple main-Agent role providers");
    dispose();
    await expect(agents.resolveRoleProfile(scope)).resolves.toEqual(card);
  });

  it("marks only opted-in providers as managed, not unrelated channel plugins", async () => {
    const agents = new Agents(new Context());
    const roleSetup = vi.fn(() => null);
    const otherSetup = vi.fn(() => null);
    agents.use({ roleProfile: { resolve: () => ({}) }, setup: roleSetup });
    agents.use({ setup: otherSetup });
    await agents.setup(scope, {} as never, { imageProjection: new EphemeralImageProjectionStore(), polisherActive: false, rolePromptsManaged: true });
    expect(roleSetup.mock.calls[0]?.[2]).toMatchObject({ rolePromptsManaged: true });
    expect(otherSetup.mock.calls[0]?.[2]).toMatchObject({ rolePromptsManaged: false });
  });
});
