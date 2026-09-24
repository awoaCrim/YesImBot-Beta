import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { imageToolResultSupport } from "../src/index.js";

const fixtureBase64 = Buffer.from([0, 1, 2, 3]).toString("base64");

function createImageToolResultPrompt(): LanguageModelV3Prompt {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "read-1",
          toolName: "read",
          input: { uri: "asset://fixture" },
        },
      ],
    },
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
              { type: "text", text: "[图片资源，image/png，4 B]" },
              { type: "image-data", data: fixtureBase64, mediaType: "image/png" },
            ],
          },
        },
      ],
    },
  ];
}

describe("Anthropic transport capabilities", () => {
  it("declares native image tool-result support", () => {
    expect(imageToolResultSupport).toBe("native");
  });

  it("serializes a tool-result image as an Anthropic tool_result image block", async () => {
    let body: unknown;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      body = JSON.parse(await new Response(init?.body ?? null).text());
      throw new Error("captured request");
    };
    const model = createAnthropic({ apiKey: "test", baseURL: "https://fixture.invalid/v1", fetch }).chat("fixture-model");

    await expect(model.doGenerate({ prompt: createImageToolResultPrompt() })).rejects.toThrow("captured request");

    const messages = (body as { messages: Array<Record<string, unknown>> }).messages;
    const toolResult = (messages[1]?.content as Array<Record<string, unknown>>)[0];
    const content = toolResult.content as Array<Record<string, unknown>>;
    const image = content.find((item) => item.type === "image");
    const text = content.find((item) => item.type === "text");

    expect(toolResult).toMatchObject({ type: "tool_result", tool_use_id: "read-1" });
    expect(image).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: fixtureBase64 },
    });
    expect(text?.text).not.toContain(fixtureBase64);
  });
});
