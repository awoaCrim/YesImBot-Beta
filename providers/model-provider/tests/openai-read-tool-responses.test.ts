import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpenAI } from "@ai-sdk/openai";
import { stepCountIs, streamText, type ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { createReadTool } from "../../../core/src/agents/tools.js";
import { ChannelResources } from "../../../core/src/resources/index.js";
import { PNG_BYTES } from "../../../core/tests/helpers/index.js";
import { withUserMessageImageToolResults } from "../src/image-tool-result.js";

const roots: string[] = [];

function sseResponse(events: unknown[]) {
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function created(ordinal: number) {
  return {
    type: "response.created",
    response: { id: `resp-${ordinal}`, created_at: 1_700_000_000 + ordinal, model: "fixture-model", service_tier: null },
  };
}

function completed() {
  return {
    type: "response.completed",
    response: {
      incomplete_details: null,
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
      },
      reasoning: null,
      service_tier: null,
    },
  };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("production read tool over OpenAI Responses", () => {
  it("keeps the native image available until the real second-step request is serialized", async () => {
    const root = await mkdtemp(join(tmpdir(), "yesimbot-responses-read-"));
    roots.push(root);
    const resources = new ChannelResources(root, true);
    const assetId = await resources.assets.put(PNG_BYTES);
    const uri = `asset://${assetId}`;
    const read = createReadTool(resources, { mode: "native" });
    const project = read.toModelOutput!;
    const projectionCalls: string[] = [];
    read.toModelOutput = async (options) => {
      projectionCalls.push(options.toolCallId);
      return project(options);
    };
    const { name: _name, ...readTool } = read;
    const requests: Array<Record<string, unknown>> = [];

    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(await new Response(init?.body ?? null).text()) as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 1) {
        const args = JSON.stringify({ uri });
        return sseResponse([
          created(1),
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", id: "fc-1", call_id: "read-call", name: "read", arguments: "", namespace: null },
          },
          { type: "response.function_call_arguments.delta", item_id: "fc-1", output_index: 0, delta: args },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc-1",
              call_id: "read-call",
              name: "read",
              arguments: args,
              status: "completed",
              namespace: null,
            },
          },
          completed(),
        ]);
      }
      return sseResponse([created(2), completed()]);
    };

    const result = streamText({
      model: withUserMessageImageToolResults(createOpenAI({ apiKey: "test", baseURL: "https://fixture.invalid/v1", fetch }).responses("fixture-model")),
      prompt: "Inspect the image.",
      tools: { read: readTool } as ToolSet,
      stopWhen: stepCountIs(2),
    });
    await result.consumeStream();

    const steps = await result.steps;
    expect(steps.flatMap((step) => step.response.messages).some((message) => message.role === "user")).toBe(false);
    expect(requests).toHaveLength(2);
    expect(projectionCalls.filter((id) => id === "read-call").length).toBeGreaterThanOrEqual(2);
    const input = requests[1]?.input as Array<Record<string, unknown>>;
    const toolOutputIndex = input.findIndex((item) => item.type === "function_call_output");
    const toolOutput = input[toolOutputIndex]?.output;
    expect(Array.isArray(toolOutput)).toBe(true);
    if (!Array.isArray(toolOutput)) throw new Error("expected structured function_call_output");
    expect(toolOutput).toEqual([expect.objectContaining({ type: "input_text" })]);
    expect(toolOutput.some((item) => item.type === "input_image")).toBe(false);
    expect(JSON.stringify(toolOutput)).not.toContain(Buffer.from(PNG_BYTES).toString("base64"));

    const imageMessageIndex = input.findIndex(
      (item) =>
        item.role === "user" &&
        Array.isArray(item.content) &&
        item.content.some((part) => typeof part === "object" && part !== null && "type" in part && part.type === "input_image"),
    );
    expect(imageMessageIndex).toBe(toolOutputIndex + 1);
    const imageMessage = input[imageMessageIndex];
    expect(imageMessage).toMatchObject({
      role: "user",
      content: [
        {
          type: "input_image",
          image_url: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`,
        },
      ],
    });
  });
});
