import { encode as encodeJpeg } from "jpeg-js";
import { GifReader, GifWriter } from "omggif";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { firstFrameToPng, sampleGifFrames, staticFrameToPng, staticToGif } from "../src/frames.js";

const GIF_BASE64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function animation(disposal: number): Uint8Array {
  const bytes = new Uint8Array(4096);
  const writer = new GifWriter(bytes, 3, 1, { palette: [0xff0000, 0x00ff00, 0x0000ff, 0] });
  writer.addFrame(0, 0, 3, 1, [0, 0, 0], { delay: 2 });
  writer.addFrame(0, 0, 1, 1, [1], { delay: 3, disposal });
  writer.addFrame(2, 0, 1, 1, [2], { delay: 5 });
  writer.end();
  return bytes.slice(0, writer.getOutputBufferPosition());
}

function pixels(bytes: Uint8Array): number[] {
  return [...PNG.sync.read(Buffer.from(bytes)).data];
}

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];

describe("sampleGifFrames", () => {
  it("rejects malformed LZW forward references before entering the unbounded decoder", () => {
    const cyclic = new Uint8Array(Buffer.from("47494638396108000100800000ff00000000ff2c0000000008000100000202ff0f003b", "hex"));
    expect(sampleGifFrames(cyclic)).toBeUndefined();
    expect(firstFrameToPng(cyclic)).toBeUndefined();
    const invalidSize = animation(1);
    invalidSize[new GifReader(invalidSize).frameInfo(0).data_offset] = 12;
    expect(sampleGifFrames(invalidSize)).toBeUndefined();
  });

  it("validates dictionary growth and resets on a larger real encoded frame", () => {
    const width = 256;
    const height = 128;
    const bytes = new Uint8Array(width * height * 2 + 4096);
    const palette = Array.from({ length: 256 }, (_, index) => index * 0x010101);
    const indexed = Array.from({ length: width * height }, (_, index) => (index * 73 + Math.floor(index / 113) * 19) % 256);
    const writer = new GifWriter(bytes, width, height, { palette });
    writer.addFrame(0, 0, width, height, indexed);
    const input = bytes.slice(0, writer.end());
    const result = sampleGifFrames(input)!;
    expect(result.samples).toHaveLength(1);
    const actual = PNG.sync.read(Buffer.from(result.samples[0]!.png.bytes)).data;
    expect([...actual.filter((_value, index) => index % 4 === 0)]).toEqual(indexed);
  });

  it.each([
    [1, GREEN],
    [2, [0, 0, 0, 0]],
    [3, RED],
  ])("composes delta frames and applies disposal %s only to its rectangle", (disposal, firstPixel) => {
    const input = animation(disposal as number);
    const original = input.slice();
    const result = sampleGifFrames(input)!;
    expect(result.complete).toBe(true);
    expect(result.samples.map(({ index, timeMs, delayMs }) => ({ index, timeMs, delayMs }))).toEqual([
      { index: 0, timeMs: 0, delayMs: 20 },
      { index: 1, timeMs: 20, delayMs: 30 },
      { index: 2, timeMs: 50, delayMs: 50 },
    ]);
    expect(pixels(result.samples[1]!.png.bytes)).toEqual([...GREEN, ...RED, ...RED]);
    expect(pixels(result.samples[2]!.png.bytes)).toEqual([...(firstPixel as number[]), ...RED, ...BLUE]);
    expect(input).toEqual(original);
  });

  it("labels partial coverage and supports a one-frame budget without dividing by zero", () => {
    const input = animation(3);
    expect(sampleGifFrames(input, { maxFrames: 2 })?.samples.map((frame) => frame.index)).toEqual([0, 2]);
    expect(sampleGifFrames(input, { maxFrames: 2 })?.complete).toBe(false);
    expect(sampleGifFrames(input, { maxFrames: 1 })?.samples.map((frame) => frame.index)).toEqual([0]);
  });

  it("rejects invalid data and frame/pixel budgets rather than degrading to first-frame evidence", () => {
    const input = animation(3);
    expect(sampleGifFrames(input, { maxDecodedFrames: 2 })).toBeUndefined();
    expect(sampleGifFrames(input, { maxDecodedPixels: 8 })).toBeUndefined();
    expect(sampleGifFrames(input, { maxFrames: Number.NaN })).toBeUndefined();
    expect(sampleGifFrames(input, { maxDecodedPixels: Infinity })).toBeUndefined();
    expect(sampleGifFrames(new Uint8Array([1, 2, 3]))).toBeUndefined();
    const oversized = input.slice();
    oversized.set([255, 255, 255, 255], 6);
    expect(sampleGifFrames(oversized)).toBeUndefined();
  });
});

describe("staticFrameToPng", () => {
  it("validates headers before decoding and accepts real PNG/JPEG content", () => {
    const png = new PNG({ width: 1, height: 1 });
    png.data.set(RED);
    const bytes = new Uint8Array(PNG.sync.write(png));
    expect(pixels(staticFrameToPng(bytes, "image/png")!.bytes)).toEqual(RED);
    const jpeg = encodeJpeg({ width: 1, height: 1, data: Buffer.from(RED) }, 90);
    expect(staticFrameToPng(jpeg.data, "image/jpeg")?.mediaType).toBe("image/png");
    const oversized = bytes.slice();
    new DataView(oversized.buffer).setUint32(16, 0x7fffffff);
    expect(staticFrameToPng(oversized, "image/png")).toBeUndefined();
    expect(staticFrameToPng(bytes.slice(0, 20), "image/png")).toBeUndefined();
    expect(staticFrameToPng(bytes, "image/webp")).toBeUndefined();
  });
});

describe("firstFrameToPng", () => {
  it("converts the first GIF frame to a PNG", () => {
    const result = firstFrameToPng(new Uint8Array(Buffer.from(GIF_BASE64, "base64")));
    expect(result?.mediaType).toBe("image/png");

    const png = PNG.sync.read(Buffer.from(result!.bytes));
    expect(png.width).toBe(1);
    expect(png.height).toBe(1);
  });

  it("returns undefined for invalid GIF input", () => {
    expect(firstFrameToPng(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it("converts a static PNG to a single-frame GIF", () => {
    const png = new PNG({ width: 2, height: 1 });
    png.data.set([255, 0, 0, 255, 0, 255, 0, 255]);
    const result = staticToGif(new Uint8Array(PNG.sync.write(png)), "image/png");

    expect(result?.mediaType).toBe("image/gif");
    const gif = new GifReader(result!.bytes);
    expect(gif.width).toBe(2);
    expect(gif.height).toBe(1);
    expect(gif.numFrames()).toBe(1);
  });

  it("converts a static JPEG to a single-frame GIF", () => {
    const jpeg = encodeJpeg({ width: 1, height: 1, data: Buffer.from([255, 0, 0, 255]) }, 90);
    const result = staticToGif(new Uint8Array(jpeg.data), "image/jpeg");

    expect(result?.mediaType).toBe("image/gif");
    const gif = new GifReader(result!.bytes);
    expect(gif.width).toBe(1);
    expect(gif.height).toBe(1);
    expect(gif.numFrames()).toBe(1);
  });

  it("returns undefined for unsupported static image input", () => {
    expect(staticToGif(new Uint8Array([1, 2, 3]), "image/webp")).toBeUndefined();
  });
});
