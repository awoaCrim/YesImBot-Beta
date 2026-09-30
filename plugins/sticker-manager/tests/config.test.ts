import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { StickerConfigSchema } from "../src/config.js";

describe("StickerConfigSchema", () => {
  it("keeps stealing enabled by default and preserves an explicit opt-out", () => {
    expect(StickerConfigSchema({} as never).enableSteal).toBe(true);
    expect(StickerConfigSchema({ enableSteal: false } as never).enableSteal).toBe(false);
  });
});
