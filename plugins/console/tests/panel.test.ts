import { describe, expect, it, vi } from "vitest";

vi.mock("@koishijs/loader", () => ({}));
vi.mock("@koishijs/console", () => ({ DataService: class {} }));

import { buildPanelPayload } from "../src/panel.js";

function context(plugins: Record<string, unknown>, providers: string[] = []) {
  return {
    loader: { config: { plugins: { "group:yesimbot": plugins } } },
    bots: [],
    yesimbot: {
      model: {
        listProviders: () => providers,
        listChatModels: () => [],
        listEmbeddingModels: () => [],
        getDefaultChatModelId: () => undefined,
        getDefaultEmbeddingModelId: () => undefined,
      },
    },
  };
}

describe("unified Provider console status", () => {
  it("uses each clone's configured ID and opens the correct instance", () => {
    const payload = buildPanelPayload(
      context(
        {
          "yesimbot-model-provider:first": { type: "google", id: "custom-google" },
          "yesimbot-model-provider:second": { type: "openai", id: "custom-openai" },
        },
        ["custom-google", "custom-openai"],
      ) as never,
      new Map(),
      [],
    );
    expect(payload.plugins).toEqual([
      expect.objectContaining({ label: "模型接入", status: "enabled", detail: "已注册：custom-google", configPath: "first" }),
      expect.objectContaining({ label: "模型接入", status: "enabled", detail: "已注册：custom-openai", configPath: "second" }),
    ]);
  });

  it("uses protocol defaults rather than the package name and reports missing/disabled instances", () => {
    const payload = buildPanelPayload(
      context(
        {
          "yesimbot-model-provider:google": { type: "google" },
          "yesimbot-model-provider:missing": { type: "anthropic", id: "missing" },
          "~yesimbot-model-provider:off": { type: "deepseek", id: "not-registered" },
        },
        ["google"],
      ) as never,
      new Map(),
      [],
    );
    expect(payload.plugins.find((plugin) => plugin.configPath === "google")).toMatchObject({ status: "enabled", detail: "已注册：google" });
    expect(payload.plugins.find((plugin) => plugin.configPath === "missing")).toMatchObject({
      status: "attention",
      detail: "已启用但 provider 未注册：missing",
    });
    expect(payload.plugins.find((plugin) => plugin.configPath === "off")).toMatchObject({ status: "disabled", detail: "未启用" });
    expect(payload.attention.some((issue) => issue.message.includes("not-registered"))).toBe(false);
  });

  it("flags duplicate effective IDs without treating disabled clones as registrations", () => {
    const payload = buildPanelPayload(
      context(
        {
          "yesimbot-model-provider:first": { type: "openai" },
          "yesimbot-model-provider:second": { type: "openai", id: "openai" },
          "~yesimbot-model-provider:off": { type: "openai", id: "openai" },
        },
        ["openai"],
      ) as never,
      new Map(),
      [],
    );
    const active = payload.plugins.filter((plugin) => plugin.enabled);
    expect(new Set(payload.plugins.map((plugin) => plugin.key)).size).toBe(3);
    expect(active).toHaveLength(2);
    expect(active.every((plugin) => plugin.status === "attention" && plugin.detail === "重复的 provider 标识：openai")).toBe(true);
    expect(payload.plugins.find((plugin) => !plugin.enabled)).toMatchObject({ status: "disabled", detail: "未启用" });
  });

  it("opens the actual configured Provider instance during onboarding", () => {
    const payload = buildPanelPayload(context({ "~yesimbot-model-provider:connection": { type: "openai" } }) as never, new Map(), []);
    expect(payload.onboarding.steps.find((step) => step.id === "model")?.target).toBe("/plugins/connection");
  });
});
