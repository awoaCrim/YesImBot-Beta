import { createAssistantMessage, createEntry, createSystemMessage, createToolMessage, createUserMessage } from "@yesimbot/agent-runtime";
import { describe, expect, it } from "vitest";

import { createDeliveredTranscriptMessage, isDeliveredTranscript } from "../src/conversations/delivered-transcript.js";
import { collectActualDeliveredSourceRecords, stripInternalAssistantInputs } from "../src/conversations/internal-history.js";

describe("internal model-history projection", () => {
  it("removes prior internal tool fields without changing durable entries", () => {
    const assistant = createAssistantMessage([
      {
        type: "tool-call",
        toolCallId: "read-1",
        toolName: "read",
        input: {
          uri: "asset://abc",
          inner_thought: "对方只是问了一个简单问题，不需要继续表演。",
          reason: "不应进入后续模型上下文。",
        },
      },
      {
        type: "tool-call",
        toolCallId: "finish-1",
        toolName: "finish",
        input: { reason: "当前消息没有明确指向我。" },
      },
    ]);
    const entries = [
      createEntry("message", createUserMessage("请保持简洁"), { id: "user-1", timestamp: 1 }),
      createEntry("message", assistant, { id: "assistant-1", timestamp: 2 }),
    ];

    const projected = stripInternalAssistantInputs(entries);
    const projectedAssistant = projected[1];
    expect(projectedAssistant).not.toBe(entries[1]);
    expect(entries[1]).toEqual(expect.objectContaining({ data: expect.objectContaining({ content: assistant.content }) }));
    expect(projectedAssistant).toEqual(
      expect.objectContaining({
        id: "assistant-1",
        data: expect.objectContaining({
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "read-1",
              toolName: "read",
              input: { uri: "asset://abc" },
            },
            {
              type: "tool-call",
              toolCallId: "finish-1",
              toolName: "finish",
              input: {},
            },
          ],
        }),
      }),
    );
  });

  it.each(["default", "gemini-native"] as const)("hides retired reply preparation in %s history without changing durable data", (mode) => {
    const entries = [
      createEntry(
        "message",
        createAssistantMessage([
          { type: "tool-call", toolCallId: "prepare-old", toolName: "prepare_reply", input: { facts: ["private preparation"], intent: "private intent" } },
          { type: "tool-call", toolCallId: "read-current", toolName: "read", input: { uri: "asset://reference" } },
        ]),
        { id: "assistant-old", timestamp: 1 },
      ),
      createEntry(
        "message",
        createToolMessage([
          {
            type: "tool-result",
            toolCallId: "prepare-old",
            toolName: "prepare_reply",
            output: { type: "json", value: { reply_id: "retired-id", parts: [{ kind: "text", text: "private prepared draft" }] } },
          },
          { type: "tool-result", toolCallId: "read-current", toolName: "read", output: { type: "json", value: { text: "durable read" } } },
        ]),
        { id: "tool-old", timestamp: 2 },
      ),
      createEntry(
        "message",
        createToolMessage([
          { type: "tool-result", toolCallId: "orphan", toolName: "prepare_reply", output: { type: "json", value: { text: "private orphan draft" } } },
        ]),
        { id: "orphan-tool", timestamp: 3 },
      ),
    ];
    const durableBefore = JSON.stringify(entries);
    const projected = stripInternalAssistantInputs(entries, mode);

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({
      id: "assistant-old",
      data: { content: [{ type: "tool-call", toolCallId: "read-current", toolName: "read", input: { uri: "asset://reference" } }] },
    });
    expect(projected[1]).toMatchObject({
      id: "tool-old",
      data: { content: [{ type: "tool-result", toolCallId: "read-current", toolName: "read", output: { type: "json", value: { text: "durable read" } } }] },
    });
    expect(JSON.stringify(projected)).not.toMatch(/prepare_reply|private|retired-id/);
    expect(JSON.stringify(entries)).toBe(durableBefore);
    expect(stripInternalAssistantInputs(projected, mode)).toEqual(projected);
  });

  it("hides ephemeral image traces but keeps durable reads", () => {
    const assistant = createAssistantMessage([
      { type: "tool-call", toolCallId: "asset-read", toolName: "read", input: { uri: "asset://reference" } },
      { type: "tool-call", toolCallId: "artifact-read", toolName: "read", input: { uri: "artifact://generate_image/result" } },
      { type: "tool-call", toolCallId: "image", toolName: "generate_image", input: { prompt: "old image" } },
      { type: "tool-call", toolCallId: "finish", toolName: "finish", input: {} },
    ]);
    const tool = createToolMessage([
      { type: "tool-result", toolCallId: "asset-read", toolName: "read", output: { type: "json", value: { asset: true } } },
      { type: "tool-result", toolCallId: "artifact-read", toolName: "read", output: { type: "json", value: { artifact: true } } },
      { type: "tool-result", toolCallId: "image", toolName: "generate_image", output: { type: "json", value: { uri: "artifact://generate_image/result" } } },
      { type: "tool-result", toolCallId: "finish", toolName: "finish", output: { type: "json", value: { done: true } } },
    ]);

    const projected = stripInternalAssistantInputs([
      createEntry("message", assistant, { id: "assistant-1", timestamp: 1 }),
      createEntry("message", tool, { id: "tool-1", timestamp: 2 }),
    ]);

    expect(projected[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          content: [
            { type: "tool-call", toolCallId: "asset-read", toolName: "read", input: { uri: "asset://reference" } },
            { type: "tool-call", toolCallId: "finish", toolName: "finish", input: {} },
          ],
        }),
      }),
    );
    expect(projected[1]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          content: [
            { type: "tool-result", toolCallId: "asset-read", toolName: "read", output: { type: "json", value: { asset: true } } },
            { type: "tool-result", toolCallId: "finish", toolName: "finish", output: { type: "json", value: { done: true } } },
          ],
        }),
      }),
    );
  });

  it("projects successful send_message output as a typed transcript and removes its result", () => {
    const assistant = createAssistantMessage([
      {
        type: "tool-call",
        toolCallId: "send-1",
        toolName: "send_message",
        input: { messages: ["上一轮已经发送的文字", '<img src="artifact://old-image"/>'] },
      },
      { type: "tool-call", toolCallId: "finish-1", toolName: "finish", input: {} },
    ]);
    const tool = createToolMessage([
      {
        type: "tool-result",
        toolCallId: "send-1",
        toolName: "send_message",
        output: { type: "json", value: { ok: true, messageIds: ["platform-1", "platform-2"], count: 2 } },
      },
      { type: "tool-result", toolCallId: "finish-1", toolName: "finish", output: { type: "json", value: { ok: true } } },
    ]);
    const entries = [createEntry("message", assistant, { id: "assistant-1", timestamp: 1 }), createEntry("message", tool, { id: "tool-1", timestamp: 2 })];

    const projected = stripInternalAssistantInputs(entries);

    expect(projected).toHaveLength(3);
    expect(projected[0]).toEqual(
      expect.objectContaining({
        id: "assistant-1:delivered-transcript:0",
        timestamp: 1,
        data: expect.objectContaining({
          role: "custom",
          type: "yesimbot.delivered-transcript",
          timestamp: 1,
          data: { messages: ["上一轮已经发送的文字", "[图片]"], deliveredCount: 2, partial: false },
        }),
      }),
    );
    expect(isDeliveredTranscript(projected[0].data)).toBe(true);
    expect(projected[1]).toEqual(
      expect.objectContaining({
        id: "assistant-1",
        data: expect.objectContaining({
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "finish-1", toolName: "finish", input: {} }],
        }),
      }),
    );
    expect(projected[2]).toEqual(
      expect.objectContaining({
        id: "tool-1",
        data: expect.objectContaining({
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "finish-1", toolName: "finish", output: { type: "json", value: { ok: true } } }],
        }),
      }),
    );
    expect(entries[0]).toEqual(expect.objectContaining({ data: expect.objectContaining({ content: assistant.content }) }));
    expect(JSON.stringify(projected)).not.toContain("artifact://old-image");
    expect(JSON.stringify(projected)).not.toContain("send_message");
    expect(stripInternalAssistantInputs(projected)).toEqual(projected);
  });

  it.each(["default", "gemini-native"] as const)("reads old actual-body receipts in %s mode without reviving expression inputs", (mode) => {
    const entries = [
      createEntry(
        "message",
        createAssistantMessage([
          { type: "tool-call", toolCallId: "old-compose", toolName: "send_message", input: { facts: ["private old fact"], intent: "private old intent" } },
        ]),
        { id: "old-assistant", timestamp: 1 },
      ),
      createEntry(
        "message",
        createToolMessage([
          {
            type: "tool-result",
            toolCallId: "old-compose",
            toolName: "send_message",
            output: { type: "json", value: { ok: true, messageIds: ["platform-1"], count: 1, deliveredMessages: ["old delivered body"] } },
          },
        ]),
        { id: "old-result", timestamp: 2 },
      ),
    ];
    const durableBefore = JSON.stringify(entries);
    const projected = stripInternalAssistantInputs(entries, mode);

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      data: { type: "yesimbot.delivered-transcript", data: { messages: ["old delivered body"], deliveredCount: 1, partial: false } },
    });
    expect(collectActualDeliveredSourceRecords(entries).get("old-assistant")).toEqual([
      expect.objectContaining({ role: "assistant", text: "old delivered body" }),
    ]);
    expect(JSON.stringify(projected)).not.toMatch(/private old|send_message/);
    expect(JSON.stringify(entries)).toBe(durableBefore);
  });

  it("reads only the complete prefix from an old partial actual-body receipt", () => {
    const entries = [
      createEntry(
        "message",
        createAssistantMessage([
          { type: "tool-call", toolCallId: "old-partial", toolName: "send_message", input: { messages: ["unsent draft", "failed draft"] } },
        ]),
        { id: "old-assistant", timestamp: 1 },
      ),
      createEntry(
        "message",
        createToolMessage([
          {
            type: "tool-result",
            toolCallId: "old-partial",
            toolName: "send_message",
            output: { type: "json", value: { ok: false, sent: ["platform-1"], failedAt: 1, deliveredMessages: ["actual complete prefix"] } },
          },
        ]),
        { id: "old-result", timestamp: 2 },
      ),
    ];
    expect(stripInternalAssistantInputs(entries)[0]).toMatchObject({
      data: { type: "yesimbot.delivered-transcript", data: { messages: ["actual complete prefix"], deliveredCount: 1, partial: true } },
    });
    expect(collectActualDeliveredSourceRecords(entries).get("old-assistant")).toEqual([expect.objectContaining({ text: "actual complete prefix" })]);
  });

  it.each(["missing IDs", "mismatched count", "duplicate result", "result before call"])("fails closed for an old actual-body receipt with %s", (issue) => {
    const assistant = createEntry(
      "message",
      createAssistantMessage([{ type: "tool-call", toolCallId: "old-send", toolName: "send_message", input: { messages: ["unproven draft"] } }]),
      { id: "old-assistant", timestamp: 1 },
    );
    const tool = createEntry(
      "message",
      createToolMessage([
        {
          type: "tool-result",
          toolCallId: "old-send",
          toolName: "send_message",
          output: {
            type: "json",
            value: {
              ok: true,
              messageIds: issue === "missing IDs" ? [] : ["platform-1"],
              count: issue === "mismatched count" ? 2 : 1,
              deliveredMessages: ["unproven receipt body"],
            },
          },
        },
      ]),
      { id: "old-result", timestamp: 2 },
    );
    const entries = issue === "result before call" ? [tool, assistant] : issue === "duplicate result" ? [assistant, tool, tool] : [assistant, tool];
    for (const mode of ["default", "gemini-native"] as const) expect(stripInternalAssistantInputs(entries, mode)).toEqual([]);
    expect(collectActualDeliveredSourceRecords(entries).get("old-assistant")).toEqual([]);
  });

  it("moves all delivered transcripts ahead of ordinary history", () => {
    const firstUser = createEntry("message", createUserMessage("第一轮问题"), { id: "user-1", timestamp: 1 });
    const firstAssistant = createEntry(
      "message",
      createAssistantMessage([{ type: "tool-call", toolCallId: "send-1", toolName: "send_message", input: { messages: ["第一轮已发送"] } }]),
      { id: "assistant-1", timestamp: 2 },
    );
    const firstTool = createEntry(
      "message",
      createToolMessage([{ type: "tool-result", toolCallId: "send-1", toolName: "send_message", output: { type: "json", value: { ok: true, count: 1 } } }]),
      { id: "tool-1", timestamp: 2 },
    );
    const secondUser = createEntry("message", createUserMessage("第二轮问题"), { id: "user-2", timestamp: 3 });
    const secondAssistant = createEntry(
      "message",
      createAssistantMessage([{ type: "tool-call", toolCallId: "send-2", toolName: "send_message", input: { messages: ["第二轮已发送"] } }]),
      { id: "assistant-2", timestamp: 4 },
    );
    const secondTool = createEntry(
      "message",
      createToolMessage([{ type: "tool-result", toolCallId: "send-2", toolName: "send_message", output: { type: "json", value: { ok: true, count: 1 } } }]),
      { id: "tool-2", timestamp: 4 },
    );

    const projected = stripInternalAssistantInputs([firstUser, firstAssistant, firstTool, secondUser, secondAssistant, secondTool]);

    expect(projected.slice(0, 2).every((entry) => entry.type === "message" && isDeliveredTranscript(entry.data))).toBe(true);
    expect(projected.slice(0, 2).map((entry) => (entry.type === "message" ? entry.data.data.messages[0] : ""))).toEqual(["第一轮已发送", "第二轮已发送"]);
    expect(projected[2]).toBe(firstUser);
    expect(projected[3]).toBe(secondUser);
  });

  it("keeps delivered transcripts behind leading system history so providers accept system-first ordering", () => {
    const summary = createEntry("message", createSystemMessage("<conversation_memory>\n早前摘要\n</conversation_memory>"), { id: "compact-1", timestamp: 0 });
    const user = createEntry("message", createUserMessage("第一轮问题"), { id: "user-1", timestamp: 1 });
    const assistant = createEntry(
      "message",
      createAssistantMessage([{ type: "tool-call", toolCallId: "send-1", toolName: "send_message", input: { messages: ["第一轮已发送"] } }]),
      { id: "assistant-1", timestamp: 2 },
    );
    const tool = createEntry(
      "message",
      createToolMessage([{ type: "tool-result", toolCallId: "send-1", toolName: "send_message", output: { type: "json", value: { ok: true, count: 1 } } }]),
      { id: "tool-1", timestamp: 2 },
    );

    const projected = stripInternalAssistantInputs([summary, user, assistant, tool]);

    expect(projected[0]).toBe(summary);
    expect(projected[1]).toEqual(
      expect.objectContaining({ type: "message", data: expect.objectContaining({ role: "custom", type: "yesimbot.delivered-transcript" }) }),
    );
    expect(projected[2]).toBe(user);
  });

  it("hoists every projected system entry ahead of non-system history", () => {
    const user = createEntry("message", createUserMessage("第一轮问题"), { id: "user-1", timestamp: 1 });
    const notice = createEntry("message", createSystemMessage("中途插入的系统条目"), { id: "system-mid", timestamp: 2 });
    const assistant = createEntry(
      "message",
      createAssistantMessage([{ type: "tool-call", toolCallId: "send-1", toolName: "send_message", input: { messages: ["第一轮已发送"] } }]),
      { id: "assistant-1", timestamp: 3 },
    );
    const tool = createEntry(
      "message",
      createToolMessage([{ type: "tool-result", toolCallId: "send-1", toolName: "send_message", output: { type: "json", value: { ok: true, count: 1 } } }]),
      { id: "tool-1", timestamp: 3 },
    );

    const projected = stripInternalAssistantInputs([user, notice, assistant, tool]);

    const firstNonSystem = projected.findIndex((entry) => !(entry.type === "message" && entry.data.role === "system"));
    expect(projected.slice(0, firstNonSystem).every((entry) => entry.type === "message" && entry.data.role === "system")).toBe(true);
    expect(projected.slice(firstNonSystem).some((entry) => entry.type === "message" && entry.data.role === "system")).toBe(false);
    expect(projected[0]).toBe(notice);
  });

  it("preserves the delivered count for a partial send", () => {
    const assistant = createAssistantMessage([
      {
        type: "tool-call",
        toolCallId: "send-1",
        toolName: "send_message",
        input: { messages: ["已经发出的第一条", "发送失败的第二条", "没有机会发出的第三条"] },
      },
      { type: "tool-call", toolCallId: "finish-1", toolName: "finish", input: {} },
    ]);
    const tool = createToolMessage([
      {
        type: "tool-result",
        toolCallId: "send-1",
        toolName: "send_message",
        output: { type: "json", value: { ok: false, sent: ["platform-1"], failedAt: 1 } },
      },
      { type: "tool-result", toolCallId: "finish-1", toolName: "finish", output: { ok: true } },
    ]);

    const projected = stripInternalAssistantInputs([
      createEntry("message", assistant, { id: "assistant-1", timestamp: 1 }),
      createEntry("message", tool, { id: "tool-1", timestamp: 2 }),
    ]);

    expect(projected[0]).toMatchObject({
      data: {
        type: "yesimbot.delivered-transcript",
        data: { messages: ["已经发出的第一条"], deliveredCount: 1, partial: true },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("发送失败的第二条");
    expect(JSON.stringify(projected)).not.toContain("没有机会发出的第三条");
  });

  it("does not project a send that delivered no messages", () => {
    const assistant = createAssistantMessage([
      {
        type: "tool-call",
        toolCallId: "send-1",
        toolName: "send_message",
        input: { messages: ["这条发送失败，不能伪装成已说过"] },
      },
      { type: "tool-call", toolCallId: "finish-1", toolName: "finish", input: {} },
    ]);
    const tool = createToolMessage([
      {
        type: "tool-result",
        toolCallId: "send-1",
        toolName: "send_message",
        output: { type: "json", value: { ok: false, sent: [], failedAt: 0 } },
      },
      { type: "tool-result", toolCallId: "finish-1", toolName: "finish", output: { ok: true } },
    ]);

    const projected = stripInternalAssistantInputs([
      createEntry("message", assistant, { id: "assistant-1", timestamp: 1 }),
      createEntry("message", tool, { id: "tool-1", timestamp: 2 }),
    ]);

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({ data: { role: "assistant", content: [{ type: "tool-call", toolName: "finish" }] } });
    expect(projected[1]).toMatchObject({ data: { role: "tool", content: [{ type: "tool-result", toolName: "finish" }] } });
    expect(JSON.stringify(projected)).not.toContain("这条发送失败");
  });

  it("leaves ordinary assistant content and non-assistant entries untouched", () => {
    const user = createEntry("message", createUserMessage("hello"), { id: "user-1", timestamp: 1 });
    const assistant = createEntry("message", createAssistantMessage("普通回复"), { id: "assistant-1", timestamp: 2 });

    const projected = stripInternalAssistantInputs([user, assistant]);
    expect(projected).toEqual([user, assistant]);
    expect(projected[0]).toBe(user);
    expect(projected[1]).toBe(assistant);
  });

  it("projects complete legacy delivered markers as typed transcripts without mutating input", () => {
    const assistant = createAssistantMessage([
      { type: "text", text: "[DELIVERED_MESSAGE]\n之前已经说过的话\n[/DELIVERED_MESSAGE]" },
      { type: "text", text: "普通文本" },
    ]);
    const entries = [createEntry("message", assistant, { id: "assistant-1", timestamp: 1 })];

    const projected = stripInternalAssistantInputs(entries);

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({
      data: { role: "custom", type: "yesimbot.delivered-transcript", data: { messages: ["之前已经说过的话"], deliveredCount: 1, partial: false } },
    });
    expect(projected[1]).toMatchObject({ data: { role: "assistant", content: [{ type: "text", text: "普通文本" }] } });
    expect(entries[0].data.content).toEqual(assistant.content);
    expect(stripInternalAssistantInputs(projected)).toEqual(projected);
  });

  it("projects a legacy marker that is the whole string content", () => {
    const assistant = createAssistantMessage("[DELIVERED_MESSAGE]\n旧消息\n[/DELIVERED_MESSAGE]");
    const entries = [createEntry("message", assistant, { id: "assistant-1", timestamp: 1 })];

    const projected = stripInternalAssistantInputs(entries);

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      data: { role: "custom", type: "yesimbot.delivered-transcript", data: { messages: ["旧消息"], deliveredCount: 1, partial: false } },
    });
    expect(entries[0].data.content).toBe("[DELIVERED_MESSAGE]\n旧消息\n[/DELIVERED_MESSAGE]");
    expect(stripInternalAssistantInputs(projected)).toEqual(projected);
  });

  it("keeps surrounding text when it projects legacy marker tags", () => {
    const assistant = createAssistantMessage([{ type: "text", text: "结论如下\n[DELIVERED_MESSAGE]\n旧消息\n[/DELIVERED_MESSAGE]" }]);
    const projected = stripInternalAssistantInputs([createEntry("message", assistant, { id: "assistant-1", timestamp: 1 })]);

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({ data: { type: "yesimbot.delivered-transcript", data: { messages: ["旧消息"] } } });
    expect(projected[1]).toMatchObject({ data: { role: "assistant", content: [{ type: "text", text: "结论如下" }] } });
  });

  it.each([
    ["a lone opening tag", "[DELIVERED_MESSAGE]\n没有闭合"],
    ["a lone closing tag", "没有开头\n[/DELIVERED_MESSAGE]"],
    ["a nested tag", "[DELIVERED_MESSAGE]\n[DELIVERED_MESSAGE]\n[/DELIVERED_MESSAGE]"],
  ])("keeps %s untouched", (_label, text) => {
    const assistant = createAssistantMessage([{ type: "text", text }]);
    const entries = [createEntry("message", assistant, { id: "assistant-1", timestamp: 1 })];

    const projected = stripInternalAssistantInputs(entries);

    expect(projected[0]).toBe(entries[0]);
    expect(projected[0].data.content).toEqual([{ type: "text", text }]);
  });

  it("drops an assistant entry whose only content was an empty legacy marker", () => {
    const assistant = createAssistantMessage([{ type: "text", text: "[DELIVERED_MESSAGE]\n\n[/DELIVERED_MESSAGE]" }]);
    const user = createEntry("message", createUserMessage("hello"), { id: "user-1", timestamp: 1 });

    const projected = stripInternalAssistantInputs([user, createEntry("message", assistant, { id: "assistant-1", timestamp: 2 })]);

    expect(projected).toEqual([user]);
  });

  it("keeps only a safe paired send_message trace in Gemini mode", () => {
    const assistant = createAssistantMessage([
      {
        type: "tool-call",
        toolCallId: "send-1",
        toolName: "send_message",
        input: {
          messages: ["已经发送", '<img src="artifact://old-image"/>'],
          facts: ["可见事实"],
          mode: "element",
          inner_thought: "不可见判断",
          reason: "不应进入历史",
        },
        providerOptions: { google: { thoughtSignature: "call-signature" } },
      },
      {
        type: "tool-call",
        toolCallId: "finish-1",
        toolName: "finish",
        input: { reason: "内部结束原因" },
      },
    ]);
    const tool = createToolMessage([
      {
        type: "tool-result",
        toolCallId: "send-1",
        toolName: "send_message",
        output: { type: "json", value: { ok: true, count: 2, messageIds: ["m1", "m2"] } },
        providerOptions: { google: { thoughtSignature: "result-signature" } },
      },
      { type: "tool-result", toolCallId: "finish-1", toolName: "finish", output: { type: "json", value: { ok: true } } },
    ]);
    const entries = [createEntry("message", assistant, { id: "assistant-1", timestamp: 1 }), createEntry("message", tool, { id: "tool-1", timestamp: 2 })];

    const projected = stripInternalAssistantInputs(entries, "gemini-native");

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({
      id: "assistant-1",
      data: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "send-1",
            toolName: "send_message",
            input: { messages: ["已经发送", "[图片]"], facts: ["可见事实"], mode: "element" },
            providerOptions: { google: { thoughtSignature: "call-signature" } },
          },
          { type: "tool-call", toolCallId: "finish-1", toolName: "finish", input: {} },
        ],
      },
    });
    expect(projected[1]).toMatchObject({
      id: "tool-1",
      data: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "send-1",
            toolName: "send_message",
            providerOptions: { google: { thoughtSignature: "result-signature" } },
          },
          { type: "tool-result", toolCallId: "finish-1", toolName: "finish" },
        ],
      },
    });
    expect(JSON.stringify(projected)).not.toContain("delivered_transcript");
    expect(JSON.stringify(projected)).not.toContain("inner_thought");
    expect(JSON.stringify(projected)).not.toContain("artifact://old-image");
    expect(entries[0]).toEqual(expect.objectContaining({ data: expect.objectContaining({ content: assistant.content }) }));
    expect(stripInternalAssistantInputs(projected, "gemini-native")).toEqual(projected);
  });

  it("keeps a paragraph-split send paired by source-item count rather than platform message IDs", () => {
    const assistant = createAssistantMessage([
      { type: "tool-call", toolCallId: "send-1", toolName: "send_message", input: { messages: ["第一段\n\n第二段"] } },
    ]);
    const tool = createToolMessage([
      {
        type: "tool-result",
        toolCallId: "send-1",
        toolName: "send_message",
        output: { type: "json", value: { ok: true, count: 1, messageIds: ["m1", "m2"] } },
      },
    ]);
    const entries = [createEntry("message", assistant, { id: "assistant-1", timestamp: 1 }), createEntry("message", tool, { id: "tool-1", timestamp: 2 })];

    const projected = stripInternalAssistantInputs(entries, "gemini-native");

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({ data: { content: [{ type: "tool-call", toolCallId: "send-1", input: { messages: ["第一段\n\n第二段"] } }] } });
    expect(projected[1]).toMatchObject({ data: { content: [{ type: "tool-result", toolCallId: "send-1" }] } });
    expect(stripInternalAssistantInputs(entries)[0]).toMatchObject({
      data: { type: "yesimbot.delivered-transcript", data: { messages: ["第一段\n\n第二段"], deliveredCount: 1 } },
    });
  });

  it.each([
    ["partial delivery", { ok: false, sent: ["m1"], failedAt: 1 }],
    ["zero delivery", { ok: false, sent: [], failedAt: 0 }],
    ["malformed success", { ok: true, count: 1 }],
  ])("fails closed for %s in Gemini mode", (_label, result) => {
    const assistant = createAssistantMessage([
      { type: "tool-call", toolCallId: "send-1", toolName: "send_message", input: { messages: ["第一条", "第二条"] } },
    ]);
    const tool = createToolMessage([{ type: "tool-result", toolCallId: "send-1", toolName: "send_message", output: { type: "json", value: result } }]);
    const user = createEntry("message", createUserMessage("当前问题"), { id: "user-1", timestamp: 3 });
    const projected = stripInternalAssistantInputs(
      [createEntry("message", assistant, { id: "assistant-1", timestamp: 1 }), createEntry("message", tool, { id: "tool-1", timestamp: 2 }), user],
      "gemini-native",
    );

    expect(projected).toEqual([user]);
  });

  it("fails closed for unpaired, legacy, malformed, and marker-only delivered history in Gemini mode", () => {
    const unpaired = createEntry(
      "message",
      createAssistantMessage([{ type: "tool-call", toolCallId: "send-unpaired", toolName: "send_message", input: { messages: ["没有结果"] } }]),
      { id: "assistant-unpaired", timestamp: 1 },
    );
    const legacy = createEntry("message", createAssistantMessage("[DELIVERED_MESSAGE]\n旧消息\n[/DELIVERED_MESSAGE]"), {
      id: "assistant-legacy",
      timestamp: 2,
    });
    const malformed = createEntry("message", createAssistantMessage("[DELIVERED_MESSAGE]\n没有闭合"), { id: "assistant-malformed", timestamp: 3 });
    const transcript = createEntry("message", createDeliveredTranscriptMessage({ messages: ["旧 typed transcript"], deliveredCount: 1, partial: false }), {
      id: "transcript-1",
      timestamp: 4,
    });
    const user = createEntry("message", createUserMessage("当前问题"), { id: "user-1", timestamp: 5 });

    expect(stripInternalAssistantInputs([unpaired, legacy, malformed, transcript, user], "gemini-native")).toEqual([user]);
  });

  it("keeps ordinary reads while filtering non-replayable historical traces in Gemini mode", () => {
    const assistant = createAssistantMessage([
      { type: "tool-call", toolCallId: "asset-read", toolName: "read", input: { uri: "asset://reference" } },
      { type: "tool-call", toolCallId: "artifact-read", toolName: "read", input: { uri: "artifact://old" } },
      { type: "tool-call", toolCallId: "image", toolName: "generate_image", input: { prompt: "old image" } },
      { type: "tool-call", toolCallId: "finish", toolName: "finish", input: {} },
    ]);
    const tool = createToolMessage([
      { type: "tool-result", toolCallId: "asset-read", toolName: "read", output: { type: "json", value: { asset: true } } },
      { type: "tool-result", toolCallId: "artifact-read", toolName: "read", output: { type: "json", value: { artifact: true } } },
      { type: "tool-result", toolCallId: "image", toolName: "generate_image", output: { type: "json", value: { uri: "artifact://old" } } },
      { type: "tool-result", toolCallId: "finish", toolName: "finish", output: { type: "json", value: { ok: true } } },
    ]);

    const projected = stripInternalAssistantInputs(
      [createEntry("message", assistant, { id: "assistant-1", timestamp: 1 }), createEntry("message", tool, { id: "tool-1", timestamp: 2 })],
      "gemini-native",
    );

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({
      data: {
        content: [
          { type: "tool-call", toolCallId: "asset-read" },
          { type: "tool-call", toolCallId: "finish" },
        ],
      },
    });
    expect(projected[1]).toMatchObject({
      data: {
        content: [
          { type: "tool-result", toolCallId: "asset-read" },
          { type: "tool-result", toolCallId: "finish" },
        ],
      },
    });
  });
});
