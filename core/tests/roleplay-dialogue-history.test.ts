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
import { apply as applyGoogle } from "../../providers/model-provider/src/google.js";
import { apply as applyOpenAI } from "../../providers/model-provider/src/openai.js";
import { Agents } from "../src/agents/index.js";
import { Channel, type ChannelContext } from "../src/channels/index.js";
import { ModelService } from "../src/models/index.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import { defaultConfig, defaultMessageRecord, deferred, testScope } from "./helpers/index.js";

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
const reminderHeading = "【本轮角色决策流程；这是运行规则，不是新增聊天内容】";
const reminderMatrix = matrix.flatMap((entry) => [false, true].map((reminder) => ({ ...entry, reminder })));

function expectReminder(request: WireRequest, count = 1): void {
  expect(occurrences(text(request), reminderHeading)).toBe(count);
  expect(systemText(request)).not.toContain(reminderHeading);
  expect(JSON.stringify(request)).not.toContain("sourceEntryIds");
  const ownedTurn = dialogue(request).findLast((turn) => body(turn).includes(reminderHeading));
  expect(ownedTurn?.role).toBe("user");
  const workflow = body(ownedTurn!).slice(body(ownedTurn!).lastIndexOf(reminderHeading));
  expect(workflow.match(/^## .+$/gm)).toEqual([
    "## 1. 确定当前互动",
    "## 2. 确定本轮角色依据",
    "## 3. 确定本轮行为和目的",
    "## 4. 核对事实并处理必要工具",
    "## 5. 组织对外表达",
    "## 6. 发送前检查",
  ]);
}

function body(turn: WireTurn): string {
  if (turn.parts) return turn.parts.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n");
  if (typeof turn.content === "string") return turn.content;
  return turn.content?.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n") ?? "";
}

function dialogue(request: WireRequest): WireTurn[] {
  return (request.contents ?? request.messages ?? []).filter((turn) => turn.role !== "system" && turn.role !== "developer");
}

function systemBlocks(request: WireRequest): string[] {
  return request.systemInstruction?.parts.map((part) => part.text ?? "") ?? request.messages?.filter((turn) => turn.role === "system").map(body) ?? [];
}

function systemText(request: WireRequest): string {
  return systemBlocks(request).join("\n");
}

function expectCorePromptBlocks(request: WireRequest, provider: Provider): void {
  // This runtime fixture keeps defaultConfig.customInnerThought enabled.
  const headings = ["# 运行契约", "# 角色", "# 互动策略", "# 能力与证据边界", "# 内心判断", "# 完整回复编排"];
  const blocks = systemBlocks(request);
  const all = systemText(request);
  const offsets = headings.map((heading) => all.indexOf(heading));
  expect(offsets.every((offset) => offset >= 0)).toBe(true);
  expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  for (const heading of headings) expect(occurrences(all, heading)).toBe(1);
  expect(occurrences(all, "回应不必附带点评")).toBe(0);
  expect(occurrences(all, "同一作者、同一产品的其他动态不等于当前引用的上下文")).toBe(1);
  for (const marker of ["SYNTHETIC_CHARACTER_DEFINITION", "SYNTHETIC_CARD_RULE", "SYNTHETIC_POST_RULE"]) {
    expect(occurrences(all, marker)).toBe(1);
    expect(all.indexOf(marker)).toBeGreaterThan(all.indexOf("# 角色"));
    expect(all.indexOf(marker)).toBeLessThan(all.indexOf("# 互动策略"));
  }
  if (provider === "openai") {
    expect(blocks.slice(0, headings.length).map((block) => block.split("\n")[0])).toEqual(headings);
  } else {
    // Google may aggregate system messages into systemInstruction; content/order must survive.
    expect(request.systemInstruction?.parts.length).toBeGreaterThan(0);
  }
}

function text(request: WireRequest): string {
  return dialogue(request).map(body).join("\n");
}

