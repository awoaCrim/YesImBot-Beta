import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@koishijs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("@yesimbot/agent-runtime", async (original) => {
  const actual = await original<typeof import("@yesimbot/agent-runtime")>();
  return {
    ...actual,
    createAgent: vi.fn((options: Parameters<typeof actual.createAgent>[0]) => ({
      init: vi.fn(async () => {}),
      getActiveTurnId: () => "turn",
      interrupt: vi.fn(async () => {}),
      stop: vi.fn(async () => {
        for (const plugin of [...(options.plugins ?? [])].reverse()) await plugin.stop?.();
      }),
    })),
  };
});

import { createAgent } from "@yesimbot/agent-runtime";

import { Agents, type ChannelPluginSetupContext, type ReplyDeliverySetupContext, type ReplyStickerProvider } from "../src/agents/index.js";
import { PolisherRegistry, type MessagePolisherCapability } from "../src/agents/polisher.js";
import { Channels } from "../src/channels/index.js";
import { MessageBatchRegistry } from "../src/message-batches/index.js";
import { Runtimes } from "../src/runtimes/index.js";
import { defaultConfig } from "./helpers/index.js";

const roots: string[] = [];
const owners: Runtimes[] = [];
beforeEach(() => vi.mocked(createAgent).mockClear());
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(capability?: MessagePolisherCapability) {
  const root = await mkdtemp(join(tmpdir(), "yesimbot-reply-registration-"));
  roots.push(root);
  const ctx = new Context();
  const channels = new Channels(ctx, { basePath: root });
  const agents = new Agents(ctx);
  const polishers = new PolisherRegistry();
  const unregister = capability ? polishers.use(capability) : undefined;
  const owner = new Runtimes(
    ctx,
    channels,
    {
      revision: 1,
      resolveChatModel: () => ({ model: {} as never, entry: {} }),
    } as never,
    defaultConfig({ basePath: root, logLevel: 0 }),
    agents,
    new MessageBatchRegistry(),
    polishers,
  );
  owners.push(owner);
  const channel = await channels.resolve({ type: "guild", platform: "test", channelId: "room", guildId: "room" });
  const bot = { platform: "test", selfId: "bot", sendMessage: vi.fn(async () => ["platform-id"]) };
  return { owner, agents, channel, bot, unregister, get: () => owner.get(channel, bot as never) };
}

function provider(): ReplyStickerProvider {
  return {
    revision: 1,
    status: () => "eligible",
    catalog: async () => [],
    view: async () => undefined,
    preflight: vi.fn(async () => ({ error: "fixture_missing_view" })),
  };
}

function selectedAgent() {
  const options = vi.mocked(createAgent).mock.calls.at(-1)?.[0];
  if (!options) throw new Error("no selected agent");
  return options;
}

function requireSeam(context?: ChannelPluginSetupContext): ReplyDeliverySetupContext {
  if (!context?.replyDelivery) throw new Error("missing reply delivery setup");
  return context.replyDelivery;
}

const polish = async () => ["legacy expression"];
const compose = async () => ({ kind: "layout" as const, parts: [{ kind: "text" as const, text: "expression" }] });

describe("actual Runtimes reply registration boundary", () => {
  it.each([
    { name: "A", capability: undefined, ownership: "authored", preparation: false },
    { name: "B", capability: { name: "official", polish, replyLayout: { version: 1, compose } }, ownership: "delegated", preparation: true },
    { name: "unsupported B", capability: { name: "future", polish, replyLayout: { version: 99, compose } }, ownership: "delegated", preparation: true },
    { name: "legacy rewrite", capability: { name: "third-party", mode: "rewrite" as const, polish }, ownership: undefined, preparation: false },
    { name: "legacy compose", capability: { name: "third-party", mode: "compose" as const, polish }, ownership: undefined, preparation: false },
  ])("selects $name before plugin setup without inferring mixed support", async ({ capability, ownership, preparation }) => {
    const f = await fixture(capability);
    let setupContext: ChannelPluginSetupContext | undefined;
    f.agents.use({
      setup: (_channel, _bot, context) => {
        setupContext = context;
        return { name: "selection-fixture" };
      },
    });
    await f.get();
    expect(setupContext?.replyDelivery?.ownership).toBe(ownership);
    expect(setupContext?.polisherActive).toBe(capability !== undefined);
    expect(selectedAgent().tools?.some((tool) => tool.name === "prepare_reply")).toBe(preparation);
    expect(selectedAgent().tools?.filter((tool) => tool.name === "send_message")).toHaveLength(1);
  });

  it("freezes registration after setup and disposal invalidates an already-created sender", async () => {
    const f = await fixture();
    let seam!: ReplyDeliverySetupContext;
    let unregister!: () => void;
    f.agents.use({
      setup: (_channel, _bot, context) => {
        seam = requireSeam(context);
        unregister = seam.registerSticker(provider());
        return { name: "sticker-fixture", stop: unregister };
      },
    });
    await f.get();
    expect(() => seam.registerSticker(provider())).toThrow("frozen or already registered");
    const send = selectedAgent().tools?.find((tool) => tool.name === "send_message");
    if (!send) throw new Error("missing sender");
    unregister();
    unregister();
    const result = await send.execute({ parts: [{ kind: "text", text: "must not send after disposal" }] }, {
      turnId: "turn",
      toolCallId: "send",
      messages: [],
    } as never);
    expect(result).toMatchObject({ ok: false, replyReceipt: { failureStage: "preflight", completeUnits: [] } });
    expect(f.bot.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["duplicate", "setup-failure"] as const)("retires prior plugins and the captured registration seam on %s", async (failure) => {
    const f = await fixture();
    let seam!: ReplyDeliverySetupContext;
    const stop = vi.fn();
    f.agents.use({
      setup: (_channel, _bot, context) => {
        seam = requireSeam(context);
        const unregister = seam.registerSticker(provider());
        return {
          name: "first",
          stop: () => {
            unregister();
            stop();
          },
        };
      },
    });
    f.agents.use({
      setup: (_channel, _bot, context) => {
        if (failure === "duplicate") requireSeam(context).registerSticker(provider());
        throw new Error("fixture_setup_failure");
      },
    });
    await expect(f.get()).rejects.toThrow(failure === "duplicate" ? "frozen or already registered" : "fixture_setup_failure");
    expect(stop).toHaveBeenCalledOnce();
    expect(createAgent).not.toHaveBeenCalled();
    expect(() => seam.registerSticker(provider())).toThrow("frozen or already registered");
    expect(f.bot.sendMessage).not.toHaveBeenCalled();
  });

  it("a disposer from a replaced runtime cannot retire the new provider generation", async () => {
    const f = await fixture();
    const disposers: Array<() => void> = [];
    f.agents.use({
      setup: (_channel, _bot, context) => {
        const unregister = requireSeam(context).registerSticker(provider());
        disposers.push(unregister);
        return { name: "sticker", stop: unregister };
      },
    });
    const first = await f.get();
    // An ordinary registration revision causes Core to retire/rebuild its channel runtime.
    f.agents.use({ setup: () => ({ name: "new-registration" }) });
    const second = await f.get();
    expect(second).not.toBe(first);
    expect(disposers).toHaveLength(2);
    disposers[0]!();
    const send = selectedAgent().tools?.find((tool) => tool.name === "send_message");
    if (!send) throw new Error("missing sender");
    expect(
      await send.execute({ parts: [{ kind: "text", text: "new generation" }] }, { turnId: "turn", toolCallId: "send", messages: [] } as never),
    ).toMatchObject({ ok: true });
    expect(f.bot.sendMessage).toHaveBeenCalledOnce();
  });
});
