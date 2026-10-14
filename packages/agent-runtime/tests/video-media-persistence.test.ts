import { describe, expect, it } from "vitest";

import { createMessageEntry } from "../src/entry.js";
import { sanitizeAgentEntriesForPersistence, sanitizeAgentMessageForPersistence } from "../src/media.js";
import { createToolMessage, createUserMessage } from "../src/message.js";

const DATA = "dmlkZW8tc2VjcmV0LWJ5dGVz";
const URI = "asset://0123456789abcdef0123456789abcdef";
const shapes = [
  { type: "file-data", data: DATA, mediaType: "video/mp4" },
  { type: "file-data", data: DATA, mediaType: "VIDEO/MP4" },
  { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "video/mp4" },
  { type: "video", video: DATA },
  { type: "video", data: DATA, mimeType: "video/mp4" },
  { inlineData: { mimeType: "video/mp4", data: DATA } },
];
function tool(output: unknown) {
  return createToolMessage([{ type: "tool-result", toolCallId: "read-video", toolName: "read", output }] as never);
}

describe("durable video payload sanitation", () => {
  it.each(shapes)("removes structured video without mutating the source shape %j", (shape) => {
    const input = tool({ type: "content", value: [{ type: "text", text: URI + " video/mp4" }, shape] });
    const once = sanitizeAgentMessageForPersistence(input);
    expect(JSON.stringify(once)).not.toContain(DATA);
    expect(JSON.stringify(once)).not.toContain('"data":{"0":1');
    expect(JSON.stringify(once)).toContain(URI);
    expect(JSON.stringify(once)).toContain("read-video");
    expect(sanitizeAgentMessageForPersistence(once)).toEqual(once);
    expect(input.content[0]!.output).toEqual({ type: "content", value: [{ type: "text", text: URI + " video/mp4" }, shape] });
  });

  it("removes base64 data URLs from nested JSON, text and byte-container payloads; preserves PDF/text", () => {
    const input = tool({
      type: "json",
      value: {
        uri: URI,
        videoMode: "native",
        nested: { source: "prefix data:video/mp4;base64," + DATA + " suffix", clip: { type: "file-data", mediaType: "video/mp4", data: DATA } },
        pdf: { type: "file-data", mediaType: "application/pdf", data: "UNCHANGED_PDF" },
        text: "ordinary text",
      },
    });
    const safe = sanitizeAgentMessageForPersistence(input);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain(DATA);
    expect(serialized).not.toContain("data:video/");
    expect(serialized).toContain("UNCHANGED_PDF");
    expect(serialized).toContain("ordinary text");
    expect(serialized).toContain(URI);
    expect(sanitizeAgentMessageForPersistence(safe)).toEqual(safe);
  });

  it.each([
    ["image", "data:image/svg+xml,%3Csvg%3EPRIVATE_MEDIA%3C/svg%3E"],
    ["image", "data:image/png;charset=utf-8;base64,UFJJVkFURV9NRURJQQ=="],
    ["video", "data:video/mp4;charset=utf-8;base64,UFJJVkFURV9NRURJQQ=="],
    ["video", "data:VIDEO/MP4,%01PRIVATE_MEDIA"],
  ])("sanitizes parameterized/non-base64 %s URLs in nested fields and text", (kind, url) => {
    const input = tool({
      type: "json",
      value: { uri: URI, nested: { [kind + "Url"]: url, source: url }, text: "before " + url + " after", pdf: "data:application/pdf;base64,UNCHANGED" },
    });
    const safe = sanitizeAgentMessageForPersistence(input);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("PRIVATE_MEDIA");
    expect(serialized).not.toContain("UFJJVkFURV9NRURJQQ==");
    expect(serialized).not.toMatch(/data:(?:image|video)\//i);
    expect(serialized).toContain(kind + "_payload_removed");
    expect(serialized).toContain("before ");
    expect(serialized).toContain(" after");
    expect(serialized).toContain("data:application/pdf;base64,UNCHANGED");
    expect(serialized).toContain(URI);
    expect(sanitizeAgentMessageForPersistence(safe)).toEqual(safe);
  });

  it("uses a video-only removal marker without changing the existing image-only marker", () => {
    const video = sanitizeAgentMessageForPersistence(tool({ type: "content", value: [{ type: "file-data", mediaType: "video/mp4", data: DATA }] }));
    const image = sanitizeAgentMessageForPersistence(tool({ type: "content", value: [{ type: "image-data", mediaType: "image/png", data: "SU1BR0U=" }] }));
    expect(video.content[0]!.output).toEqual({ type: "json", value: { error: "video_payload_removed" } });
    expect(image.content[0]!.output).toEqual({ type: "json", value: { error: "image_payload_removed" } });
  });

  it("keeps existing image markers and tool pairing while sanitizing array video parts", () => {
    const entries = [
      createMessageEntry(
        tool({
          type: "content",
          value: [
            { type: "image-data", mediaType: "image/png", data: "SU1BR0U=" },
            { type: "file-data", mediaType: "video/mp4", data: DATA },
            { type: "text", text: URI },
          ],
        }),
      ),
      createMessageEntry(createUserMessage("data:video/mp4;base64," + DATA)),
    ];
    const once = sanitizeAgentEntriesForPersistence(entries);
    const serialized = JSON.stringify(once);
    expect(serialized).not.toContain(DATA);
    expect(serialized).not.toContain("SU1BR0U=");
    expect(serialized).toContain("read-video");
    expect(serialized).toContain(URI);
    expect(sanitizeAgentEntriesForPersistence(once)).toEqual(once);
    expect(JSON.stringify(entries)).toContain(DATA);
  });
});
