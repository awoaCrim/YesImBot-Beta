import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { apply } from "../src/index.js";

type RegisteredProvider = {
  chatCapabilities?(modelId: string): { readonly imageToolResult?: "native" | "unsupported" | "unknown" };
};

const fixtureBase64 = Buffer.from([0, 1, 2, 3]).toString("base64");

function registerProvider(): RegisteredProvider {
  let ready: (() => void) | undefined;
  const model = { register: vi.fn(() => () => undefined) };
  const ctx = {
    on(event: string, callback: () => void) {
      if (event === "ready") ready = callback;
    },
    yesimbot: { model },
  };
  apply(ctx as never, { id: "google", apiKey: "test", chatModels: [], embeddingModels: [] } as never);
  if (!ready) throw new Error("provider did not register a ready callback");
  ready();
  return model.register.mock.calls[0]?.[0] as RegisteredProvider;
}

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

describe("Google provider capabilities", () => {
  it("declares native image tool-result support", () => {
    const provider = registerProvider();
    expect(provider.chatCapabilities?.("gemini-3.7-flash-high")).toEqual({ imageToolResult: "native" });
  });

  it("serializes a Gemini 3 tool-result image inside functionResponse.parts", async () => {
    let body: unknown;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      body = JSON.parse(await new Response(init?.body ?? null).text());
      throw new Error("captured request");
    };
    const model = createGoogleGenerativeAI({ apiKey: "test", baseURL: "https://fixture.invalid/v1beta", fetch }).chat("gemini-3.7-flash-high");

    await expect(model.doGenerate({ prompt: createImageToolResultPrompt() })).rejects.toThrow("captured request");

    const contents = (body as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents;
    const response = contents[1]?.parts[0]?.functionResponse as { parts?: Array<Record<string, unknown>> };
    expect(response.parts).toEqual([
      {
        inlineData: {
          mimeType: "image/png",
          data: fixtureBase64,
        },
      },
    ]);
  });

  it("serializes required tool choice as Gemini ANY and parses a function call", async () => {
    let body: unknown;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      body = JSON.parse(await new Response(init?.body ?? null).text());
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: "call-1",
                      name: "send_message",
                      args: { message: "hello" },
                    },
                    thoughtSignature: "signature-1",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          responseId: "response-1",
          usageMetadata: {
            promptTokenCount: 1,
            candidatesTokenCount: 1,
            totalTokenCount: 2,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    };
    const model = createGoogleGenerativeAI({ apiKey: "test", baseURL: "https://fixture.invalid/v1beta", fetch }).chat("gemini-3.7-flash-high");

    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "send a message" }] }],
      tools: [
        {
          type: "function",
          name: "send_message",
          description: "send a message",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ],
      toolChoice: { type: "required" },
    });

    const request = body as {
      tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
      toolConfig?: { functionCallingConfig?: Record<string, unknown> };
    };
    expect(request.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY" } });
    expect(request.tools[0]?.functionDeclarations[0]).toMatchObject({ name: "send_message" });
    expect(result.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "send_message",
        input: JSON.stringify({ message: "hello" }),
        providerMetadata: { google: { thoughtSignature: "signature-1" } },
      },
    ]);
    expect(result.usage.inputTokens.total).toBe(1);
  });
});
