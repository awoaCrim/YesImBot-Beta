import { createAssistantMessage, createToolMessage, type AgentMessage, type AgentTool } from "@yesimbot/agent-runtime";
import type { Element } from "koishi";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));
vi.mock("../src/agents/tools.js", async (original) => ({ ...(await original<object>()), pacedDelay: () => 0 }));
import { createReplyTools, type ReplyToolsOptions } from "../src/agents/reply-tools.js";
import type { ReplyLayoutComposeRequest, ReplyLayoutDraft, ReplyStickerView } from "../src/agents/reply.js";
import { beginReplyJournal } from "../src/conversations/reply-journal.js";
import { decodeReplyReceipt } from "../src/conversations/reply-receipt.js";
import { PNG_BYTES } from "./helpers/index.js";

const layout: ReplyLayoutDraft = { kind: "layout", parts: [{ kind: "text", text: "short reply" }] };
const initial = { facts: [], intent: "acknowledge" };
function pair(name: string, id: string, input: unknown, value: unknown): AgentMessage[] {
  return [
    createAssistantMessage([{ type: "tool-call", toolName: name, toolCallId: id, input }]),
    createToolMessage([{ type: "tool-result", toolName: name, toolCallId: id, output: { type: "text", value: JSON.stringify(value) } }]),
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function invoke(tool: AgentTool, input: unknown, id: string, messages: AgentMessage[] = [], extras: object = {}): Promise<Record<string, unknown>> {
  return tool.execute(input, { turnId: "turn", toolCallId: id, messages, ...extras } as never);
}

function fixture(overrides: Partial<ReplyToolsOptions> = {}) {
  const compose = vi.fn(async (_request: ReplyLayoutComposeRequest): Promise<ReplyLayoutDraft | undefined> => layout);
  const sendMessage = vi.fn(async (_channel: string, _elements: readonly Element[]) => ["platform-id"]);
  const options: ReplyToolsOptions = {
    bot: { platform: "onebot", sendMessage } as never,
    channelId: "42",
    resources: {} as never,
    pacing: { charactersPerSecond: 100, maxTotalDelayMs: 0 },
    journal: {
      begin: (input) => beginReplyJournal({ ...input, sink: { append: async () => {} }, sessionId: "session", generation: 1, invocationId: "invocation" }),
    },
    delegated: true,
    composer: { name: "official", version: 1, compose },
    innerThought: true,
    resolveProfile: async () => ({ persona: "FULL ROLE", roleInstructions: "CARD INSTRUCTIONS", characterDefinition: "CARD DEFINITION" }),
    turnContext: () => [],
    ...overrides,
  };
  const set = createReplyTools(options);
  const prepare = set.tools.find((tool) => tool.name === "prepare_reply")!;
  const send = set.tools.find((tool) => tool.name === "send_message")!;
  return { ...set, prepare, send, compose, sendMessage, options };
}

function viewed(mode: "native" | "description" = "description") {
  const view: ReplyStickerView = {
    stickerId: "s",
    contentHash: "a".repeat(64),
    mediaType: "image/png",
    mode,
    ...(mode === "native"
      ? { frames: [{ bytes: PNG_BYTES, mediaType: "image/png", label: "exact frame" }] }
      : { description: "actual configured visual description" }),
  };
  let current = true;
  let present = true;
  let status: "eligible" | "reserved" | "consumed" = "eligible";
  const provider = {
    revision: 1,
    status: () => status,
    catalog: async () => [{ category: "reaction", count: 2 }],
    view: vi.fn(async () => (present ? view : undefined)),
    isViewCurrent: (candidate: ReplyStickerView) => candidate === view && current,
    preflight: vi.fn(async () => ({
      lease: {
        stickerId: "s",
        contentHash: view.contentHash,
        send: vi.fn(async () => ({ status: "confirmed" as const, messageIds: ["sticker-id"], contentHash: view.contentHash })),
        release: vi.fn(),
      },
    })),
  };
  return {
    view,
    provider,
    stale: () => {
      current = false;
    },
    show: (value: boolean) => {
      present = value;
    },
    consume: () => {
      status = "consumed";
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("modern A/B ownership and one-shot readiness", () => {
  it("A has no mandatory expression call and accepts only parts", async () => {
    const f = fixture({ delegated: false });
    expect(f.tools.map((tool) => tool.name)).toEqual(["send_message"]);
    const result = await invoke(f.send, { parts: [{ kind: "text", text: "main authored" }] }, "send");
    expect(result.ok).toBe(true);
    expect(f.compose).not.toHaveBeenCalled();
    expect((await invoke(f.send, { messages: ["legacy draft"] }, "bypass")).ok).toBe(false);
  });
  it("a declared B with missing composer fails closed, never exposing A or draft fields", async () => {
    const f = fixture({ composer: undefined });
    expect(f.tools.map((tool) => tool.name)).toEqual(["prepare_reply", "send_message"]);
    expect((await invoke(f.prepare, initial, "prepare")).ok).toBe(false);
    const rejected = await invoke(f.send, { parts: [{ kind: "text", text: "main draft" }] }, "send");
    expect(decodeReplyReceipt(rejected.replyReceipt)).toMatchObject({ completeUnits: [], failureStage: "preflight" });
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it("passes full live profile, no private thought; ready result contains no generated role text", async () => {
    const f = fixture();
    const result = await invoke(f.prepare, { ...initial, inner_thought: "PRIVATE", continue: true }, "prepare");
    expect(result).toMatchObject({ ok: true, status: "ready", units: 1 });
    expect(JSON.stringify(result)).not.toContain("short reply");
    expect(f.compose.mock.calls[0]![0].profile).toEqual({
      persona: "FULL ROLE",
      roleInstructions: "CARD INSTRUCTIONS",
      characterDefinition: "CARD DEFINITION",
    });
    expect(JSON.stringify(f.compose.mock.calls)).not.toContain("PRIVATE");
    const messages = pair("prepare_reply", "prepare", { ...initial, continue: true }, result);
    const sent = await invoke(f.send, { reply_id: result.reply_id, continue: true }, "send", messages);
    expect(sent.ok).toBe(true);
    expect((await invoke(f.send, { reply_id: result.reply_id, continue: true }, "replay", messages)).ok).toBe(false);
    expect(f.sendMessage).toHaveBeenCalledOnce();
  });
  it("same-step/guessed/cross-turn readiness cannot deliver", async () => {
    const f = fixture();
    const result = await invoke(f.prepare, initial, "prepare");
    expect((await invoke(f.send, { reply_id: result.reply_id }, "same-step")).ok).toBe(false);
    const messages = pair("prepare_reply", "prepare", initial, result);
    expect((await invoke(f.send, { reply_id: "guessed" }, "guess", messages)).ok).toBe(false);
    expect((await invoke(f.send, { reply_id: result.reply_id }, "cross-turn", messages, { turnId: "other" })).ok).toBe(false);
    expect((await invoke(f.send, { reply_id: result.reply_id }, "correct", messages)).ok).toBe(true);
  });
  it.each(["reversed", "duplicate-call", "duplicate-result", "changed-receipt"])("rejects invalid completed readiness %s", async (kind) => {
    const f = fixture();
    const ready = await invoke(f.prepare, initial, "prepare");
    let messages = pair("prepare_reply", "prepare", initial, kind === "changed-receipt" ? { ...ready, reply_id: "different" } : ready);
    if (kind === "reversed") messages = messages.reverse();
    if (kind === "duplicate-call") messages.push(messages[0]!);
    if (kind === "duplicate-result") messages.push(messages[1]!);
    const result = await invoke(f.send, { reply_id: ready.reply_id }, "send", messages);
    expect(result.ok).toBe(false);
    expect(decodeReplyReceipt(result.replyReceipt)).toBeDefined();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it("continue mismatch consumes the admitted ID and does not send", async () => {
    const f = fixture();
    const ready = await invoke(f.prepare, { ...initial, continue: true }, "prepare");
    const messages = pair("prepare_reply", "prepare", initial, ready);
    expect((await invoke(f.send, { reply_id: ready.reply_id }, "send", messages)).error).toMatchObject({ name: "ContinueMismatch" });
    expect((await invoke(f.send, { reply_id: ready.reply_id, continue: true }, "replay", messages)).ok).toBe(false);
  });
  it.each([{ intent: "missing facts" }, { ...initial, messages: ["draft"] }, { ...initial, continue: "true" }, { ...initial, preparation_id: "also resume" }])(
    "initial input is strict %j",
    async (input) => {
      const f = fixture();
      expect((await invoke(f.prepare, input, "prepare")).ok).toBe(false);
      expect(f.compose).not.toHaveBeenCalled();
    },
  );
});

describe("bounded immutable preview/resume protocol", () => {
  async function requested() {
    const visual = viewed();
    visual.show(false);
    const f = fixture({ sticker: visual.provider, previewAvailable: true });
    f.compose.mockResolvedValueOnce({ kind: "preview", selector: { category: "reaction" } });
    const result = await invoke(f.prepare, initial, "prepare");
    expect(result.status).toBe("preview_required");
    const messages = pair("prepare_reply", "prepare", initial, result);
    return { f, visual, result, messages };
  }
  it("successful exact prior-step view resumes once and supplies actual description", async () => {
    const { f, visual, result, messages } = await requested();
    visual.show(true);
    messages.push(...pair("sticker_preview", "preview", { category: "reaction" }, { ok: true, previewed: true, id: "s" }));
    const ready = await invoke(f.prepare, { preparation_id: result.preparation_id }, "resume", messages);
    expect(ready.status).toBe("ready");
    expect(f.compose.mock.calls[1]![0]).toMatchObject({
      stage: 2,
      facts: [],
      intent: "acknowledge",
      sticker: { view: { description: "actual configured visual description" } },
    });
    expect((await invoke(f.prepare, { preparation_id: result.preparation_id }, "repeat", messages)).ok).toBe(false);
  });
  it("actual matching failed preview can finish text-only", async () => {
    const { f, result, messages } = await requested();
    messages.push(...pair("sticker_preview", "preview", { category: "reaction" }, { ok: false, error: "image_input_unavailable" }));
    expect((await invoke(f.prepare, { preparation_id: result.preparation_id }, "resume", messages)).status).toBe("ready");
    expect(f.compose.mock.calls[1]![0]).toMatchObject({ stage: 2, previous: { error: "image_input_unavailable" }, sticker: { status: "eligible" } });
    expect(f.compose.mock.calls[1]![0].sticker.view).toBeUndefined();
  });
  it.each(["same-step", "wrong-selector", "echo-forgery", "two-previews", "extra-selector-field", "preview-before-preparation"])(
    "rejects %s before another expression pass",
    async (kind) => {
      const { f, result, messages } = await requested();
      const preview = pair(
        "sticker_preview",
        "preview",
        kind === "wrong-selector" ? { category: "other" } : kind === "extra-selector-field" ? { category: "reaction", index: 1 } : { category: "reaction" },
        { ok: true, previewed: true, requested: { category: "reaction" }, id: "s" },
      );
      if (kind === "same-step") messages.push(preview[0]!);
      else if (kind === "echo-forgery") messages.push(preview[1]!);
      else if (kind === "preview-before-preparation") messages.unshift(...preview);
      else messages.push(...preview);
      if (kind === "two-previews") messages.push(...pair("sticker_preview", "other-preview", { category: "reaction" }, { ok: false, error: "missing" }));
      expect((await invoke(f.prepare, { preparation_id: result.preparation_id }, "resume", messages)).ok).toBe(false);
      expect(f.compose).toHaveBeenCalledOnce();
    },
  );
  it("resume cannot replace immutable facts/control", async () => {
    const { f, result, messages } = await requested();
    expect((await invoke(f.prepare, { preparation_id: result.preparation_id, ...initial, continue: true }, "resume", messages)).ok).toBe(false);
    expect(f.compose).toHaveBeenCalledOnce();
  });
  it("no route, no catalog match, or an existing actual view forbids preview requests", async () => {
    for (const variation of ["no-route", "wrong-category", "already-viewed"]) {
      const visual = viewed();
      if (variation !== "already-viewed") visual.show(false);
      const f = fixture({ sticker: visual.provider, previewAvailable: variation !== "no-route" });
      f.compose.mockResolvedValue({ kind: "preview", selector: { category: variation === "wrong-category" ? "invented" : "reaction" } });
      expect((await invoke(f.prepare, initial, "prepare")).ok).toBe(false);
    }
  });
  it("at most two expression passes, never a second preview", async () => {
    const { f, result, messages } = await requested();
    messages.push(...pair("sticker_preview", "preview", { category: "reaction" }, { ok: false, error: "unavailable" }));
    f.compose.mockResolvedValueOnce({ kind: "preview", selector: { category: "reaction" } });
    expect((await invoke(f.prepare, { preparation_id: result.preparation_id }, "resume", messages)).ok).toBe(false);
    expect(f.compose).toHaveBeenCalledTimes(2);
  });
});

describe("visual handoff, cancellation and lifecycle", () => {
  it("uses verified native frames only for an image-capable expression model", async () => {
    const visual = viewed("native");
    const f = fixture({
      sticker: visual.provider,
      composer: {
        name: "official",
        version: 1,
        imageInput: true,
        compose: vi.fn(async (request) => {
          expect(request.sticker.view).toBe(visual.view);
          expect(request.sticker.view?.frames?.[0]?.bytes).toBe(PNG_BYTES);
          return layout;
        }),
      },
    });
    expect((await invoke(f.prepare, initial, "prepare")).status).toBe("ready");
  });
  it("text-only expression uses only configured exact-frame descriptor; failed description stays text-only", async () => {
    for (const description of ["exact configured vision description", undefined]) {
      const visual = viewed("native");
      const describeFrames = vi.fn(async (_view: ReplyStickerView) => description);
      const f = fixture({ sticker: visual.provider, describeFrames });
      expect((await invoke(f.prepare, initial, "prepare")).status).toBe("ready");
      expect(describeFrames.mock.calls[0]![0]).toBe(visual.view);
      expect(f.compose.mock.calls[0]![0].sticker.view).toEqual(
        description ? { ...visual.view, mode: "description", frames: undefined, description } : undefined,
      );
    }
  });
  it("consumed quota suppresses stale view/catalog and still allows later text-only phase", async () => {
    const visual = viewed();
    visual.consume();
    const f = fixture({ sticker: visual.provider, previewAvailable: true });
    const ready = await invoke(f.prepare, initial, "prepare");
    expect(ready.status).toBe("ready");
    expect(f.compose.mock.calls[0]![0].sticker).toMatchObject({ status: "consumed", consumed: true, catalog: [], previewAvailable: false });
    expect(visual.provider.view).not.toHaveBeenCalled();
  });
  it("exact candidate generation change after await retires the draft rather than repairing it", async () => {
    const visual = viewed();
    const pending = deferred<ReplyLayoutDraft>();
    const f = fixture({ sticker: visual.provider });
    f.compose.mockImplementation(async () => pending.promise);
    const preparing = invoke(f.prepare, initial, "prepare");
    await vi.waitFor(() => expect(f.compose).toHaveBeenCalledOnce());
    visual.stale();
    pending.resolve(layout);
    expect((await preparing).ok).toBe(false);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it("overlap is rejected and ignored late completion cannot restore an invalidated generation", async () => {
    const pending = deferred<ReplyLayoutDraft>();
    const f = fixture();
    f.compose.mockImplementation(async () => pending.promise);
    const preparing = invoke(f.prepare, initial, "prepare");
    expect((await invoke(f.prepare, initial, "overlap")).error).toBe("preparation_pending");
    f.invalidate();
    pending.resolve(layout);
    expect((await preparing).ok).toBe(false);
    expect(f.phases.current()).toBeUndefined();
  });
  it("whole 60s deadline includes a profile resolver that ignores abort", async () => {
    vi.useFakeTimers();
    const f = fixture({ resolveProfile: () => new Promise(() => {}) });
    const preparing = invoke(f.prepare, initial, "prepare");
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await preparing).ok).toBe(false);
    expect(f.compose).not.toHaveBeenCalled();
    expect(f.phases.current()).toBeUndefined();
  });
  it("finish aborts pending preparation and no old-turn output is possible", async () => {
    const f = fixture({ resolveProfile: () => new Promise(() => {}) });
    const preparing = invoke(f.prepare, initial, "prepare");
    await f.finishTurn("turn");
    expect((await preparing).ok).toBe(false);
    expect((await invoke(f.prepare, initial, "old-turn")).ok).toBe(false);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it("claimed phase remains exclusive during pending transport", async () => {
    const pending = deferred<string[]>();
    const f = fixture();
    f.sendMessage.mockImplementation(async () => pending.promise);
    const ready = await invoke(f.prepare, initial, "prepare");
    const sending = invoke(f.send, { reply_id: ready.reply_id }, "send", pair("prepare_reply", "prepare", initial, ready));
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledOnce());
    expect((await invoke(f.prepare, initial, "concurrent")).error).toBe("preparation_pending");
    pending.resolve(["id"]);
    expect((await sending).ok).toBe(true);
    expect((await invoke(f.prepare, initial, "later-phase")).ok).toBe(true);
  });
  it("rejects facts anchors erased by element parsing before the phase's first output", async () => {
    const f = fixture();
    const fact = "<inner_thought>12</inner_thought>";
    f.compose.mockResolvedValue({
      kind: "layout",
      parts: [
        { kind: "text", text: "before" },
        { kind: "text", text: `${fact}完成` },
      ],
    });
    const input = { facts: [fact], intent: "answer" };
    const ready = await invoke(f.prepare, input, "prepare");
    expect(ready.status).toBe("ready"); // Original protected anchors match; public preflight must still run.
    const sent = await invoke(f.send, { reply_id: ready.reply_id }, "send", pair("prepare_reply", "prepare", input, ready));
    expect(sent).toMatchObject({ ok: false, error: { name: "ReplyAnchorsErased" }, replyReceipt: { failureStage: "preflight", completeUnits: [] } });
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it("allows the same facts anchors to remain literal in raw delivery", async () => {
    const f = fixture();
    const fact = "<inner_thought>12</inner_thought>";
    f.compose.mockResolvedValue({ kind: "layout", parts: [{ kind: "text", text: `${fact}完成` }] });
    const input = { facts: [fact], intent: "quote literally", mode: "raw" };
    const ready = await invoke(f.prepare, input, "prepare");
    const sent = await invoke(f.send, { reply_id: ready.reply_id }, "send", pair("prepare_reply", "prepare", input, ready));
    expect(sent.ok).toBe(true);
    expect(f.sendMessage.mock.calls[0]![1][0]!.attrs.content).toBe(`${fact}完成`);
  });
  it.each(["unknown-kind", "extra-field", "wrong-sticker", "split-verbatim", "anchors"])("invalid expression %s sends nothing", async (kind) => {
    const visual = viewed();
    const f = fixture({ sticker: visual.provider });
    const raw =
      kind === "unknown-kind"
        ? { kind: "anything", parts: [] }
        : kind === "extra-field"
          ? { ...layout, continue: true }
          : kind === "wrong-sticker"
            ? { kind: "layout", parts: [{ kind: "sticker", stickerId: "unviewed" }] }
            : kind === "split-verbatim"
              ? {
                  kind: "layout",
                  parts: [
                    { kind: "text", text: "echo" },
                    { kind: "text", text: "hello" },
                  ],
                }
              : layout;
    f.compose.mockResolvedValue(raw as ReplyLayoutDraft);
    const input = kind === "split-verbatim" ? { ...initial, verbatim: ["echo hello"] } : kind === "anchors" ? { ...initial, facts: ["must keep 42"] } : initial;
    expect((await invoke(f.prepare, input, "prepare")).ok).toBe(false);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
});
