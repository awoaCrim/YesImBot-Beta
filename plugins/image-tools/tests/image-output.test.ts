import { describe, expect, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { detectImageMediaType, RESOURCE_MAX_BYTES } from "../../../core/src/resources/index.js";
import { validateImageBytes } from "../src/image-output.js";
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES, png } from "./helpers.js";

const resources = { maxBytes: RESOURCE_MAX_BYTES, detectImageMediaType, artifacts: {} as never };

describe("actual image dimensions", () => {
  it.each([
    [PNG_BYTES, "image/png", 1, 1, "square"],
    [png(2, 3), "image/png", 2, 3, "portrait"],
    [JPEG_BYTES, "image/jpeg", 3, 2, "landscape"],
    [WEBP_BYTES, "image/webp", 3, 2, "landscape"],
  ] as const)("measures supported pixels as %s / %s / %s x %s / %s", (bytes, mediaType, width, height, orientation) => {
    expect(validateImageBytes(bytes, resources)).toMatchObject({ mediaType, width, height, orientation });
  });

  it("rejects signature-only and invalid dimension headers", () => {
    expect(validateImageBytes(PNG_BYTES.subarray(0, 8), resources)).toEqual({ error: "invalid_image" });
    const zero = new Uint8Array(PNG_BYTES);
    new DataView(zero.buffer).setUint32(16, 0);
    expect(validateImageBytes(zero, resources)).toEqual({ error: "invalid_image" });
    const huge = new Uint8Array(PNG_BYTES);
    new DataView(huge.buffer).setUint32(16, 40_000_001);
    expect(validateImageBytes(huge, resources)).toEqual({ error: "invalid_image" });
  });
});
