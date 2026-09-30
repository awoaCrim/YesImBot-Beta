import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { imageToolResultSupportForFormat } from "../src/index.js";

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

async function captureRequest(createModel: (fetch: typeof globalThis.fetch) => { doGenerate(options: { prompt: LanguageModelV3Prompt }): Promise<unknown> }) {
  let body: unknown;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    body = JSON.parse(await new Response(init?.body ?? null).text());
    throw new Error("captured request");
  };

  await expect(createModel(fetch).doGenerate({ prompt: createImageToolResultPrompt() })).rejects.toThrow("captured request");
  return body as Record<string, unknown>;
}

describe("OpenAI transport capabilities", () => {
  it("marks Chat Completions as unsupported for image tool results", () => {
    expect(imageToolResultSupportForFormat("chat")).toBe("unsupported");
  });

  it("marks Responses as native for image tool results", () => {
    expect(imageToolResultSupportForFormat("responses")).toBe("native");
  });

  it.each(["native", "unsupported", "unknown"] as const)("honors an explicit %s override", (override) => {
    expect(imageToolResultSupportForFormat("responses", override)).toBe(override);
    expect(imageToolResultSupportForFormat("chat", override)).toBe(override);
  });

  it("serializes a tool-result image as a structured Responses input_image", async () => {
    const body = await captureRequest((fetch) => createOpenAI({ apiKey: "test", baseURL: "https://fixture.invalid/v1", fetch }).responses("fixture-model"));

    const input = body.input as Array<Record<string, unknown>>;
    const output = input.find((item) => item.type === "function_call_output")?.output as Array<Record<string, unknown>>;
    const image = output.find((item) => item.type === "input_image");
    const text = output.find((item) => item.type === "input_text");

    expect(image).toEqual({ type: "input_image", image_url: `data:image/png;base64,${fixtureBase64}` });
    expect(text?.text).not.toContain(fixtureBase64);
  });

  it("keeps the Chat adapter stringification as a negative guard, not a production route", async () => {
    expect(imageToolResultSupportForFormat("chat")).toBe("unsupported");

    const body = await captureRequest((fetch) => createOpenAI({ apiKey: "test", baseURL: "https://fixture.invalid/v1", fetch }).chat("fixture-model"));

    const messages = body.messages as Array<Record<string, unknown>>;
    const toolMessage = messages.find((message) => message.role === "tool");

    expect(typeof toolMessage?.content).toBe("string");
    expect(toolMessage?.content).toContain("image-data");
    expect(toolMessage?.content).toContain(fixtureBase64);
  });
});
