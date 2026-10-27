import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModelV3, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { apply } from "../src/google.js";

type RegisteredProvider = {
  chat(modelId: string): LanguageModelV3;
  chatCapabilities?(modelId: string): {
    readonly imageToolResult?: "native" | "unsupported" | "unknown";
    readonly imageToolResultMediaTypes?: readonly string[];
    readonly videoInput?: "native" | "unsupported" | "unknown";
    readonly historyProjection?: "default" | "gemini-native";
  };
};

const fixtureBase64 = Buffer.from([0, 1, 2, 3]).toString("base64");

afterEach(() => vi.unstubAllGlobals());

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
    expect(provider.chatCapabilities?.("gemini-3.7-flash-high")).toEqual({
      imageToolResult: "native",
      imageToolResultMediaTypes: ["image/png", "image/jpeg"],
      videoInput: "native",
      historyProjection: "gemini-native",
    });
  });

  it.each(["doGenerate", "doStream"] as const)(
    "projects read video into the current user input for %s without changing tool pairing or images",
    async (method) => {
      let body: unknown;
      vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
        body = JSON.parse(await new Response(init?.body ?? null).text());
        throw new Error("captured request");
      });
      const prompt: LanguageModelV3Prompt = [
        { role: "user", content: [{ type: "text", text: "older input" }] },
        { role: "assistant", content: [{ type: "text", text: "older answer" }] },
        { role: "user", content: [{ type: "text", text: "inspect the attachment" }] },
        ...createImageToolResultPrompt(),
      ];
      const tool = prompt.at(-1)!;
      if (tool.role !== "tool") throw new Error("expected tool result");
      const result = tool.content[0]!;
      if (result.type !== "tool-result" || result.output.type !== "content") throw new Error("expected content result");
      result.output.value.push({ type: "file-data", data: fixtureBase64, mediaType: "video/mp4" });
      const original = JSON.stringify(prompt);
      const model = registerProvider().chat("gemini-3.8-flash-high");

      await expect(model[method]({ prompt })).rejects.toThrow("captured request");
      await expect(model[method]({ prompt })).rejects.toThrow("captured request");

      const request = body as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
      expect(request.contents).toHaveLength(5);
      expect(request.contents[0]!.parts).toEqual([{ text: "older input" }]);
      expect(request.contents[2]!.parts).toEqual([{ text: "inspect the attachment" }, { inlineData: { mimeType: "video/mp4", data: fixtureBase64 } }]);
      expect(request.contents[3]!.parts[0]).toMatchObject({ functionCall: { id: "read-1", name: "read" } });
      expect(request.contents[4]!.parts[0]).toMatchObject({
        functionResponse: { id: "read-1", name: "read", parts: [{ inlineData: { mimeType: "image/png", data: fixtureBase64 } }] },
      });
      expect(JSON.stringify(prompt)).toBe(original);
    },
  );

  it("rejects video tool output without an owning user input before sending a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      registerProvider()
        .chat("gemini-3.8-flash-high")
        .doGenerate({
          prompt: [
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "read-1",
                  toolName: "read",
                  output: { type: "content", value: [{ type: "file-data", data: fixtureBase64, mediaType: "video/mp4" }] },
                },
              ],
            },
          ],
        }),
    ).rejects.toThrow("preceding user input");
    expect(fetch).not.toHaveBeenCalled();
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

  it("serializes a paired historical send trace without a delivered transcript block", async () => {
    let body: unknown;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      body = JSON.parse(await new Response(init?.body ?? null).text());
      throw new Error("captured request");
    };
    const model = createGoogleGenerativeAI({ apiKey: "test", baseURL: "https://fixture.invalid/v1beta", fetch }).chat("gemini-3.7-flash-high");

    await expect(
      model.doGenerate({
        prompt: [
          { role: "system", content: "系统规则" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "send-1",
                toolName: "send_message",
                input: { messages: ["已经发送"] },
                providerOptions: { google: { thoughtSignature: "signature-history" } },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "send-1",
                toolName: "send_message",
                output: { type: "json", value: { ok: true, count: 1 } },
              },
            ],
          },
          { role: "user", content: [{ type: "text", text: "新的问题" }] },
        ],
      }),
    ).rejects.toThrow("captured request");

    const request = body as {
      systemInstruction?: unknown;
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    expect(request.systemInstruction).toEqual({ parts: [{ text: "系统规则" }] });
    expect(request.contents[0]).toMatchObject({
      role: "model",
      parts: [{ functionCall: { id: "send-1", name: "send_message", args: { messages: ["已经发送"] } }, thoughtSignature: "signature-history" }],
    });
    expect(request.contents[1]).toMatchObject({
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "send-1",
            name: "send_message",
            response: { name: "send_message", content: { ok: true, count: 1 } },
          },
        },
      ],
    });
    expect(JSON.stringify(request)).not.toContain("delivered_transcript_history");
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
