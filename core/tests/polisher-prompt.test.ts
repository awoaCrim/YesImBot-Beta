import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildCoreSystemPrompt, DEFAULT_PERSONA, resolvePolisherPromptProfile } from "../src/runtimes/prompt.js";
const channel = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;
describe("compose prompt ownership", () => {
  it("keeps logical/execution main prompt neutral and sends live complete role materials only to composer", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-compose-prompt-"));
    try {
      await writeFile(join(root, "PERSONA.md"), "PRIVATE_PERSONA 全部角色动机");
      await writeFile(join(root, "AGENTS.md"), "OPERATOR_TASK 专业任务约束");
      const card = { characterDefinition: "PRIVATE_CARD 全部角色定义", roleInstructions: "PRIVATE_EXAMPLES 全部对话例子" };
      const prompt = JSON.stringify(
        await buildCoreSystemPrompt({
          basePath: root,
          channel,
          selfId: "bot",
          delegated: true,
          polisherMode: "compose",
          roleProfile: card,
          customInnerThought: true,
        }),
      );
      expect(prompt).toContain("OPERATOR_TASK");
      expect(prompt).toContain("facts 与 intent");
      expect(prompt).toContain("不提交 messages 草稿");
      expect(prompt).not.toMatch(/PRIVATE_PERSONA|PRIVATE_CARD|PRIVATE_EXAMPLES|Athena|事实整理与草稿撰写|消息分条是你的交流动作决策/);
      expect(await resolvePolisherPromptProfile(root, card)).toEqual({ ...card, persona: "PRIVATE_PERSONA 全部角色动机" });
      await writeFile(join(root, "PERSONA.md"), "更新后的完整身份");
      expect((await resolvePolisherPromptProfile(root, card)).persona).toBe("更新后的完整身份");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("shares default/card-only precedence without injecting Athena alongside a standalone card", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-compose-card-"));
    try {
      const card = { characterDefinition: "独立角色卡" };
      expect(await resolvePolisherPromptProfile(root, card)).toEqual({ ...card, persona: "" });
      expect((await resolvePolisherPromptProfile(root)).persona).toBe(DEFAULT_PERSONA);
      await writeFile(join(root, "PERSONA.md"), DEFAULT_PERSONA);
      expect((await resolvePolisherPromptProfile(root, card)).persona).toBe("");
      await rm(join(root, "PERSONA.md"));
      await mkdir(join(root, "PERSONA.md"));
      // Main delegated assembly does not even read Persona; the send profile still validates I/O.
      expect(JSON.stringify(await buildCoreSystemPrompt({ basePath: root, channel, selfId: "bot", delegated: true, polisherMode: "compose" }))).toContain(
        "facts 与 intent",
      );
      await expect(resolvePolisherPromptProfile(root, card)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
