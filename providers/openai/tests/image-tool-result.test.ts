import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { imageToolResultUserMessageMiddleware } from "../src/image-tool-result.js";

const imageData = Buffer.from([0, 1, 2, 3]).toString("base64");

async function transform(prompt: LanguageModelV3Prompt) {
  const params = { prompt, temperature: 0.25 } as LanguageModelV3CallOptions;
  const result = await imageToolResultUserMessageMiddleware.transformParams!({
    type: "generate",
    params,
    model: {} as never,
  });
  return { params, result };
}

describe("OpenAI image tool-result user-message placement", () => {
  it("clones unchanged prompts without adding messages", async () => {
    const prompt: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    const { params, result } = await transform(prompt);

    expect(result).toEqual(params);
    expect(result).not.toBe(params);
    expect(result.prompt).not.toBe(params.prompt);
    expect(result.prompt[0]).not.toBe(params.prompt[0]);
  });

  it("preserves metadata and places each image immediately after its mixed tool result", async () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "read-1", toolName: "read", input: { uri: "asset://one" } },
          { type: "tool-call", toolCallId: "other-1", toolName: "other", input: {} },
          { type: "tool-call", toolCallId: "read-2", toolName: "read", input: { uri: "asset://two" } },
        ],
      },
      {
        role: "tool",
        providerOptions: { openai: { custom: "message-metadata" } },
        content: [
          {
            type: "tool-result",
            toolCallId: "read-1",
            toolName: "read",
            providerOptions: { openai: { custom: "result-metadata" } },
            output: {
              type: "content",
              providerOptions: { openai: { custom: "output-metadata" } },
              value: [
                { type: "text", text: "asset://one image/png" },
                { type: "image-data", data: imageData, mediaType: "image/png", providerOptions: { openai: { imageDetail: "low" } } },
                { type: "file-data", data: "ZmlsZQ==", mediaType: "text/plain", filename: "note.txt" },
              ],
            },
          },
          {
            type: "tool-result",
            toolCallId: "other-1",
            toolName: "other",
            output: { type: "json", value: { ok: true } },
          },
          {
            type: "tool-result",
            toolCallId: "read-2",
            toolName: "read",
            output: {
              type: "content",
              value: [
                { type: "image-url", url: "https://fixture.invalid/image.png" },
                { type: "text", text: "asset://two image/png" },
              ],
            },
          },
        ],
      },
    ];
    const snapshot = structuredClone(prompt);
    const { params, result } = await transform(prompt);

    expect(params.prompt).toEqual(snapshot);
    expect(result.prompt).toHaveLength(5);
    expect(result.prompt[1]).toMatchObject({
      role: "tool",
      providerOptions: { openai: { custom: "message-metadata" } },
      content: [
        {
          type: "tool-result",
          toolCallId: "read-1",
          toolName: "read",
          providerOptions: { openai: { custom: "result-metadata" } },
          output: {
            type: "content",
            providerOptions: { openai: { custom: "output-metadata" } },
            value: [
              { type: "text", text: "asset://one image/png" },
              { type: "file-data", data: "ZmlsZQ==", mediaType: "text/plain", filename: "note.txt" },
            ],
          },
        },
      ],
    });
    expect(result.prompt[2]).toMatchObject({
      role: "user",
      content: [{ type: "file", data: imageData, mediaType: "image/png", providerOptions: { openai: { imageDetail: "low" } } }],
    });
    expect(result.prompt[3]).toMatchObject({
      role: "tool",
      providerOptions: { openai: { custom: "message-metadata" } },
      content: [
        {
          type: "tool-result",
          toolCallId: "other-1",
          toolName: "other",
          output: { type: "json", value: { ok: true } },
        },
        {
          type: "tool-result",
          toolCallId: "read-2",
          toolName: "read",
          output: { type: "content", value: [{ type: "text", text: "asset://two image/png" }] },
        },
      ],
    });
    const promoted = result.prompt[4];
    expect(promoted).toMatchObject({ role: "user", content: [{ type: "file", mediaType: "image/*" }] });
    if (promoted?.role !== "user" || promoted.content[0]?.type !== "file") throw new Error("expected promoted user image message");
    expect(promoted.content[0].data).toEqual(new URL("https://fixture.invalid/image.png"));
    expect(JSON.stringify([result.prompt[1], result.prompt[3]])).not.toContain(imageData);
  });

  it.each(["not a url", "asset://fixture", "file:///etc/passwd", "data:text/plain;base64,SGVsbG8="])(
    "removes an unsafe image URL without throwing or promoting it: %s",
    async (url) => {
      const prompt: LanguageModelV3Prompt = [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "unsafe-image",
              toolName: "read",
              output: { type: "content", value: [{ type: "image-url", url }] },
            },
          ],
        },
      ];
      const { result } = await transform(prompt);

      expect(result.prompt).toHaveLength(1);
      expect(result.prompt[0]).toMatchObject({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "unsafe-image",
            output: { type: "content", value: [{ type: "text", text: "[Image URL could not be safely promoted.]" }] },
          },
        ],
      });
      expect(JSON.stringify(result.prompt)).not.toContain(url);
    },
  );

  it("keeps tool-call pairing when a result contains only images", async () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-only-image",
            toolName: "read",
            output: { type: "content", value: [{ type: "image-data", data: imageData, mediaType: "image/png" }] },
          },
        ],
      },
    ];
    const { result } = await transform(prompt);

    expect(result.prompt[0]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "read-only-image",
          toolName: "read",
          output: { type: "content", value: [{ type: "text" }] },
        },
      ],
    });
    expect(JSON.stringify(result.prompt[0])).not.toContain(imageData);
    expect(result.prompt[1]).toMatchObject({ role: "user", content: [{ type: "file", data: imageData, mediaType: "image/png" }] });
  });

  it("is idempotent and does not append duplicate user image messages", async () => {
    const prompt: LanguageModelV3Prompt = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "read-1",
            toolName: "read",
            output: {
              type: "content",
              value: [
                { type: "text", text: "asset://one image/png" },
                { type: "image-data", data: imageData, mediaType: "image/png" },
              ],
            },
          },
        ],
      },
    ];
    const first = (await transform(prompt)).result;
    const second = await imageToolResultUserMessageMiddleware.transformParams!({ type: "stream", params: first, model: {} as never });

    expect(second).toEqual(first);
    expect(second.prompt.filter((message) => message.role === "user")).toHaveLength(1);
  });
});
