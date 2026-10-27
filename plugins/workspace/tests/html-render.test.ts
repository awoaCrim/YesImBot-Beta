import { afterEach, describe, expect, it, vi } from "vitest";

import { createHtmlRenderTool } from "../src/html-render.js";

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXYsAAAAASUVORK5CYII=", "base64"));
const uri = "artifact://render_html/report.png";

function fixture() {
  const put = vi.fn(async () => uri);
  const forTool = vi.fn(() => ({ put }));
  const resources = {
    maxBytes: 5 * 1024 * 1024,
    artifacts: { forTool },
    detectImageMediaType: vi.fn((bytes: Uint8Array) => (Buffer.from(bytes).equals(Buffer.from(PNG)) ? "image/png" : undefined)),
  };
  const request = vi.fn(async () => new Response(PNG, { headers: { "Content-Type": "image/png" } }));
  vi.stubGlobal("fetch", request);
  const tool = createHtmlRenderTool("http://renderer.internal/render", resources as never);
  return { tool, resources, put, forTool, request };
}

const execution = { turnId: "turn", toolCallId: "call" } as never;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("render_html", () => {
  it("stores a PNG in the current channel and returns a send_message image element", async () => {
    const f = fixture();
    const html = '<!doctype html><meta charset="utf-8"><h1>AI 每日早报</h1>';
    const result = await f.tool.execute({ html }, execution);
    expect(f.request).toHaveBeenCalledWith(
      new URL("http://renderer.internal/render"),
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({ html, width: 1000 }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(f.forTool).toHaveBeenCalledWith("render_html");
    expect(f.put).toHaveBeenCalledWith(Buffer.from(PNG), { mediaType: "image/png", filename: "report.png" });
    expect(result).toEqual({ ok: true, uri, mediaType: "image/png", byteLength: PNG.byteLength, sendMessageMarkup: `<img src="${uri}"/>` });
  });

  it.each(["", " ", "中".repeat(70_000)])("rejects empty or oversized HTML before requesting the renderer", async (html) => {
    const f = fixture();
    expect(await f.tool.execute({ html }, execution)).toEqual({ ok: false, error: "invalid_html" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([479, 1441, 700.5])("rejects an invalid width (%s)", async (width) => {
    const f = fixture();
    expect(await f.tool.execute({ html: "<h1>test</h1>", width }, execution)).toEqual({ ok: false, error: "invalid_width" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rejects unsafe configured renderer URLs", () => {
    const f = fixture();
    for (const url of ["file:///etc/passwd", "http://user:password@example.com/render"]) {
      expect(() => createHtmlRenderTool(url, f.resources as never)).toThrow(/HTTP\(S\)/);
    }
  });

  it("reports renderer HTTP errors without claiming an image exists", async () => {
    const f = fixture();
    f.request.mockResolvedValue(new Response("unavailable", { status: 503 }));
    expect(await f.tool.execute({ html: "<h1>test</h1>" }, execution)).toEqual({ ok: false, error: "renderer_http_503" });
    expect(f.put).not.toHaveBeenCalled();
  });

  it.each(["text/html", "image/jpeg"])("rejects a non-PNG response (%s)", async (mediaType) => {
    const f = fixture();
    f.request.mockResolvedValue(new Response(PNG, { headers: { "Content-Type": mediaType } }));
    expect(await f.tool.execute({ html: "<h1>test</h1>" }, execution)).toEqual({ ok: false, error: "invalid_renderer_image" });
    expect(f.put).not.toHaveBeenCalled();
  });

  it("rejects invalid PNG data even when the content type claims PNG", async () => {
    const f = fixture();
    f.request.mockResolvedValue(new Response("not an image", { headers: { "Content-Type": "image/png" } }));
    expect(await f.tool.execute({ html: "<h1>test</h1>" }, execution)).toEqual({ ok: false, error: "invalid_renderer_image" });
    expect(f.put).not.toHaveBeenCalled();
  });

  it("bounds the response stream before persisting an image", async () => {
    const f = fixture();
    f.resources.maxBytes = PNG.byteLength - 1;
    expect(await f.tool.execute({ html: "<h1>test</h1>" }, execution)).toEqual({ ok: false, error: "renderer_image_too_large" });
    expect(f.put).not.toHaveBeenCalled();
  });

  it("does not request the renderer after the turn was aborted", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await f.tool.execute({ html: "<h1>test</h1>" }, { abortSignal: controller.signal } as never)).toEqual({ ok: false, error: "aborted" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("reports artifact persistence failures instead of inventing an image URI", async () => {
    const f = fixture();
    f.put.mockRejectedValue(new Error("disk error"));
    expect(await f.tool.execute({ html: "<h1>test</h1>" }, execution)).toEqual({ ok: false, error: "html_render_failed" });
  });
});
