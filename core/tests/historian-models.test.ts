import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LanguageModelV3 } from "@ai-sdk/provider";
import { Context } from "@koishijs/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { apply as applyAnthropic } from "../../providers/anthropic/src/index.js";
import { apply as applyGoogle } from "../../providers/google/src/index.js";
import { ModelService, type ChatModelConfig } from "../src/models/index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(kind: "anthropic" | "google", extra: Partial<ChatModelConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-historian-model-"));
  roots.push(root);
  const ctx = new Context();
  const service = new ModelService(ctx as never, { basePath: root, logLevel: 0 });
  await service.start();
  const ready: Array<() => void> = [];
  const warn = vi.fn();
  const providerContext = {
    on(event: string, callback: () => void) {
      if (event === "ready") ready.push(callback);
    },
    yesimbot: { model: service },
    logger: () => ({ warn }),
  };
  const id = kind === "anthropic" ? "step-5-preview" : "gemini-3.7-flash-high";
  const entry: ChatModelConfig = { id, reasoning: true, thinkingLevel: "high", limit: { context: 147200, output: 8192 }, ...extra };
  const config = { id: "scoped", apiKey: "test-not-a-real-key", baseURL: "https://provider.invalid/v1", chatModels: [entry], webSearch: false };
  if (kind === "anthropic") applyAnthropic(providerContext as never, config);
  else applyGoogle(providerContext as never, config);
  for (const callback of ready) callback();
  const requests: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const response =
      kind === "anthropic"
        ? {
            id: "msg_test",
            type: "message",
            model: id,
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 1 },
          }
        : {
            candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
          };
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return { ctx, service, entry, fullId: `scoped:${id}`, requests, warn, fetch };
}

async function generate(model: LanguageModelV3) {
  return model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "Summarize a synthetic source." }] }], maxOutputTokens: 64 });
}

describe("scoped historian provider requests (mock HTTP only)", () => {
  it.each(["anthropic", "google"] as const)("uses %s native low settings without changing same-ID main high or middleware", async (kind) => {
    const f = await setup(kind);
    const usage = vi.fn();
    f.ctx.on("yesimbot/model-usage" as never, usage);
    const middleware = vi.fn(async ({ doGenerate }: { doGenerate: () => Promise<unknown> }) => doGenerate());
    f.service.middleware({ specificationVersion: "v3", wrapGenerate: middleware as never });
    const revision = f.service.revision;
    const main = f.service.resolveChatModel(f.fullId);
    const historian = f.service.resolveChatModel(f.fullId, undefined, { thinkingLevel: "low" });
    await generate(historian.model as LanguageModelV3);
    await generate(main.model as LanguageModelV3);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(middleware).toHaveBeenCalledTimes(2);
    expect(usage).toHaveBeenCalledTimes(2);
    if (kind === "anthropic") {
      expect(f.requests[0]).toMatchObject({ output_config: { effort: "low" } });
      expect(f.requests[1]).toMatchObject({ output_config: { effort: "high" } });
    } else {
      expect(f.requests[0]).toMatchObject({ generationConfig: { thinkingConfig: { thinkingLevel: "low" } } });
      expect(f.requests[1]).toMatchObject({ generationConfig: { thinkingConfig: { thinkingLevel: "high" } } });
    }
    expect(f.entry.thinkingLevel).toBe("high");
    expect(f.service.resolveChatModel(f.fullId).entry.thinkingLevel).toBe("high");
    expect(f.service.contextLimit(historian.model)).toEqual({ context: 147200, output: 8192 });
    expect(f.service.revision).toBe(revision);
  });

  it("keeps unsupported-level clamping in the provider and warns rather than inventing an effort", async () => {
    const f = await setup("anthropic", { thinkingLevelMap: { low: null, medium: "medium" } });
    await generate(f.service.resolveChatModel(f.fullId, undefined, { thinkingLevel: "low" }).model as LanguageModelV3);
    expect(f.requests[0]).toMatchObject({ output_config: { effort: "medium" } });
    expect(f.warn).toHaveBeenCalledOnce();
    expect(f.entry.thinkingLevel).toBe("high");
  });

  it("uses the provider's disabled-thinking contract for an explicit off instance", async () => {
    const f = await setup("anthropic");
    await generate(f.service.resolveChatModel(f.fullId, undefined, { thinkingLevel: "off" }).model as LanguageModelV3);
    expect(f.requests[0]).toMatchObject({ thinking: { type: "disabled" } });
    expect(f.requests[0]).not.toHaveProperty("output_config");
    expect(f.entry.thinkingLevel).toBe("high");
  });
});
