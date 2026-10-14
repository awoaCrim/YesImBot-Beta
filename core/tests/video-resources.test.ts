import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));
import { h } from "koishi";

import { ChannelResources, detectVideoMediaType, RESOURCE_MAX_BYTES, VIDEO_MAX_BYTES } from "../src/resources/index.js";
import { PNG_BYTES } from "./helpers/index.js";
import { VIDEO_BYTES, paddedVideo } from "./helpers/video.js";

const roots: string[] = [];

async function resources(videoInput = true, timeout = 1000) {
  const root = await mkdtemp(join(tmpdir(), "video-resource-"));
  roots.push(root);
  return new ChannelResources(root, false, timeout, videoInput);
}

function context(bytes = VIDEO_BYTES, headers: Record<string, string> = { "content-type": "video/mp4" }) {
  const warn = vi.fn();
  const http = Object.assign(
    vi.fn(async (_src: string, _options: unknown) => ({
      status: 200,
      headers: new Headers(headers),
      data: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    })),
    { head: vi.fn(() => new Promise(() => {})) },
  );
  return { http, logger: () => ({ debug: vi.fn(), warn }), warn };
}
const video = () => h("video", { src: "https://private.example/clip?token=secret", file: "private-file", fileSize: 1 });
function box(type: string, payload: Uint8Array): Uint8Array {
  const data = new Uint8Array(payload.length + 8);
  new DataView(data.buffer).setUint32(0, data.length);
  data.set(new TextEncoder().encode(type), 4);
  data.set(payload, 8);
  return data;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return data;
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native MP4 validation and bounded input", () => {
  it("accepts real video, rejects ftyp-only/audio-only files and keeps canonical limits separate", () => {
    expect(VIDEO_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(RESOURCE_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(detectVideoMediaType(VIDEO_BYTES)).toBe("video/mp4");
    const ftypLength = new DataView(VIDEO_BYTES.buffer, VIDEO_BYTES.byteOffset).getUint32(0);
    expect(detectVideoMediaType(VIDEO_BYTES.slice(0, ftypLength))).toBeUndefined();
    const audioOnly = Buffer.from(VIDEO_BYTES);
    const handler = audioOnly.indexOf("vide");
    expect(handler).toBeGreaterThan(0);
    audioOnly.write("soun", handler);
    expect(detectVideoMediaType(audioOnly)).toBeUndefined();
    for (const invalid of [PNG_BYTES, VIDEO_BYTES.slice(0, -1), new Uint8Array(64)]) expect(detectVideoMediaType(invalid)).toBeUndefined();
    const malformed = VIDEO_BYTES.slice();
    new DataView(malformed.buffer).setUint32(0, 3);
    expect(detectVideoMediaType(malformed)).toBeUndefined();
  });

  it("requires actual track ownership and media data, not a loose/metadata video handler", () => {
    const ftypLength = new DataView(VIDEO_BYTES.buffer, VIDEO_BYTES.byteOffset).getUint32(0);
    const ftyp = VIDEO_BYTES.slice(0, ftypLength);
    const payload = new Uint8Array(24);
    payload.set(new TextEncoder().encode("vide"), 8);
    const handler = box("hdlr", payload);
    const media = box("mdat", new Uint8Array([1]));
    const track = box("moov", box("trak", box("mdia", handler)));
    for (const fake of [concat(ftyp, handler, media), concat(ftyp, track), concat(ftyp, box("moov", box("mdia", handler)), media)])
      expect(detectVideoMediaType(fake)).toBeUndefined();
    const brands = VIDEO_BYTES.slice();
    for (const offset of [8, ...Array.from({ length: (ftypLength - 16) / 4 }, (_, index) => 16 + index * 4)])
      brands.set(new TextEncoder().encode("bogs"), offset);
    expect(detectVideoMediaType(brands)).toBeUndefined();
  });

  it("persists exact bytes with one GET/no HEAD and removes transport attributes", async () => {
    const owner = await resources();
    const ctx = context();
    const [element] = await owner.persistElements(ctx as never, [video()]);
    const id = createHash("sha256").update(VIDEO_BYTES).digest("hex").slice(0, 32);
    expect(element).toMatchObject({ type: "video", attrs: { id } });
    for (const key of ["src", "file", "fileSize"]) expect(element!.attrs).not.toHaveProperty(key);
    expect(JSON.stringify(element)).not.toMatch(/private|secret|token/);
    expect(await owner.assets.get(id)).toEqual(VIDEO_BYTES);
    expect(ctx.http).toHaveBeenCalledOnce();
    expect(ctx.http.head).not.toHaveBeenCalled();
    expect(ctx.http.mock.calls[0]).toEqual([expect.any(String), expect.objectContaining({ timeout: 1000, responseType: "stream" })]);
  });

  it("accepts exact 10 MiB without lending the allowance to normal reads/non-video assets", async () => {
    const owner = await resources();
    const bytes = paddedVideo(VIDEO_MAX_BYTES);
    const [element] = await owner.persistElements(context(bytes) as never, [video()]);
    expect(element!.attrs.id).toMatch(/^[a-f0-9]{32}$/);
    const uri = "asset://" + element!.attrs.id;
    await expect(owner.openStrict(uri)).rejects.toMatchObject({ code: "resource_too_large" });
    const opened = (await owner.openVideoAssetStrict(uri)).bytes;
    expect(opened.byteLength).toBe(VIDEO_MAX_BYTES);
    expect(createHash("sha256").update(opened).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    const image = new Uint8Array(RESOURCE_MAX_BYTES + 1);
    image.set(PNG_BYTES);
    const imageId = await owner.assets.put(image);
    await expect(owner.openStrict("asset://" + imageId)).rejects.toMatchObject({ code: "resource_too_large" });
    await expect(owner.openVideoAssetStrict("asset://" + imageId)).rejects.toThrow();
  });

  it.each([
    { bytes: paddedVideo(VIDEO_MAX_BYTES + 1), headers: {} },
    { bytes: VIDEO_BYTES, headers: { "content-length": String(VIDEO_MAX_BYTES + 1) } },
    { bytes: VIDEO_BYTES, headers: { "content-type": "text/html" } },
    { bytes: VIDEO_BYTES, headers: { "content-type": "video/webm" } },
    { bytes: PNG_BYTES, headers: { "content-type": "video/mp4" } },
  ])("rejects oversize, incompatible MIME/disguised non-video without persisting", async ({ bytes, headers }) => {
    const owner = await resources();
    const put = vi.spyOn(owner.assets, "put");
    const ctx = context(bytes, headers);
    const [element] = await owner.persistElements(ctx as never, [video()]);
    expect(element!.attrs).toHaveProperty("yesimbotFailure", expect.any(String));
    expect(element!.attrs).not.toHaveProperty("id");
    expect(JSON.stringify(element)).not.toMatch(/private|secret|token/);
    expect(put).not.toHaveBeenCalled();
  });

  it("reserves count across nested/concurrent input and uses an independent image pool", async () => {
    const owner = await resources();
    const ctx = context(paddedVideo(VIDEO_MAX_BYTES));
    const elements = await owner.persistElements(ctx as never, [
      video(),
      h("message", {}, [video()]),
      h("img", { src: "data:image/png;base64," + Buffer.from(PNG_BYTES).toString("base64") }),
    ]);
    expect(elements[0]!.attrs.id).toBeTruthy();
    expect(elements[1]!.children[0]!.attrs.yesimbotFailure).toBeTruthy();
    expect(elements[2]!.attrs.id).toBeTruthy();
    expect(ctx.http).toHaveBeenCalledOnce();
  });

  it("disabled input strips sources without downloading; generic-file MP4 stays out of scope", async () => {
    const owner = await resources(false);
    const ctx = context();
    const [element] = await owner.persistElements(ctx as never, [video()]);
    expect(element!.attrs.yesimbotFailure).toBeTruthy();
    expect(JSON.stringify(element)).not.toMatch(/private|secret|token/);
    const file = h("file", { src: "https://example.test/clip.mp4", title: "clip.mp4" });
    expect(await owner.persistElements(ctx as never, [file])).toEqual([file]);
    expect(ctx.http).not.toHaveBeenCalled();
  });

  it("strips sources on cached videos and retains safe asset identity", async () => {
    const owner = await resources();
    const ctx = context();
    const id = await owner.assets.put(VIDEO_BYTES);
    const [element] = await owner.persistElements(ctx as never, [h("video", { ...video().attrs, id })]);
    expect(element!.attrs.id).toBe(id);
    expect(JSON.stringify(element)).not.toMatch(/private|secret|token/);
    expect(ctx.http).not.toHaveBeenCalled();
  });

  it.each(["data:video/mp4;base64,", "base64://"])("accepts exact 10 MiB from %s with padded base64", async (prefix) => {
    const owner = await resources();
    const bytes = paddedVideo(VIDEO_MAX_BYTES);
    const ctx = context();
    const [element] = await owner.persistElements(ctx as never, [h("video", { src: prefix + Buffer.from(bytes).toString("base64") })]);
    expect(element!.attrs.id).toBe(createHash("sha256").update(bytes).digest("hex").slice(0, 32));
    expect(ctx.http).not.toHaveBeenCalled();
  });

  it("bounds uncooperative asset reads by timeout and cancellation and discards late bytes", async () => {
    const owner = await resources(true, 50);
    const uri = "asset://" + (await owner.assets.put(VIDEO_BYTES));
    vi.useFakeTimers();
    let resolve!: (bytes: Uint8Array) => void;
    const get = vi.spyOn(owner.assets, "get").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const timed = (async () => {
      await expect(owner.openVideoAssetStrict(uri)).rejects.toMatchObject({ code: "timeout" });
    })();
    await vi.advanceTimersByTimeAsync(50);
    await timed;
    expect(get.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    resolve(VIDEO_BYTES);
    await Promise.resolve();
    const controller = new AbortController();
    const aborted = (async () => {
      await expect(owner.openVideoAssetStrict(uri, controller.signal)).rejects.toMatchObject({ code: "resource_read_aborted" });
    })();
    controller.abort();
    await aborted;
    resolve(VIDEO_BYTES);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("supports local MP4 ingestion without HTTP", async () => {
    const owner = await resources();
    const path = join(owner.path, "clip.mp4");
    await writeFile(path, VIDEO_BYTES);
    const ctx = context();
    const [element] = await owner.persistElements(ctx as never, [h("video", { src: pathToFileURL(path).href })]);
    expect(await owner.assets.get(element!.attrs.id)).toEqual(VIDEO_BYTES);
    expect(ctx.http).not.toHaveBeenCalled();
  });

  it("times out on partial EOF, observes rejected cancel and releases the deadline without saving", async () => {
    const owner = await resources(true, 50);
    const put = vi.spyOn(owner.assets, "put");
    vi.useFakeTimers();
    const cancel = vi.fn(() => Promise.reject(new Error("private cancellation failure")));
    const warn = vi.fn();
    const http = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      data: new ReadableStream({
        start(c) {
          c.enqueue(VIDEO_BYTES);
        },
        cancel,
      }),
    }));
    const pending = owner.persistElements({ http, logger: () => ({ debug: vi.fn(), warn }) } as never, [video()]);
    await vi.advanceTimersByTimeAsync(50);
    const [element] = await pending;
    expect(element!.attrs.yesimbotFailure).toBe("timeout");
    expect(cancel).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|secret|token/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects bad HTTP status without decoding or persisting its body", async () => {
    const owner = await resources();
    const put = vi.spyOn(owner.assets, "put");
    const cancel = vi.fn();
    const http = vi.fn(async () => ({ status: 403, headers: new Headers(), data: new ReadableStream({ cancel }) }));
    const [element] = await owner.persistElements({ http, logger: () => ({ debug: vi.fn(), warn: vi.fn() }) } as never, [video()]);
    expect(element!.attrs.yesimbotFailure).toBe("download_failed");
    expect(cancel).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
  });

  it("cancels a late header response after timeout and never writes its bytes", async () => {
    const owner = await resources(true, 50);
    const put = vi.spyOn(owner.assets, "put");
    vi.useFakeTimers();
    const cancel = vi.fn();
    const http = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { status: 200, headers: new Headers(), data: new ReadableStream({ cancel }) };
    });
    const pending = owner.persistElements({ http, logger: () => ({ debug: vi.fn(), warn: vi.fn() }) } as never, [video()]);
    await vi.advanceTimersByTimeAsync(50);
    expect((await pending)[0]!.attrs.yesimbotFailure).toBe("timeout");
    await vi.advanceTimersByTimeAsync(50);
    expect(cancel).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects invalid/cross-scheme video URIs and pre-aborted bounded asset reads", async () => {
    const owner = await resources();
    const id = await owner.assets.put(VIDEO_BYTES);
    for (const uri of ["https://example.test/clip.mp4", "asset://prefix", "asset://" + id + "/path", "artifact://tool/id"])
      await expect(owner.openVideoAssetStrict(uri)).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(owner.openVideoAssetStrict("asset://" + id, controller.signal)).rejects.toMatchObject({ code: "resource_read_aborted" });
  });
});