function expectFocus(request: WireRequest, expected: string): void {
  const matches = [...text(request).matchAll(/\[CURRENT_MESSAGE\]\n?([\s\S]*?)\n?\[\/CURRENT_MESSAGE\]/g)];
  expect(matches.map((match) => match[1]?.trim())).toEqual([expected]);
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

async function fixture(
  provider: Provider,
  magic: boolean,
  enabled: boolean,
  script: Action[],
  examples = exampleText,
  options: { preventSelfStyleImitation?: boolean; direct?: boolean; lookup?: () => Promise<string> } = {},
) {
  const scope: ChannelContext = options.direct ? { type: "direct", platform: "test", channelId: "room-1", selfId: "bot-1", userId: "user-1" } : testScope;
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
  const roleProfile = await agents.resolveRoleProfile(scope);
  const projection = new EphemeralImageProjectionStore();
  let deliveries = 0;
  const bot = { selfId: "bot-1", platform: "test", sendMessage: vi.fn(async () => [`synthetic-platform-${++deliveries}`]) };
  const plugins = await agents.setup(scope, bot as never, { rolePromptsManaged: true, imageProjection: projection });
  const lookup: AgentPlugin = {
    name: "role-history-wire-lookup",
    tools: () => [
      { name: "lookup", description: "Synthetic local lookup", inputSchema: z.object({}), execute: options.lookup ?? (async () => "SYNTHETIC_LOOKUP_RESULT") },
    ],
  };
  const onTurnFinish = vi.fn();
  const channel = new Channel(scope, root);
  await channel.conversation.init();
  const config = defaultConfig({
    basePath: root,
    modelRetries: 0,
    logLevel: 0,
    pacing: { charactersPerSecond: 100, maxTotalDelayMs: 0 },
    ...(options.preventSelfStyleImitation === undefined ? {} : { preventSelfStyleImitation: options.preventSelfStyleImitation }),
  });
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
  const enqueue = (message: string) =>
    runtime.handle(
      defaultMessageRecord({
        messageId: `synthetic-real-input-${++inputs}`,
        timestamp: inputs,
        channel: { id: scope.channelId, type: options.direct ? 1 : 0 },
        elements: [h.text(message)],
      }),
    );
  const handle = async (message: string) => {
    const result = await enqueue(message);
    if (result.kind === "run") await result.done;
    await runtime.wait();
    for (const request of requests) expectCorePromptBlocks(request, provider);
  };
  return { runtime, channel, bot, roleplay, requests, fetch, handle, enqueue, onTurnFinish };
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

describe("mandatory role workflow (actual Core and provider SDKs; stub HTTP only)", () => {
  it.each(matrix.flatMap((entry) => [undefined, false, true].flatMap((setting) => [false, true].map((direct) => ({ ...entry, setting, direct })))))(
    "always includes the complete workflow regardless of the obsolete setting ($provider, Magic=$magic, setting=$setting, direct=$direct)",
    async ({ provider, magic, setting, direct }) => {
      const f = await fixture(provider, magic, true, [{ name: "finish", args: {} }], exampleText, { preventSelfStyleImitation: setting, direct });
      await f.handle(currentQuestion);
      expect(f.fetch).toHaveBeenCalledOnce();
      expectSeeds(f.requests[0]!, provider);
      expectReminder(f.requests[0]!);
      expect(body(dialogue(f.requests[0]!).at(-1)!)).toContain(reminderHeading);
      expect(f.bot.sendMessage).not.toHaveBeenCalled();
      expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toContain(reminderHeading);
      expect(JSON.stringify(await f.channel.conversation.contextSources())).not.toContain(reminderHeading);
    },
  );

  it.each(matrix)("retains genuine historical text identical to the reminder ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const f = await fixture(
      provider,
      magic,
      true,
      [
        { name: "finish", args: {} },
        { name: "finish", args: {} },
      ],
      exampleText,
      { preventSelfStyleImitation: true },
    );
    await f.handle("REAL_FIRST_INPUT");
    const last = body(dialogue(f.requests[0]!).at(-1)!);
    const reminder = last.slice(last.indexOf(reminderHeading));
    await f.channel.conversation.storage.append(createEntry("message", createUserMessage(reminder), { id: "genuine-identical-reminder", timestamp: 1 }));
    await f.handle(currentQuestion);
    expectReminder(f.requests[1]!, 2);
    expect((await f.channel.conversation.storage.read()).find((entry) => entry.id === "genuine-identical-reminder")).toMatchObject({
      data: { content: reminder },
    });
  });

  it.each(matrix)("keeps the complete workflow after a tool failure ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const f = await fixture(
      provider,
      magic,
      false,
      [
        { name: "lookup", args: {}, signature },
        { name: "finish", args: {} },
      ],
      exampleText,
      {
        preventSelfStyleImitation: false,
        lookup: async () => {
          throw new Error("SYNTHETIC_LOOKUP_FAILURE");
        },
      },
    );
    await f.handle(currentQuestion);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    for (const request of f.requests) {
      expectReminder(request);
      expectFocus(request, currentQuestion);
    }
    expect(JSON.stringify(f.requests[1])).toContain("SYNTHETIC_LOOKUP_FAILURE");
    expect(f.bot.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toContain(reminderHeading);
  });

  it.each(matrix)("reinjects one reminder after a direct-channel join ($provider, Magic=$magic)", async ({ provider, magic }) => {
    const entered = deferred();
    const release = deferred();
    const f = await fixture(
      provider,
      magic,
      true,
      [{ name: "lookup", args: {}, signature }, { name: "lookup", args: {}, signature }, send("JOINED_FINAL_REPLY")],
      exampleText,
      {
        preventSelfStyleImitation: true,
        direct: true,
        lookup: async () => {
          entered.resolve();
          await release.promise;
          return "SYNTHETIC_LOOKUP_RESULT";
        },
      },
    );
    const first = await f.enqueue(currentQuestion);
    try {
      await entered.promise;
      await f.enqueue("JOINED_REAL_CURRENT");
      expect(f.requests).toHaveLength(1);
    } finally {
      release.resolve();
    }
    if (first.kind === "run") await first.done;
    await f.runtime.wait();
    expect(f.requests).toHaveLength(3);
    expectFocus(f.requests[0]!, currentQuestion);
    for (const request of f.requests.slice(1)) expectFocus(request, "JOINED_REAL_CURRENT");
    for (const request of f.requests) {
      expectCorePromptBlocks(request, provider);
      expectSeeds(request, provider);
      expectReminder(request);
    }
    expect(text(f.requests[1]!)).toContain("JOINED_REAL_CURRENT");
    expect(JSON.stringify(f.requests[1])).toContain("SYNTHETIC_LOOKUP_RESULT");
    expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toContain(reminderHeading);
  });
});

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

  it.each(reminderMatrix)(
    "keeps focus, seeds and proven speech across two signed tool steps ($provider, Magic=$magic, reminder=$reminder)",
    async ({ provider, magic, reminder }) => {
      const f = await fixture(
        provider,
        magic,
        true,
        [send("REAL_DELIVERED_REPLY"), { name: "lookup", args: {}, signature }, { name: "lookup", args: {}, signature }, send("REAL_FINAL_REPLY")],
        exampleText,
        { preventSelfStyleImitation: reminder },
      );
      await f.handle("REAL_FIRST_INPUT");
      await f.handle(currentQuestion);
      expect(f.fetch).toHaveBeenCalledTimes(4);
      expect(f.bot.sendMessage).toHaveBeenCalledTimes(2);
      for (const request of f.requests.slice(1)) {
        expectFocus(request, currentQuestion);
        expectSeeds(request, provider);
        expect(occurrences(text(request), "REAL_DELIVERED_REPLY")).toBe(1);
      }
      for (const request of f.requests) expectReminder(request);
      expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toContain(reminderHeading);
      expect(JSON.stringify(await f.channel.conversation.contextSources())).not.toContain(reminderHeading);
      const finalRequest = f.requests[3]!;
      expect(JSON.stringify(finalRequest)).toContain("SYNTHETIC_LOOKUP_RESULT");
      if (provider === "google") {
        const calls = finalRequest.contents?.flatMap((turn) => turn.parts ?? []).filter((part) => part.functionCall?.name === "lookup");
        expect(calls).toHaveLength(2);
        expect(calls?.every((call) => call.thoughtSignature === signature)).toBe(true);
      } else {
        expect(finalRequest.messages?.flatMap((turn) => turn.tool_calls ?? []).filter((call) => call.function.name === "lookup")).toHaveLength(2);
      }
      expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toMatch(/ROLE_HISTORY_SEED|ROLE_HISTORY_CHARACTER_ONLY/);
    },
  );

  it.each(reminderMatrix)(
    "reinserts seeds and reminder during intermediate-tool terminal recovery ($provider, Magic=$magic, reminder=$reminder)",
    async ({ provider, magic, reminder }) => {
      const f = await fixture(
        provider,
        magic,
        true,
        [{ name: "lookup", args: {}, signature }, { text: "UNSENT_INTERNAL_TEXT" }, { name: "finish", args: {} }],
        exampleText,
        { preventSelfStyleImitation: reminder },
      );
      await f.handle(currentQuestion);
      expect(f.fetch).toHaveBeenCalledTimes(3);
      expect(f.bot.sendMessage).not.toHaveBeenCalled();
      expect(f.onTurnFinish).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }), expect.any(Object));
      for (const request of f.requests) {
        expectFocus(request, currentQuestion);
        expectSeeds(request, provider);
        expectReminder(request);
      }
      expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toContain(reminderHeading);
      expect(JSON.stringify(f.requests[2])).toContain("internal repair step");
      expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toMatch(/ROLE_HISTORY_SEED|ROLE_HISTORY_CHARACTER_ONLY|internal repair step/);
    },
  );

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
