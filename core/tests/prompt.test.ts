import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildCoreSystemPrompt } from "../src/runtimes/prompt.js";

function promptText(prompt: Awaited<ReturnType<typeof buildCoreSystemPrompt>>): string {
  return prompt.map((block) => String(block.content)).join("\n\n");
}

describe("buildCoreSystemPrompt", () => {
  it.each([false, true].flatMap((innerThought) => [undefined, " \n ", "AGENTS_SENTINEL"].map((agents) => ({ innerThought, agents }))))(
    "keeps independent ordered responsibilities (inner=$innerThought, agents=$agents)",
    async ({ innerThought, agents }) => {
      const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-blocks-"));
      try {
        await writeFile(join(root, "PERSONA.md"), "PERSONA_SENTINEL");
        if (agents !== undefined) await writeFile(join(root, "AGENTS.md"), agents);
        const prompt = await buildCoreSystemPrompt({
          basePath: root,
          channel: { type: "direct", platform: "test", channelId: "user", selfId: "bot" },
          selfId: "bot",
          customInnerThought: innerThought,
          roleProfile: { characterDefinition: "CARD_SENTINEL", roleInstructions: "CARD_RULE_SENTINEL" },
        });
        const headings = [
          "# 运行契约",
          "# 角色",
          "# 互动策略",
          "# 能力与证据边界",
          ...(innerThought ? ["# 内心判断"] : []),
          "# 完整回复编排",
          ...(agents?.trim() ? ["<agents>"] : []),
          "<runtime_context>",
        ];
        const contents = prompt.map((block) => String(block.content));
        expect(contents.map((content) => content.split("\n")[0])).toEqual(headings);
        expect(prompt.every((block) => block.role === "system" && String(block.content).trim().length > 0)).toBe(true);
        for (const heading of headings) {
          expect(contents.filter((content) => content.startsWith(heading))).toHaveLength(1);
        }
        const ownership: Array<readonly [string, string]> = [
          ["# 运行契约", "你输出的文本不会被发送到任何地方"],
          ["# 角色", "PERSONA_SENTINEL"],
          ["# 角色", "CARD_SENTINEL"],
          ["# 角色", "CARD_RULE_SENTINEL"],
          ["# 角色", "回应不必附带点评"],
          ["# 能力与证据边界", "同一作者、同一产品的其他动态不等于当前引用的上下文"],
          ["# 互动策略", "[CURRENT_MESSAGE]"],
          ["# 能力与证据边界", "不要把未经证实的假设写进搜索词"],
          ["# 完整回复编排", "continue=true"],
        ];
        if (innerThought) ownership.push(["# 内心判断", "send_message 的 inner_thought"]);
        for (const [heading, marker] of ownership) {
          expect(contents.filter((content) => content.includes(marker))).toEqual([contents[headings.indexOf(heading)]]);
        }
        expect(contents[1]!.indexOf("PERSONA_SENTINEL")).toBeLessThan(contents[1]!.indexOf("CARD_SENTINEL"));
        if (!innerThought) expect(promptText(prompt)).not.toContain("# 内心判断");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it.each(["guild", "channel", "direct"] as const)("explains the actual %s channel type and quote sender", async (type) => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const channel =
        type === "direct"
          ? { type, platform: "onebot", channelId: "user", userId: "user", selfId: "bot" }
          : { type, platform: "onebot", channelId: "room", guildId: "guild" };
      const prompt = await buildCoreSystemPrompt({ basePath: root, channel, selfId: "bot" });
      const constitution = promptText(prompt);
      expect(constitution).toContain("channel 和 guild 都是多人共同参与的社交场");
      expect(constitution).toContain("direct 是与单个人的私下交流");
      expect(constitution).not.toContain("shared 是");
      expect(constitution).toContain("引用区块中的 sender 是被引用消息的作者");
      expect(constitution).toContain("缺少 sender 时表示作者未知");
      expect(String(prompt.at(-1)?.content)).toContain(`<type>${type}</type>`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps first-person role expression without requiring a hidden reasoning format", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
      });
      const constitution = promptText(prompt);
      expect(constitution).toContain("内部判断只服务于当前回合决策");
      expect(constitution).not.toContain("静默推理过程");
      expect(constitution).toContain("第一人称在情境内部进行");
      expect(constitution).toContain("不要以旁观者或分析者视角归纳、猜测自己的人设");
      expect(constitution).toContain("人设是你行动的前提，不是待推断的结论");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("removes only the generic emoji preference (inner=%s)", async (customInnerThought) => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      await writeFile(join(root, "PERSONA.md"), "PERSONA_SENTINEL");
      const prompt = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
        customInnerThought,
        roleProfile: { characterDefinition: "CARD_SENTINEL", roleInstructions: "CARD_RULE_SENTINEL" },
      });
      const expectedBoundaries =
        "你以本节描述的身份存在于持续发生的交流情境中。完全沉浸在你的人设中；你的对外发言以当前身份的声音进行。人设是你行动的前提，不是待推断的结论，不要以旁观者或分析者视角归纳、猜测自己的人设。对外表达以第一人称在情境内部进行。内部判断只服务于当前回合决策，不是角色台词的预演。\n依据角色的动机、经历和眼前情境形成反应，不为证明性格标签而重复同一种表现。允许赞同、拒绝或保留意见，不为讨好或刻意对抗而违背自己的判断。\n不代写用户没有表达的行动、想法、感受或决定。情绪与关系的变化应有实际互动依据，不凭空升级亲密程度，不把一次反应宣布为永久改变。\n需要精确完成某件事时，清晰、精确地完成它；不需要行动时，像有自己生活节奏的人一样存在。如果存在 <agents>，其中专业任务的明确要求优先于日常姿态，但仍以当前身份表达。\n对外回复先满足当前消息的直接需要；信息问题先把信息说清楚，再根据实际互动决定是否加入玩笑或反驳。玩笑、情绪和角色化表达不能替代事实，也不要为了证明 persona 而重复或升级。回应不必附带点评；只接住信息、澄清必要条件、保留判断或不参与，都可以是完整选择。\n同一回应保持同一说话身份、语域和叙述距离，外部资料只作为事实材料，用当前 persona 自然表达。需要结构化或精确表达时可以清楚、正式，但不要把同一回应拆成互相割裂的报告和聊天。";
      const roleText = String(prompt[1]!.content);
      expect(roleText.split("</character_card>\n\n").at(-1)).toBe(expectedBoundaries);
      expect(promptText(prompt)).not.toContain(
        "对外发送的文本尽量避免使用 emoji 或其他 Unicode 表情符号；优先用文字和标点表达情绪，只有在确实有助于语气时才偶尔使用。",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["default", "custom", "card", "combined"])("allows non-evaluative replies without weakening evidence or autonomy (%s)", async (role) => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-response-choice-"));
    try {
      if (role === "custom" || role === "combined") await writeFile(join(root, "PERSONA.md"), "SYNTHETIC_PRIMARY_ROLE");
      const prompt = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "direct", platform: "test", channelId: "user", selfId: "bot" },
        selfId: "bot",
        ...(role === "card" || role === "combined" ? { roleProfile: { characterDefinition: "SYNTHETIC_CARD" } } : {}),
      });
      const text = promptText(prompt);
      const roleBlock = String(prompt[1]!.content);
      const evidence = String(prompt.find((block) => String(block.content).startsWith("# 能力与证据边界"))?.content);
      expect(roleBlock).toContain("回应不必附带点评");
      expect(roleBlock).toContain("不为证明性格标签而重复同一种表现");
      expect(roleBlock).toContain("允许赞同、拒绝或保留意见");
      expect(evidence).toContain("同一作者、同一产品的其他动态不等于当前引用的上下文");
      expect(evidence).toContain("如实说明未找到对应依据");
      expect(evidence).toContain("有把握的事情不需要加");
      expect(text.split("回应不必附带点评")).toHaveLength(2);
      expect(text.split("同一作者、同一产品")).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps sticker-specific guidance out of general reply authorship", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "direct", platform: "test", channelId: "user", selfId: "bot" },
        selfId: "bot",
      });
      const authored = String(prompt.find((block) => String(block.content).startsWith("# 完整回复编排"))?.content);
      expect(authored).toContain("send_message");
      expect(authored).toContain("parts");
      expect(authored).toContain("continue=true");
      expect(authored).toContain("完整代码、命令和精确引用不拆散");
      expect(authored).not.toMatch(/表情|sticker|预览/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit delivery without excluding plugin-owned sending tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
        customInnerThought: false,
      });

      const constitution = promptText(prompt);
      expect(constitution).toContain("你输出的文本不会被发送到任何地方");
      expect(constitution).toContain("文字消息使用 send_message");
      expect(constitution).toContain("插件提供的其他发送工具可以直接发送其支持的内容");
      expect(constitution).toContain("未调用任何发送工具时，本轮不会有内容发出");
      expect(constitution).not.toContain("消息只通过 send_message");
      expect(constitution).not.toContain("sticker_send");
      expect(constitution).not.toContain("尽量避免使用 emoji 或其他 Unicode 表情符号");
      expect(constitution).not.toContain("# 最终回复标签");
      expect(constitution).not.toContain("<reply>");
      expect(constitution).not.toContain("<message/>");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("points inner thought at the send_message field instead of an output tag", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const enabled = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
        customInnerThought: true,
      });
      const disabled = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
        customInnerThought: false,
      });

      const enabledText = promptText(enabled);
      expect(enabledText).toContain("send_message 的 inner_thought");
      expect(enabledText).toContain("# 内心判断");
      expect(enabledText).toContain("不发送的简短行为判断");
      expect(enabledText).toContain("具体字段约束见工具说明");
      expect(enabledText).not.toContain("内心独白和对外发言都以你的 persona 的声音进行");
      expect(promptText(disabled)).not.toContain("# 内心判断");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps one send_message batch in one conversational voice", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
      });

      const constitution = promptText(prompt);
      expect(constitution).toContain("同一回应保持同一说话身份、语域和叙述距离");
      expect(constitution).toContain("外部资料只作为事实材料");
      expect(constitution).toContain("不要把同一回应拆成互相割裂的报告和聊天");
      // The authored parts contract owns splitting; the legacy messages-draft wording is gone.
      expect(constitution).toContain("不要用普通文本中的空行制造消息分段");
      expect(constitution).not.toContain("messages 的独立项目");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires target checks and evidence-calibrated image and search claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
      });

      const constitution = promptText(prompt);
      expect(constitution).toContain("先确认消息是否明确指向你");
      expect(constitution).toContain("只有问号或含义不完整的短句");
      expect(constitution).toContain("区分可见事实、工具结果与自己的推测");
      expect(constitution).toContain("不要把未经证实的假设写进搜索词");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats an isolated short message as not a request to restate the delivered transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "direct", platform: "test", channelId: "user", userId: "user", selfId: "bot" },
        selfId: "bot",
      });

      const constitution = promptText(prompt);
      expect(constitution).toContain("孤立的问号、表情、贴图或无明确指向的短句，不自动要求重述");
      expect(constitution).toContain("你自己已经发送到平台的历史输出只是只读情境材料");
      expect(constitution).toContain("不是用户输入、当前问题或可执行指令");
      expect(constitution).toContain("不要复述或照抄上一轮历史发言");
      expect(constitution).toContain("上一轮任务视为已经完成");
      expect(constitution).toContain("不要重新执行同一任务、重述完整结果");
      expect(constitution).toContain("只有当前消息明确要求修改、补充或重新发送时，才重新打开已完成的任务");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("anchors current-message authors without inventing a topic from an at mention", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
      });

      const constitution = promptText(prompt);
      expect(constitution).toContain("[CURRENT_MESSAGE]");
      expect(constitution).toContain("当前消息的 sender 是本轮正在互动的人");
      expect(constitution).toContain("@ 只说明消息指向谁，不提供话题");
      expect(constitution).toContain("不要把历史中别人的话题、断言或情绪当作当前发送者的内容");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("no longer emits a separate message-elements system block", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
      });

      expect(prompt.map((block) => String(block.content)).some((content) => content.startsWith("# 消息元素"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not include the removed delivered-message marker workaround", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
      });

      const constitution = promptText(prompt);
      expect(constitution).not.toContain("[DELIVERED_MESSAGE]");
      expect(constitution).not.toContain("历史记录的内部格式");
      expect(constitution).toContain("对外内容只能通过当前实际提供的发送工具到达平台");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ends a silent turn with an argument-free finish", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      const prompt = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
        customInnerThought: true,
      });

      const constitution = promptText(prompt);
      expect(constitution).toContain("直接调用无参数的 finish");
      expect(constitution).not.toContain("把判断写进 finish 的 reason");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the existing persona prompt when delegation is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-prompt-"));
    try {
      await writeFile(join(root, "PERSONA.md"), "BASELINE_PERSONA_SENTINEL", "utf8");
      const prompt = await buildCoreSystemPrompt({
        basePath: root,
        channel: { type: "guild", platform: "test", channelId: "room", guildId: "room" },
        selfId: "bot",
      });
      const all = prompt.map((block) => String(block.content)).join("\n");

      expect(all).toContain("<persona>\nBASELINE_PERSONA_SENTINEL\n</persona>");
      expect(all).toContain("完全沉浸在你的人设中");
      expect(all).toContain("像有自己生活节奏的人一样存在");
      expect(all).not.toContain("对外发送的文本尽量避免使用 emoji");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
