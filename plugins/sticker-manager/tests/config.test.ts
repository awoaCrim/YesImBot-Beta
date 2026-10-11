import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { StickerConfigSchema } from "../src/config.js";

describe("StickerConfigSchema", () => {
  it("defaults management off independently of collection and tags", () => {
    expect(StickerConfigSchema({} as never).enableManage).toBe(false);
    expect(StickerConfigSchema({ enableManage: true, enableSteal: false } as never).enableManage).toBe(true);
    expect(StickerConfigSchema({ enableManage: false, tagMode: true } as never).enableManage).toBe(false);
  });
  it("keeps stealing enabled by default and preserves an explicit opt-out", () => {
    expect(StickerConfigSchema({} as never).enableSteal).toBe(true);
    expect(StickerConfigSchema({ enableSteal: false } as never).enableSteal).toBe(false);
  });
});
