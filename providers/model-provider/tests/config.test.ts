import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@koishijs/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { ModelService } from "../../../core/src/models/index.js";
import { Config, apply, reusable } from "../src/index.js";

const temporaryDirectories: string[] = [];
const types = ["openai", "anthropic", "google", "deepseek"] as const;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function createRegistry(overrides: unknown = {}) {
  const directory = await mkdtemp(join(tmpdir(), "yesimbot-provider-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "models.json"), JSON.stringify(overrides));
  const context = new Context();
  context.baseDir = directory;
  const service = new ModelService(context as never, { basePath: directory });
  await service.start();
  return service;
}

function install(service: ModelService, config: Parameters<typeof apply>[1]) {
  const callbacks = new Map<string, Array<() => void>>();
  const context = {
    yesimbot: { model: service },
    logger: () => ({ warn: vi.fn() }),
    on(event: string, callback: () => void) {
      callbacks.set(event, [...(callbacks.get(event) ?? []), callback]);
    },
  };
  apply(context as never, config);
  return {
    ready: () => callbacks.get("ready")?.forEach((callback) => callback()),
    dispose: () => callbacks.get("dispose")?.forEach((callback) => callback()),
  };
}

describe("unified Provider configuration", () => {
  it("is reusable and defaults to the existing OpenAI configuration", () => {
    expect(reusable).toBe(true);
    expect(Config({ apiKey: "test" })).toMatchObject({
      type: "openai",
      id: "openai",
      format: "chat",
      imageToolResultPlacement: "tool-output",
      embeddingModels: [{ id: "text-embedding-3-small" }, { id: "text-embedding-3-large" }],
    });
  });

  it.each([
    ["openai", "gpt-4o"],
    ["anthropic", "claude-opus-4-6"],
    ["google", "gemini-2.5-flash"],
    ["deepseek", "deepseek-v4-flash"],
  ] as const)("preserves the %s branch defaults without wrapper keys", (type, firstModel) => {
    const config = Config({ type, apiKey: "test" });
    expect(config.id).toBe(type);
    expect(config.chatModels[0]?.id).toBe(firstModel);
    expect(config.chatModels[0]).toMatchObject({ toolCall: true, reasoning: true });
    expect(config).not.toHaveProperty("connection");
    expect(config).not.toHaveProperty("options");
    expect(config).not.toHaveProperty("providers");
    if (type === "google") {
      expect(config).toMatchObject({ imageToolResultMediaTypes: ["image/png", "image/jpeg"], embeddingModels: [] });
      expect(config).not.toHaveProperty("videoToolResultSupport");
    }
    if (type === "deepseek") expect(config).toHaveProperty("thinking", "high");
  });

  it.each(types)("preserves explicit IDs, empty model lists, endpoints and operator metadata for %s", (type) => {
    const input = {
      type,
      id: "custom",
      apiKey: "test",
      baseURL: "https://fixture.invalid/v1",
      chatModels: [],
      $label: "custom label",
      $filter: { channelId: "room" },
    };
    expect(Config(input)).toMatchObject(input);
  });

  it("rejects unsupported types and missing credentials", () => {
    expect(() => Config({ type: "other", apiKey: "test" })).toThrow();
    expect(() => Config({ type: "google" })).toThrow();
  });

  it.each(types)("retains registration timing, effective model IDs, capabilities and disposal for %s", async (type) => {
    const service = await createRegistry({ aliases: { main: "custom:model" }, chat: { "custom:model": { thinkingLevel: "off" } } });
    const config = Config({ type, id: "custom", apiKey: "test", chatModels: [{ id: "model", reasoning: true }] });
    const scope = install(service, config);
    expect(service.listProviders()).toEqual(type === "deepseek" ? ["custom"] : []);
    scope.ready();
    const model = service.resolveChatModel("main");
    expect(model.fullId).toBe("custom:model");
    expect(model.entry.thinkingLevel).toBe("off");
    expect(model.capabilities.imageToolResult).toBe(type === "anthropic" || type === "google" ? "native" : type === "openai" ? "unsupported" : "unknown");
    if (type === "google") expect(model.capabilities).toMatchObject({ videoInput: "native", historyProjection: "gemini-native" });
    scope.dispose();
    expect(service.listProviders()).toEqual([]);
    expect(() => service.resolveChatModel("main")).toThrow();
  });

  it("keeps clones independent and rejects duplicate IDs without unregistering the original", async () => {
    const service = await createRegistry();
    const first = install(service, Config({ type: "openai", id: "first", apiKey: "test" }));
    const second = install(service, Config({ type: "openai", id: "second", apiKey: "test" }));
    first.ready();
    second.ready();
    expect(service.listProviders()).toEqual(["first", "second"]);
    const duplicate = install(service, Config({ type: "openai", id: "first", apiKey: "test" }));
    expect(() => duplicate.ready()).toThrow('Provider "first" is already registered');
    duplicate.dispose();
    expect(service.listProviders()).toEqual(["first", "second"]);
    first.dispose();
    expect(service.listProviders()).toEqual(["second"]);
    second.dispose();
    expect(service.listProviders()).toEqual([]);
  });
});
