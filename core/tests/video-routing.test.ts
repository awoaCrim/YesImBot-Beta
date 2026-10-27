import { describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));
import { resolveReadVideoPolicy } from "../src/runtimes/index.js";

const primary = (video: boolean, transport: "native" | "unsupported" | "unknown" | undefined) =>
  ({
    fullId: "fixture:gemini-3.8-flash-high",
    entry: { modalities: { input: video ? ["text", "image", "video"] : ["text", "image"] } },
    capabilities: { imageToolResult: "native", videoInput: transport },
    model: { id: "main" },
  }) as never;

describe("native video main-route admission", () => {
  it("uses one Core flag with primary video modality and adapter-declared native input", () => {
    expect(resolveReadVideoPolicy(primary(true, "native"), true)).toMatchObject({ mode: "native" });
    expect(resolveReadVideoPolicy(primary(true, "native"), false)).toMatchObject({ mode: "unavailable" });
    expect(resolveReadVideoPolicy(primary(false, "native"), true)).toMatchObject({ mode: "unavailable" });
    for (const transport of [undefined, "unknown", "unsupported"] as const)
      expect(resolveReadVideoPolicy(primary(true, transport), true)).toMatchObject({ mode: "unavailable" });
  });
  it("does not infer video from a Gemini-looking model name or an image-native provider", () => {
    expect(resolveReadVideoPolicy(primary(false, undefined), true)).toMatchObject({ mode: "unavailable" });
  });
});
