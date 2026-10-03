import type { CharacterCardV3 } from "@risuai/ccardlib";
import { createAgentChannel, createMemoryStorage, createPluginHost, createStateManager } from "@yesimbot/agent-runtime";
import { describe, expect, it } from "vitest";

import { assembleRoleProfile } from "../src/prompt.js";
import { createRoleplayPlugin } from "../src/roleplay.js";

function createCard(): CharacterCardV3 {
  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Athena",
      description: "A careful character.",
      personality: "Calm",
      scenario: "A quiet room.",
      first_mes: "Hello, {{user}}.",
      mes_example: "",
      alternate_greetings: [],
      group_only_greetings: [],
      character_version: "1",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      tags: [],
      creator: "",
      extensions: {},
    },
  };
}

describe("roleplay agent plugin", () => {
  it("delegates the same card instructions and definition without injecting them into the main Agent", async () => {
    const card = createCard();
    card.data.system_prompt = "Roleplay as {{char}} for {{user}}";
    card.data.post_history_instructions = "Always speak in character to {{user}}";
    const profile = assembleRoleProfile(card, { charName: "Athena", userName: "direct-user", pickCache: new Map() });
    expect(profile.roleInstructions).toContain("Roleplay as Athena for direct-user");
    expect(profile.roleInstructions).toContain("Always speak in character to direct-user");
    expect(profile.characterDefinition).toContain("Name: Athena");
    const storage = createMemoryStorage();
    const channel = createAgentChannel();
    const state = createStateManager({ storage });
    const host = createPluginHost({
      plugins: [createRoleplayPlugin({ card, greeting: "Hello {{user}}", userName: "direct-user", delegatePrompts: true })],
      runtime: { id: "channel", channel, state, storage },
    });
    await host.init();
    expect(host.stablePromptBlocks).toEqual([]);
    const messages = [{ role: "user" as const, content: "hello" }];
    expect(await host.helpers.prepareStep(messages, { runtime: { id: "channel" }, channel, state, turnId: "turn", stepNumber: 0 })).toEqual(messages);
    expect(await storage.read()).toEqual([
      expect.objectContaining({ type: "message", data: expect.objectContaining({ role: "assistant", content: "Hello direct-user" }) }),
    ]);
  });

  it("persists the rendered first greeting for an empty session", async () => {
    const storage = createMemoryStorage();
    const channel = createAgentChannel();
    const state = createStateManager({ storage });
    const host = createPluginHost({
      plugins: [createRoleplayPlugin({ card: createCard(), greeting: "Hello, {{user}}.", userName: "direct-user" })],
      runtime: { id: "channel", channel, state, storage },
    });

    await host.init();

    await expect(storage.read()).resolves.toEqual([
      expect.objectContaining({ type: "message", data: expect.objectContaining({ role: "assistant", content: "Hello, direct-user." }) }),
    ]);
  });

  it("preserves an already-persisted greeting when the role is replaced", async () => {
    const storage = createMemoryStorage();
    const channel = createAgentChannel();
    const state = createStateManager({ storage });
    const runtime = { id: "channel", channel, state, storage };
    const first = createPluginHost({
      plugins: [createRoleplayPlugin({ card: createCard(), greeting: "OLD_GREETING", userName: "user" })],
      runtime,
    });
    await first.init();
    await first.stop();
    const replacementCard = createCard();
    replacementCard.data.name = "Replacement";
    const replacement = createPluginHost({
      plugins: [createRoleplayPlugin({ card: replacementCard, greeting: "NEW_GREETING", userName: "user" })],
      runtime,
    });
    await replacement.init();
    expect(JSON.stringify(replacement.stablePromptBlocks)).toContain("Name: Replacement");
    const entries = await storage.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "message", data: { role: "assistant", content: "OLD_GREETING" } });
    await replacement.stop();
  });

  it("uses the card nickname for {{char}} substitutions", async () => {
    const card = createCard();
    card.data.nickname = "Nyx";
    const storage = createMemoryStorage();
    const channel = createAgentChannel();
    const state = createStateManager({ storage });
    const host = createPluginHost({
      plugins: [createRoleplayPlugin({ card, greeting: "Hello, {{char}}.", userName: "direct-user" })],
      runtime: { id: "channel", channel, state, storage },
    });

    await host.init();

    await expect(storage.read()).resolves.toEqual([
      expect.objectContaining({ type: "message", data: expect.objectContaining({ role: "assistant", content: "Hello, Nyx." }) }),
    ]);
  });

  it("renders one frozen prompt envelope around every model step", async () => {
    const card = createCard();
    card.data.description = "A {{pick:bright,dark}} character.";
    card.data.personality = "Mood: {{random:calm,kind}}.";
    card.data.scenario = "Roll: {{roll:d6}}.";
    card.data.system_prompt = "Protect {{user}}.";
    card.data.mes_example = "<START>\n{{char}}: Hello";
    card.data.post_history_instructions = "Answer {{user}} last.";
    const storage = createMemoryStorage();
    const channel = createAgentChannel();
    const state = createStateManager({ storage });
    const host = createPluginHost({
      plugins: [createRoleplayPlugin({ card, greeting: "", userName: "direct-user", random: () => 0.8 })],
      runtime: { id: "channel", channel, state, storage },
    });
    const context = { runtime: { id: "channel" }, channel, state, turnId: "turn", stepNumber: 0 };

    await host.init();
    const first = await host.helpers.prepareStep([{ role: "user", content: "hello" }], context);
    const second = await host.helpers.prepareStep([{ role: "user", content: "hello" }], context);

    expect(host.stablePromptBlocks).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("Protect direct-user."),
      }),
    ]);
    expect(JSON.stringify(host.stablePromptBlocks)).toContain("<example_dialogues>");
    expect(JSON.stringify(host.stablePromptBlocks)).toContain("Answer direct-user last.");
    expect(JSON.stringify(host.stablePromptBlocks)).toContain("Name: Athena\\n\\nA dark character.");
    expect(JSON.stringify(host.stablePromptBlocks)).toContain("Mood: kind.");
    expect(JSON.stringify(host.stablePromptBlocks)).toContain("Roll: 5.");
    expect(first).toEqual([{ role: "user", content: "hello" }]);
    const firstNonSystem = first.findIndex((message) => message.role !== "system");
    expect(first.slice(firstNonSystem + 1)).not.toContainEqual(expect.objectContaining({ role: "system" }));
    expect(second).toEqual(first);
    expect(host.stablePromptBlocks).toHaveLength(1);
    const block = String(host.stablePromptBlocks[0]!.content);
    expect(block.indexOf("Name: Athena")).toBeLessThan(block.indexOf("Protect direct-user."));
    expect(block.indexOf("Protect direct-user.")).toBeLessThan(block.indexOf("<example_dialogues>"));
    expect(block.indexOf("<example_dialogues>")).toBeLessThan(block.indexOf("Answer direct-user last."));
  });
});
