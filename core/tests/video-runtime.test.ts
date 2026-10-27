import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { Context } from "@koishijs/core";
import { EphemeralVideoProjectionStore } from "@yesimbot/agent-runtime";
import { wrapLanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { googleVideoInputMiddleware } from "../../providers/model-provider/src/google.js";
vi.mock("koishi", async () => import("@koishijs/core"));
import { Channel } from "../src/channels/index.js";
import { ChannelRuntime } from "../src/runtimes/channel.js";
import { defaultConfig, defaultMessageRecord } from "./helpers/index.js";
import { VIDEO_BYTES } from "./helpers/video.js";

type Request = { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };

type Call = { id: string; name: string; args: Record<string, unknown> };

const roots: string[] = [];
const runtimes: ChannelRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function fixture(mode: "native" | "unavailable" = "native", enabled = true) {
  const root = await mkdtemp(join(tmpdir(), "video-runtime-"));
  roots.push(root);
  const channel = new Channel({ type: "guild", platform: "test", channelId: "room", guildId: "room" }, root, false, 1000, undefined, undefined, false, enabled);
  await channel.conversation.init();
  const uri = "asset://" + (await channel.resources.assets.put(VIDEO_BYTES));
  const calls: Call[] = [];
  const requests: Request[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    requests.push(JSON.parse(await new Response(init?.body ?? null).text()));
    const call = calls.shift();
    if (!call) throw new Error("Unexpected local SDK request");
    return new Response(
      "data: " +
        JSON.stringify({
          candidates: [
            { content: { role: "model", parts: [{ functionCall: call, thoughtSignature: "skip_thought_signature_validator" }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }) +
        "\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const model = wrapLanguageModel({
    model: createGoogleGenerativeAI({ apiKey: "test", baseURL: "https://fixture.invalid/v1beta", fetch }).chat("gemini-3.8-flash-high"),
    middleware: googleVideoInputMiddleware,
  });
  const projection = new EphemeralVideoProjectionStore();
  const runtime = new ChannelRuntime(new Context(), {
    channel,
    bot: { selfId: "bot", platform: "test", sendMessage: vi.fn() } as never,
    will: { decide: async () => "trigger", decideBatch: async () => ({ decision: "trigger" }), observe: () => {} } as never,
    model,
    readImagePolicy: { mode: "unavailable" },
    readVideoPolicy: { mode },
    videoProjection: projection,
    config: defaultConfig({ basePath: root, modelRetries: 0, videoInput: enabled }),
    plugins: [],
  });
  runtimes.push(runtime);
  await runtime.init();
  let sequence = 0;
  const handle = async () => {
    const outcome = await runtime.handle(defaultMessageRecord({ messageId: "input-" + sequence++, channel: { id: "room", type: 0 } }));
    if (outcome.kind === "run") await outcome.done;
    await runtime.wait();
  };
  const read = (id: string): Call => ({ id, name: "read", args: { uri } });
  const finish = (): Call => ({ id: "finish", name: "finish", args: {} });
  return { runtime, channel, uri, projection, requests, fetch, calls, handle, read, finish };
}

function responses(request: Request) {
  return request.contents
    .flatMap((content) => content.parts)
    .filter((part) => "functionResponse" in part)
    .map((part) => part.functionResponse as { id: string; response: unknown; parts?: Array<{ inlineData: { data: string; mimeType: string } }> });
}

function nativeResponse(request: Request, id: string) {
  const response = responses(request).find((part) => part.id === id);
  expect(response).toBeDefined();
  expect(response?.parts).toBeUndefined();
  const media = request.contents
    .filter((content) => content.role === "user")
    .flatMap((content) => content.parts)
    .filter((part) => "inlineData" in part);
  expect(media).toHaveLength(1);
  const video = media[0]!.inlineData as { mimeType: string; data: string };
  expect(video.mimeType).toBe("video/mp4");
  expect(createHash("sha256").update(Buffer.from(video.data, "base64")).digest("hex")).toBe(createHash("sha256").update(VIDEO_BYTES).digest("hex"));
}

describe("actual ChannelRuntime native video admission and lifecycle", () => {
  it("limits native video to one per real turn, clears matching payloads, and permits a fresh next turn", async () => {
    const f = await fixture();
    const clear = vi.spyOn(f.projection, "clearTurn");
    f.calls.push(f.read("first"), f.read("second"), f.finish());
    await f.handle();
    expect(f.requests).toHaveLength(3);
    nativeResponse(f.requests[1]!, "first");
    const denied = responses(f.requests[2]!).find((part) => part.id === "second");
    expect(denied?.parts).toBeUndefined();
    expect(JSON.stringify(denied?.response)).toContain("video_turn_limit");
    expect(clear).toHaveBeenCalledOnce();
    expect(f.projection.has("first")).toBe(false);
    const durable = JSON.stringify(await f.channel.conversation.storage.read());
    expect(durable).not.toContain(Buffer.from(VIDEO_BYTES).toString("base64"));
    expect(durable).toContain("first");
    f.calls.push(f.read("first"), f.finish());
    await f.handle();
    expect(f.requests).toHaveLength(5);
    expect(JSON.stringify(f.requests[3])).not.toContain(Buffer.from(VIDEO_BYTES).toString("base64"));
    nativeResponse(f.requests[4]!, "first");
    expect(clear).toHaveBeenCalledTimes(2);
    expect(clear.mock.calls[0]![0]).not.toBe(clear.mock.calls[1]![0]);
    await f.runtime.stop();
    expect(f.projection.has("first")).toBe(false);
  });

  it.each([
    ["unavailable", true],
    ["native", false],
  ] as const)("fails closed for runtime mode %s and video input %s", async (mode, enabled) => {
    const f = await fixture(mode, enabled);
    const stage = vi.spyOn(f.projection, "stage");
    f.calls.push(f.read("blocked"), f.finish());
    await f.handle();
    expect(f.requests).toHaveLength(2);
    expect(JSON.stringify(f.requests[1])).toContain("video_input_unavailable");
    expect(JSON.stringify(f.requests)).not.toContain(Buffer.from(VIDEO_BYTES).toString("base64"));
    expect(stage).not.toHaveBeenCalled();
  });

  it("stop rejects a late asset read even if the store ignores cancellation", async () => {
    const f = await fixture();
    let resolve!: (bytes: Uint8Array) => void;
    const get = vi.spyOn(f.channel.resources.assets, "get").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const stage = vi.spyOn(f.projection, "stage");
    f.calls.push(f.read("late"));
    const run = f.handle();
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
    await f.runtime.stop();
    await run;
    resolve(VIDEO_BYTES);
    await Promise.resolve();
    expect(f.requests).toHaveLength(1);
    expect(stage).not.toHaveBeenCalled();
    expect(f.projection.has("late")).toBe(false);
    expect(JSON.stringify(await f.channel.conversation.storage.read())).not.toContain(Buffer.from(VIDEO_BYTES).toString("base64"));
  });
});
