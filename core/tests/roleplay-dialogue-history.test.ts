import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@koishijs/core";
import { createEntry, createUserMessage, EphemeralImageProjectionStore, type AgentPlugin } from "@yesimbot/agent-runtime";
import { h } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("../src/agents/tools.js", async (original) => ({ ...(await original<object>()), pacedDelay: () => 0 }));

import RoleplayPlugin from "../../plugins/roleplay/src/index.js";
import { apply as applyGoogle } from "../../providers/google/src/index.js";
import { apply as applyOpenAI } from "../../providers/openai/src/index.js";
import { Agents } from "../src/agents/index.js";
import { Channel } from "../src/channels/index.js";
import { ModelService } from "../src/models/index.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import { defaultConfig, defaultMessageRecord, testScope } from "./helpers/index.js";

type Provider = "openai" | "google";

type Action = { name: string; args: Record<string, unknown>; signature?: string } | { text: string };

type WirePart = {
  text?: string;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
};

type WireTurn = {
  role: string;
  parts?: WirePart[];
  content?: string | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{ function: { name: string; arguments: string } }>;
};

type WireRequest = { messages?: WireTurn[]; contents?: WireTurn[]; systemInstruction?: { parts: WirePart[] } };

const seedQuestion = "ROLE_HISTORY_SEED_QUESTION";
const seedAnswer = "ROLE_HISTORY_SEED_ANSWER";
const seedOnlyAnswer = "ROLE_HISTORY_CHARACTER_ONLY";
const currentQuestion = "ROLE_HISTORY_REAL_CURRENT";
const signature = "c3ludGhldGljLWxvb2t1cC1zaWduYXR1cmU=";
const exampleText = `<START>\n{{user}}: ${seedQuestion}\n{{char}}: ${seedAnswer}\n<START>\n{{char}}: ${seedOnlyAnswer}`;
const roots: string[] = [];
const runtimes: ChannelRuntime[] = [];
const roleplays: RoleplayPlugin[] = [];
const services: ModelService[] = [];
const matrix = (["openai", "google"] as const).flatMap((provider) => [false, true].map((magic) => ({ provider, magic })));
const send = (text: string): Action => ({ name: "send_message", args: { parts: [{ kind: "text", text }] } });

function body(turn: WireTurn): string {
  if (turn.parts) return turn.parts.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n");
  if (typeof turn.content === "string") return turn.content;
  return turn.content?.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n") ?? "";
}

function dialogue(request: WireRequest): WireTurn[] {
  return (request.contents ?? request.messages ?? []).filter((turn) => turn.role !== "system" && turn.role !== "developer");
}

function systemText(request: WireRequest): string {
  return (
    request.systemInstruction?.parts.map((part) => part.text ?? "").join("\n") ??
    request.messages
      ?.filter((turn) => turn.role === "system")
      .map(body)
      .join("\n") ??
    ""
  );
}

function text(request: WireRequest): string {
  return dialogue(request).map(body).join("\n");
}

function occurrences(value: string, marker: string): number {
  return value.split(marker).length - 1;
}

function png(card: unknown): Buffer {
  const data = Buffer.from(`ccv3\0${Buffer.from(JSON.stringify(card)).toString("base64")}`);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), length, Buffer.from("tEXt"), data, Buffer.alloc(4)]);
}

