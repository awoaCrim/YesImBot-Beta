import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAgent, createMemoryStorage, createUserMessage, EphemeralImageProjectionStore, EphemeralVideoProjectionStore } from "@yesimbot/agent-runtime";
import { wrapLanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";

import { googleVideoInputMiddleware } from "../../providers/model-provider/src/google.js";
vi.mock("koishi", async () => import("@koishijs/core"));
import { createReadTool } from "../src/agents/tools.js";
import { ChannelResources, VIDEO_MAX_BYTES } from "../src/resources/index.js";
import { VIDEO_BYTES, createVideoPolicy, paddedVideo } from "./helpers/video.js";

type Request = { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };

describe("actual Google SDK native-video read continuation", () => {
  it.each([
    { label: "original 9268-byte", videoBytes: VIDEO_BYTES },
    { label: "exact 50 MiB", videoBytes: paddedVideo(VIDEO_MAX_BYTES) },
  ])("projects the exact $label MP4 into the same main user input, never durable/restarted history", async ({ videoBytes }) => {
    const root = await mkdtemp(join(tmpdir(), "video-sdk-"));
    const imageProjection = new EphemeralImageProjectionStore();
    const videoProjection = new EphemeralVideoProjectionStore();
    const resources = new ChannelResources(root, false, 1000, true);
    const uri = "asset://" + (await resources.assets.put(videoBytes));
    const requests: Request[] = [];
    // All HTTP is stubbed locally. There is no real network, model key, QQ content or signature.
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(await new Response(init?.body ?? null).text()));
      const parts =
        requests.length === 1
          ? [{ functionCall: { id: "read-video", name: "read", args: { uri } }, thoughtSignature: "skip_thought_signature_validator" }]
          : [{ text: "local continuation completed" }];
      return new Response(
        "data: " +
          JSON.stringify({
            candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          }) +
          "\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const model = wrapLanguageModel({
      model: createGoogleGenerativeAI({ apiKey: "test", baseURL: "https://fixture.invalid/v1beta", fetch }).chat("gemini-3.8-flash-high"),
      middleware: googleVideoInputMiddleware,
    });
    const storage = createMemoryStorage();
    const read = createReadTool(resources, false, imageProjection, { policy: createVideoPolicy(), projection: videoProjection });
    const agent = createAgent({ model, storage, tools: [read] });
    try {
      const events: string[] = [];
      for await (const event of agent.run(createUserMessage("Inspect the video " + uri))) events.push(event.type);
      await agent.wait();
      expect(events).toContain("turn.done");
      expect(events).not.toContain("turn.failed");
      expect(requests).toHaveLength(2);
      const native = requests[1]!.contents.flatMap((content) => content.parts).filter((part) => "functionResponse" in part);
      expect(native).toHaveLength(1);
      const response = native[0]!.functionResponse as { id: string; name: string; parts?: Array<{ inlineData: { mimeType: string; data: string } }> };
      expect(response).toMatchObject({ id: "read-video", name: "read" });
      expect(response.parts).toBeUndefined();
      const userMedia = requests[1]!.contents
        .filter((content) => content.role === "user")
        .flatMap((content) => content.parts)
        .filter((part) => "inlineData" in part);
      expect(userMedia).toHaveLength(1);
      const media = userMedia[0]!.inlineData as { mimeType: string; data: string };
      expect(media.mimeType).toBe("video/mp4");
      const bytes = Buffer.from(media.data, "base64");
      expect(bytes.byteLength).toBe(videoBytes.length);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(createHash("sha256").update(videoBytes).digest("hex"));
      const userInputs = requests[1]!.contents.filter((content) => content.role === "user");
      expect(userInputs).toHaveLength(2);
      expect(userInputs[0]!.parts).toContainEqual({ text: "Inspect the video " + uri });
      expect(userInputs[0]!.parts).toContainEqual({ inlineData: media });
      const raw = Buffer.from(videoBytes).toString("base64");
      expect(JSON.stringify(await storage.read())).not.toContain(raw);
      expect(JSON.stringify(await storage.read())).not.toContain('"type":"file-data"');
      agent.send(createUserMessage("next turn"));
      await agent.wait();
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests[2])).not.toContain(raw);
      expect(JSON.stringify(requests[2])).toContain("read-video");
      await agent.stop();
      const restarted = createAgent({ model, storage });
      try {
        restarted.send(createUserMessage("after restart"));
        await restarted.wait();
        expect(requests).toHaveLength(4);
        expect(JSON.stringify(requests[3])).not.toContain(raw);
        expect(JSON.stringify(requests[3])).toContain("read-video");
      } finally {
        await restarted.stop();
      }
    } finally {
      await agent.stop();
      imageProjection.clearAll();
      videoProjection.clearAll();
      await rm(root, { recursive: true, force: true });
    }
  });
});
