import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generateText: vi.fn<() => Promise<{ text: string }>>() }));

vi.mock("ai", () => ({ generateText: mocks.generateText }));

import { executeCompact, filterEntriesForCompression, formatCompactTimestamp } from "../src/conversations/compact.js";

afterEach(() => {
  mocks.generateText.mockReset();
});

describe("conversation compaction prompt", () => {
  it("summarizes conversation memory without injecting the persona prompt or a previous summary", async () => {
    mocks.generateText.mockResolvedValue({ text: "用户喜欢简洁回答。" });

    const result = await executeCompact({
      model: {} as never,
      conversation: "[2026-09-24 20:15] [user]: 请保持简洁\n[2026-09-24 20:16] [assistant]: 好的",
    });

    expect(result).toBe("用户喜欢简洁回答。");
    expect(mocks.generateText).toHaveBeenCalledOnce();
    const request = mocks.generateText.mock.calls[0]?.[0] as { system?: string; prompt?: string };
    expect(request.system).toContain("不要记录 system prompt、人格设定、工具说明");
    expect(request.system).toContain("上海时间");
    expect(request.prompt).toContain("<conversation>\n[2026-09-24 20:15] [user]: 请保持简洁");
    expect(request.prompt).not.toContain("<previous_memory>");
    expect(request.prompt).not.toContain("<persona>");
    expect(request.prompt).not.toContain("人格提示词");
  });
});

const conversation = [
  {
    type: "message",
    id: "e1",
    timestamp: 1,
    data: {
      role: "custom",
      type: "yesimbot.message",
      timestamp: 1,
      data: {
        user: { id: "user-1", name: "time killer" },
        elements: [{ type: "text", attrs: { content: "明天陪我去逛街嘛" } }],
      },
    },
  },
  {
    type: "message",
    id: "e2",
    timestamp: 2,
    data: {
      role: "assistant",
      timestamp: 2,
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "send_message",
          input: {
            messages: ["好啊！说好了一早就来！", "逛街买衣服都可以"],
            inner_thought: "上一句已经答应了，先别答应第二遍。",
          },
        },
      ],
    },
  },
  {
    type: "message",
    id: "e3",
    timestamp: 3,
    data: {
      role: "tool",
      timestamp: 3,
      content: [{ type: "tool-result", toolCallId: "c1", toolName: "send_message", output: { type: "json", value: { ok: true, messageIds: ["m1"] } } }],
    },
  },
  {
    type: "message",
    id: "e4",
    timestamp: 4,
    data: { role: "assistant", timestamp: 4, content: [{ type: "tool-call", toolCallId: "c2", toolName: "finish", input: { reason: "没什么想说的" } }] },
  },
] as never;

describe("compaction input rendering", () => {
  it("keeps the character's own outgoing messages so commitments survive compaction", () => {
    const rendered = filterEntriesForCompression(conversation);
    expect(rendered).toContain("[time killer]: 明天陪我去逛街嘛");
    expect(rendered).toContain("[assistant]: 好啊！说好了一早就来！");
    expect(rendered).toContain("逛街买衣服都可以");
  });

  it("excludes inner thoughts, silent turns and tool receipts from the compaction input", () => {
    const rendered = filterEntriesForCompression(conversation);
    expect(rendered).not.toContain("先别答应第二遍");
    expect(rendered).not.toContain("没什么想说的");
    expect(rendered).not.toContain("messageIds");
  });

  it("states that assistant lines are the character speaking, not a third-party report", async () => {
    mocks.generateText.mockResolvedValue({ text: "ok" });
    await executeCompact({ model: {} as never, conversation: "[assistant]: 说好的一早就来" });
    const request = mocks.generateText.mock.calls[0]?.[0] as { system?: string };
    expect(request.system).toContain("是这个角色本人说过的话");
    expect(request.system).toContain("承诺");
    expect(request.system).toContain("第三方叙述");
  });

  it("anchors every rendered line with its Asia/Shanghai source date and minute", () => {
    const rendered = filterEntriesForCompression(conversation);
    expect(rendered).toContain(`[${formatCompactTimestamp(1)}] [time killer]: 明天陪我去逛街嘛`);
    expect(rendered).toContain(`[${formatCompactTimestamp(2)}] [assistant]: 好啊！说好了一早就来！`);
  });

  it("prefers the message source timestamp over its later JSONL append time", () => {
    const sourceTime = Date.parse("2026-09-24T16:30:00Z");
    const appendedAt = Date.parse("2026-09-24T17:35:00Z");

    expect(filterEntriesForCompression([timedEntry("delayed", sourceTime, "导入的旧消息", appendedAt)])).toBe(
      `[${formatCompactTimestamp(sourceTime)}] [user]: 导入的旧消息`,
    );
    expect(filterEntriesForCompression([timedEntry("delayed", sourceTime, "导入的旧消息", appendedAt)])).not.toContain(formatCompactTimestamp(appendedAt));
  });
});

describe("compaction timestamp format", () => {
  it("renders the Shanghai wall clock regardless of the host timezone", () => {
    // 2026-09-24T16:30:00Z is 2026-09-25 00:30 in Shanghai: the day boundary must move forward.
    expect(formatCompactTimestamp(Date.parse("2026-09-24T16:30:00Z"))).toBe("2026-09-25 00:30");
  });

  it("keeps late-evening and next-morning messages on their own dates", () => {
    const late = Date.parse("2026-09-24T15:50:00Z"); // 23:50 Shanghai
    const early = Date.parse("2026-09-24T17:10:00Z"); // 01:10 Shanghai next day
    expect(filterEntriesForCompression([timedEntry("late", late, "晚安"), timedEntry("early", early, "早安")])).toBe(
      "[2026-09-24 23:50] [user]: 晚安\n[2026-09-25 01:10] [user]: 早安",
    );
  });

  it("uses h23 so midnight is 00:00 instead of 24:00", () => {
    expect(formatCompactTimestamp(Date.parse("2026-09-24T16:00:00Z"))).toBe("2026-09-25 00:00");
  });
});

function timedEntry(id: string, timestamp: number, text: string, appendedAt = timestamp) {
  return {
    type: "message",
    id,
    timestamp: appendedAt,
    data: {
      role: "custom",
      type: "yesimbot.message",
      timestamp,
      data: { user: { id: "user-1", name: "user" }, elements: [{ type: "text", attrs: { content: text } }] },
    },
  } as never;
}