function streamResponse(provider: Provider, action: Action, index: number): Response {
  if (provider === "google") {
    const part =
      "text" in action ? { text: action.text } : { functionCall: { name: action.name, args: action.args }, thoughtSignature: action.signature ?? signature };
    return new Response(
      `data: ${JSON.stringify({
        candidates: [{ index: 0, content: { role: "model", parts: [part] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 1, totalTokenCount: 101 },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  const delta =
    "text" in action
      ? { role: "assistant", content: action.text }
      : {
          role: "assistant",
          tool_calls: [{ index: 0, id: `synthetic-call-${index}`, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }],
        };
  const chunks = [
    { id: `synthetic-${index}`, object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [{ index: 0, delta, finish_reason: null }] },
    {
      id: `synthetic-${index}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
      choices: [{ index: 0, delta: {}, finish_reason: "text" in action ? "stop" : "tool_calls" }],
      usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
    },
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function fixture(provider: Provider, magic: boolean, enabled: boolean, script: Action[], examples = exampleText) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-role-history-wire-"));
  roots.push(root);
  await writeFile(
    join(root, "card.png"),
    png({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "RoleFixture",
        description: "SYNTHETIC_CHARACTER_DEFINITION",
        personality: "",
        scenario: "",
        first_mes: "GREETING_MUST_NOT_APPEAR",
        mes_example: examples,
        alternate_greetings: [],
        group_only_greetings: [],
        character_version: "1",
        creator_notes: "",
        system_prompt: "SYNTHETIC_CARD_RULE",
        post_history_instructions: "SYNTHETIC_POST_RULE",
        tags: [],
        creator: "",
        extensions: {},
      },
    }),
  );
  const ctx = new Context();
  const service = new ModelService(ctx as never, { basePath: root, logLevel: 0 });
  services.push(service);
  await service.start();
  const ready: Array<() => void> = [];
  const providerContext = {
    on(event: string, callback: () => void) {
      if (event === "ready") ready.push(callback);
    },
    yesimbot: { model: service },
    logger: () => ({ warn: vi.fn() }),
  };
  const modelId = provider === "google" ? "gemini-3.7-flash-high" : "gpt-4o";
  const common = {
    id: "role-history-wire",
    apiKey: "synthetic-not-a-real-key",
    baseURL: provider === "google" ? "https://provider.invalid/v1beta" : "https://provider.invalid/v1",
    chatModels: [{ id: modelId, limit: { context: 147200, output: 8192 } }],
  };
  if (provider === "google") applyGoogle(providerContext as never, common);
  else applyOpenAI(providerContext as never, { ...common, format: "chat" });
  for (const callback of ready) callback();
  const requests: WireRequest[] = [];
  const fetch = vi.fn(async (url: unknown, init: RequestInit) => {
    expect(String(url)).toMatch(/^https:\/\/provider\.invalid\//);
    const action = script[requests.length];
    if (!action) throw new Error("unexpected synthetic provider request");
    requests.push(JSON.parse(String(init.body)) as WireRequest);
    return streamResponse(provider, action, requests.length);
  });
  vi.stubGlobal("fetch", fetch);
  const model = service.resolveChatModel(`role-history-wire:${modelId}`);
  const agents = new Agents(ctx as never);
  const roleContext = { baseDir: root, logger: () => ({}), on: vi.fn(), yesimbot: { agent: agents } } as unknown as ConstructorParameters<
    typeof RoleplayPlugin
  >[0];
  const roleplay = new RoleplayPlugin(roleContext, { characterCard: "card.png", enableGreeting: false, exampleDialoguesAsHistory: enabled });
  roleplays.push(roleplay);
  await roleplay.start();
  const roleProfile = await agents.resolveRoleProfile(testScope);
  const projection = new EphemeralImageProjectionStore();
  let deliveries = 0;
  const bot = { selfId: "bot-1", platform: "test", sendMessage: vi.fn(async () => [`synthetic-platform-${++deliveries}`]) };
  const plugins = await agents.setup(testScope, bot as never, { rolePromptsManaged: true, imageProjection: projection });
  const lookup: AgentPlugin = {
    name: "role-history-wire-lookup",
    tools: () => [{ name: "lookup", description: "Synthetic local lookup", inputSchema: z.object({}), execute: async () => "SYNTHETIC_LOOKUP_RESULT" }],
  };
  const onTurnFinish = vi.fn();
  const channel = new Channel(testScope, root);
  await channel.conversation.init();
  const config = defaultConfig({ basePath: root, modelRetries: 0, logLevel: 0, pacing: { charactersPerSecond: 100, maxTotalDelayMs: 0 } });
  const runtime = new ChannelRuntime(ctx as never, {
    channel,
    bot: bot as never,
    will: { decide: async () => "trigger" as const, observe: () => {} },
    model: model.model,
    historyProjection: model.capabilities.historyProjection,
    contextModelLimit: service.contextLimit(model.model),
    readImagePolicy: { mode: "native" },
    roleProfile,
    imageProjection: projection,
    config: {
      ...config,
      session: {
        ...config.session,
        compact: { ...config.session.compact, mode: "compartment" },
        magicContext: {
          enabled: magic,
          contextWindow: 147200,
          outputReserveTokens: 8192,
          historyBudgetPercentage: 25,
          recentMessages: 20,
          maxLoadedBlocks: 4,
          pageTokenBudget: 4096,
          retainTurns: 2,
        },
      },
    },
    plugins: [...plugins, lookup, { name: "role-history-wire-observer", onTurnFinish }],
  });
  runtimes.push(runtime);
  await runtime.init();
  let inputs = 0;
  const handle = async (message: string) => {
    const result = await runtime.handle(
      defaultMessageRecord({ messageId: `synthetic-real-input-${++inputs}`, timestamp: inputs, elements: [h.text(message)] }),
    );
    if (result.kind === "run") await result.done;
    await runtime.wait();
  };
  return { runtime, channel, bot, roleplay, requests, fetch, handle, onTurnFinish };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(roleplays.splice(0).map((roleplay) => roleplay.stop()));
  await Promise.all(services.splice(0).map((service) => service.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function expectSeeds(request: WireRequest, provider: Provider): void {
  const turns = dialogue(request);
  const value = text(request);
  expect(occurrences(value, seedQuestion)).toBe(1);
  expect(occurrences(value, seedAnswer)).toBe(1);
  expect(occurrences(value, seedOnlyAnswer)).toBe(1);
  expect(turns.find((turn) => body(turn).includes(seedQuestion))?.role).toBe("user");
  expect(turns.find((turn) => body(turn).includes(seedAnswer))?.role).toBe(provider === "google" ? "model" : "assistant");
  expect(turns.find((turn) => body(turn).includes(seedOnlyAnswer))?.role).toBe(provider === "google" ? "model" : "assistant");
  expect(value.indexOf(seedQuestion)).toBeLessThan(value.indexOf(seedAnswer));
  expect(value.indexOf(seedAnswer)).toBeLessThan(value.indexOf(seedOnlyAnswer));
  expect(value.indexOf(seedOnlyAnswer)).toBeLessThan(value.indexOf(currentQuestion));
  expect(systemText(request)).not.toContain(seedQuestion);
  expect(JSON.stringify(request)).not.toMatch(/example_dialogue|style and behavior examples|sourceEntryIds/);
  for (const marker of [seedQuestion, seedAnswer, seedOnlyAnswer]) {
    const seedTurn = turns.find((turn) => body(turn).includes(marker));
    // Actual delivered history is allowed its real timestamps; only seeds must lack proof metadata.
    expect(JSON.stringify(seedTurn)).not.toMatch(/timestamp|delivered_transcript|tool_calls|functionCall|thoughtSignature/);
  }
  expect(turns.some((turn) => turn.role === "system")).toBe(false);
}

describe("optional Roleplay history (actual Core and provider SDKs; stub HTTP only)", () => {
  it.each(matrix.flatMap((entry) => [false, true].map((enabled) => ({ ...entry, enabled }))))(
    "preserves default or emits request-only past dialogue ($provider, Magic=$magic, enabled=$enabled)",
    async ({ provider, magic, enabled }) => {
      const f = await fixture(provider, magic, enabled, [{ name: "finish", args: {} }]);
      await f.handle(currentQuestion);
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.bot.sendMessage).not.toHaveBeenCalled();
      const request = f.requests[0]!;
      if (enabled) expectSeeds(request, provider);
      else {
        expect(systemText(request)).toContain(seedQuestion);
        expect(systemText(request)).toContain("style and behavior examples, not events from the current conversation");
        expect(text(request)).not.toContain(seedQuestion);
      }
      expect(systemText(request)).toContain("SYNTHETIC_CARD_RULE");
      expect(systemText(request)).toContain("SYNTHETIC_POST_RULE");
      expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toMatch(/ROLE_HISTORY_SEED|ROLE_HISTORY_CHARACTER_ONLY|GREETING_MUST_NOT_APPEAR/);
      expect(JSON.stringify(await f.channel.conversation.contextSources())).not.toMatch(/ROLE_HISTORY_SEED|ROLE_HISTORY_CHARACTER_ONLY/);
    },
  );

  it.each(matrix)("keeps seeds and proven real speech on signed tool continuation ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const f = await fixture(provider, magic, true, [send("REAL_DELIVERED_REPLY"), { name: "lookup", args: {}, signature }, send("REAL_FINAL_REPLY")]);
    await f.handle("REAL_FIRST_INPUT");
    await f.handle(currentQuestion);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.bot.sendMessage).toHaveBeenCalledTimes(2);
    for (const request of f.requests.slice(1)) {
      expectSeeds(request, provider);
      expect(occurrences(text(request), "REAL_DELIVERED_REPLY")).toBe(1);
    }
    expect(JSON.stringify(f.requests[2])).toContain("SYNTHETIC_LOOKUP_RESULT");
    if (provider === "google") {
      const call = f.requests[2]!.contents?.flatMap((turn) => turn.parts ?? []).find((part) => part.functionCall?.name === "lookup");
      expect(call?.thoughtSignature).toBe(signature);
    } else {
      expect(f.requests[2]!.messages?.some((turn) => turn.tool_calls?.some((call) => call.function.name === "lookup"))).toBe(true);
    }
    expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toMatch(/ROLE_HISTORY_SEED|ROLE_HISTORY_CHARACTER_ONLY/);
  });

  it.each(matrix)("reinserts one seed batch during intermediate-tool terminal recovery ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const f = await fixture(provider, magic, true, [{ name: "lookup", args: {}, signature }, { text: "UNSENT_INTERNAL_TEXT" }, { name: "finish", args: {} }]);
    await f.handle(currentQuestion);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.bot.sendMessage).not.toHaveBeenCalled();
    expect(f.onTurnFinish).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }), expect.any(Object));
    for (const request of f.requests) expectSeeds(request, provider);
    expect(JSON.stringify(f.requests[2])).toContain("internal repair step");
    expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toMatch(/ROLE_HISTORY_SEED|ROLE_HISTORY_CHARACTER_ONLY|internal repair step/);
  });

  it.each(matrix)("still rejects plain text as a terminal reply ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const f = await fixture(provider, magic, true, [{ text: "UNSENT_INTERNAL_TEXT" }]);
    await f.handle(currentQuestion);
    expect(f.fetch).toHaveBeenCalledOnce();
    expectSeeds(f.requests[0]!, provider);
    expect(f.bot.sendMessage).not.toHaveBeenCalled();
    expect(f.onTurnFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ name: "AgentProtocolError", message: expect.stringContaining("text-only") }),
      }),
      expect.any(Object),
    );
    expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toMatch(/ROLE_HISTORY_SEED|ROLE_HISTORY_CHARACTER_ONLY/);
  });

  it.each(matrix)("supports character-only seeds before any real user turn ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const f = await fixture(provider, magic, true, [{ name: "finish", args: {} }], `<START>\n{{char}}: ${seedOnlyAnswer}`);
    await f.handle(currentQuestion);
    expect(f.fetch).toHaveBeenCalledOnce();
    const request = f.requests[0]!;
    const turns = dialogue(request);
    expect(turns[0]?.role).toBe(provider === "google" ? "model" : "assistant");
    expect(body(turns[0]!)).toBe(seedOnlyAnswer);
    expect(occurrences(text(request), seedOnlyAnswer)).toBe(1);
    expect(text(request).indexOf(seedOnlyAnswer)).toBeLessThan(text(request).indexOf(currentQuestion));
    expect(systemText(request)).not.toContain(seedOnlyAnswer);
    expect(f.onTurnFinish).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }), expect.any(Object));
    expect(f.bot.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toContain(seedOnlyAnswer);
  });

  it.each(matrix)("does not deduplicate real history matching a seed ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const f = await fixture(provider, magic, true, [{ name: "finish", args: {} }]);
    await f.channel.conversation.storage.append(createEntry("message", createUserMessage(seedQuestion), { id: "actual-identical-user-message", timestamp: 1 }));
    await f.handle(currentQuestion);
    expect(occurrences(text(f.requests[0]!), seedQuestion)).toBe(2);
    const original = (await f.channel.conversation.storage.read()).find((entry) => entry.id === "actual-identical-user-message");
    expect(original).toMatchObject({ id: "actual-identical-user-message", data: { role: "user", content: seedQuestion } });
    expect(occurrences(text(f.requests[0]!), seedAnswer)).toBe(1);
  });
});
