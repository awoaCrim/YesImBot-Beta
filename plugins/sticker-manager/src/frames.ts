import { decode as decodeJpeg } from "jpeg-js";
import { GifReader, GifWriter, type Frame } from "omggif";
import { PNG } from "pngjs";

const MAX_FRAME_PIXELS = 16_777_216;
const GIF_BUFFER_EXTRA = 4096;
const DEFAULT_MAX_SAMPLED_FRAMES = 6;
const DEFAULT_MAX_DECODED_FRAMES = 240;
const DEFAULT_MAX_DECODED_PIXELS = 16_777_216 * 4;

export interface StaticFrame {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/png";
}

export interface StaticGif {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/gif";
}

export interface PreparedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/** One sampled GIF frame plus the timeline position it represents. */
export interface GifFrameSample {
  readonly index: number;
  /** Milliseconds from the first frame, using the file's per-frame delays. */
  readonly timeMs: number;
  readonly delayMs: number;
  readonly png: StaticFrame;
}

/**
 * Bounded multi-frame evidence for an animated GIF. Sampling is spread across the timeline so a
 * long animation is represented, not just its first frame; `complete` states whether every frame
 * was included. Original bytes are never modified.
 */
export interface GifFrameSampling {
  readonly width: number;
  readonly height: number;
  readonly totalFrames: number;
  readonly samples: readonly GifFrameSample[];
  readonly complete: boolean;
}

/** Decode budget for one sampling call. Bounds total work, not just a single frame's pixels. */
export interface GifSamplingLimits {
  readonly maxFrames?: number;
  /** Decoded frames allowed during composition of the requested samples. */
  readonly maxDecodedFrames?: number;
  /** Total pixels decoded across all composed frames. */
  readonly maxDecodedPixels?: number;
}

interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

interface HistogramBin {
  r: number;
  g: number;
  b: number;
  count: number;
}

export function firstFrameToPng(input: Uint8Array): StaticFrame | undefined {
  try {
    const reader = new GifReader(input);
    if (reader.numFrames() === 0) return undefined;
    const width = reader.width;
    const height = reader.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > MAX_FRAME_PIXELS) {
      return undefined;
    }

    if (!validGifFrame(input, reader.frameInfo(0), width, height)) return undefined;
    const rgba = new Uint8Array(width * height * 4);
    reader.decodeAndBlitFrameRGBA(0, rgba);
    const png = new PNG({ width, height });
    png.data.set(rgba);
    return { bytes: new Uint8Array(PNG.sync.write(png)), mediaType: "image/png" };
  } catch {
    return undefined;
  }
}

/**
 * Samples up to `maxFrames` frames spread evenly across a GIF timeline and converts each sample to
 * PNG. Two passes keep the cost bounded: the timeline is scanned for delays, then the needed frames
 * are composed in order so disposal modes and partial deltas render the same state a viewer sees.
 *
 * Returns undefined for invalid input, an over-budget animation, or a non-finite frame budget.
 */
export function sampleGifFrames(input: Uint8Array, options: GifSamplingLimits = {}): GifFrameSampling | undefined {
  const maxFrames = normalizeLimit(options.maxFrames, DEFAULT_MAX_SAMPLED_FRAMES);
  const maxDecodedFrames = normalizeLimit(options.maxDecodedFrames, DEFAULT_MAX_DECODED_FRAMES);
  const maxDecodedPixels = normalizeLimit(options.maxDecodedPixels, DEFAULT_MAX_DECODED_PIXELS);
  if (maxFrames === undefined || maxDecodedFrames === undefined || maxDecodedPixels === undefined) return undefined;

  try {
    const reader = new GifReader(input);
    const totalFrames = reader.numFrames();
    if (totalFrames === 0 || totalFrames > maxDecodedFrames) return undefined;
    const width = reader.width;
    const height = reader.height;
    if (!hasValidDimensions(width, height)) return undefined;
    const framePixels = width * height;

    const times: number[] = [];
    let elapsed = 0;
    for (let index = 0; index < totalFrames; index += 1) {
      times.push(elapsed);
      elapsed += Math.max(0, Math.round(reader.frameInfo(index).delay * 10));
    }

    const indices = sampleIndices(totalFrames, maxFrames);
    if (indices.length === 0) return undefined;
    const last = indices.at(-1)!;
    if (last + 1 > maxDecodedFrames || (last + 1) * framePixels > maxDecodedPixels) return undefined;

    const rgba = new Uint8Array(framePixels * 4);
    const samples: GifFrameSample[] = [];
    let previous: { x: number; y: number; width: number; height: number; disposal: number } | undefined;
    let nextSample = 0;
    let restore: Uint8Array | undefined;
    // Compose sequentially from frame 0; dispose the previous frame before blitting the next one,
    // which is what makes delta frames and disposal 2/3 render correctly.
    for (let index = 0; index <= last; index += 1) {
      if (previous?.disposal === 3 && restore) rgba.set(restore);
      else if (previous) applyDisposal(rgba, width, height, previous);
      const info = reader.frameInfo(index);
      if (!validGifFrame(input, info, width, height)) return undefined;
      restore = info.disposal === 3 ? rgba.slice() : undefined;
      previous = { x: info.x, y: info.y, width: info.width, height: info.height, disposal: info.disposal };
      reader.decodeAndBlitFrameRGBA(index, rgba);
      if (indices[nextSample] !== index) continue;
      nextSample += 1;
      const png = new PNG({ width, height });
      png.data.set(rgba);
      samples.push({
        index,
        timeMs: times[index] ?? 0,
        delayMs: Math.max(0, Math.round(info.delay * 10)),
        png: { bytes: new Uint8Array(PNG.sync.write(png)), mediaType: "image/png" },
      });
    }
    return { width, height, totalFrames, samples, complete: samples.length === totalFrames };
  } catch {
    return undefined;
  }
}

/**
 * Converts a static PNG/JPEG to PNG so a preview can reuse one projection path. Dimensions are
 * checked before decoding so an oversized image is rejected without allocating a full RGBA buffer.
 */
export function staticFrameToPng(input: Uint8Array, mediaType: string): StaticFrame | undefined {
  try {
    const dimensions = readStaticDimensions(input, mediaType);
    if (!dimensions || !hasValidDimensions(dimensions.width, dimensions.height)) return undefined;
    const image = decodeStaticImage(input, mediaType);
    if (!image) return undefined;
    const png = new PNG({ width: image.width, height: image.height });
    png.data.set(image.rgba);
    return { bytes: new Uint8Array(PNG.sync.write(png)), mediaType: "image/png" };
  } catch {
    return undefined;
  }
}

export function staticToGif(input: Uint8Array, mediaType: string): StaticGif | undefined {
  try {
    const image = decodeStaticImage(input, mediaType);
    if (!image || !hasValidDimensions(image.width, image.height)) return undefined;
    return { bytes: encodeRgbaToGif(image.rgba, image.width, image.height), mediaType: "image/gif" };
  } catch {
    return undefined;
  }
}

export function prepareStaticGif(input: Uint8Array, mediaType: string, enabled: boolean): PreparedImage {
  if (!enabled) return { bytes: input, mediaType };
  return staticToGif(input, mediaType) ?? { bytes: input, mediaType };
}

/**
 * omggif does not reject invalid LZW forward references: they can create a cyclic dictionary and
 * hang its synchronous decoder. Validate code references and exact output length first, without
 * chasing dictionary chains. Work is linear in compressed bytes, with a fixed 4096-entry table.
 */
function validGifFrame(input: Uint8Array, frame: Frame, width: number, height: number): boolean {
  if (frame.width <= 0 || frame.height <= 0 || frame.x + frame.width > width || frame.y + frame.height > height) return false;
  if (frame.palette_offset === null || frame.palette_size === null || frame.palette_offset + frame.palette_size * 3 > input.length) return false;
  const end = frame.data_offset + frame.data_length;
  if (frame.data_offset < 0 || end > input.length) return false;
  let offset = frame.data_offset;
  const minimum = input[offset++]!;
  if (minimum < 2 || minimum > 8) return false;
  const clear = 1 << minimum;
  const lengths = new Uint32Array(4096);
  let next = clear + 2;
  let codeSize = minimum + 1;
  let previousLength = 0;
  let produced = 0;
  let bits = 0;
  let buffer = 0;
  const expected = frame.width * frame.height;
  while (offset < end) {
    const size = input[offset++]!;
    // Some widely used one-pixel GIFs omit EOI. Accept a terminated, fully validated stream only
    // when it produced exactly the expected pixels; never permit missing/forward dictionary codes.
    if (size === 0) return produced === expected;
    if (offset + size > end) return false;
    const blockEnd = offset + size;
    while (offset < blockEnd) {
      buffer |= input[offset++]! << bits;
      bits += 8;
      while (bits >= codeSize) {
        const code = buffer & ((1 << codeSize) - 1);
        buffer >>>= codeSize;
        bits -= codeSize;
        if (code === clear) {
          next = clear + 2;
          codeSize = minimum + 1;
          previousLength = 0;
          continue;
        }
        if (code === clear + 1) return produced === expected;
        let length: number;
        if (code < clear) length = 1;
        else if (code < next) length = lengths[code]!;
        else if (code === next && previousLength > 0) length = previousLength + 1;
        else return false;
        if (length === 0 || produced + length > expected) return false;
        produced += length;
        if (previousLength > 0 && next < 4096) {
          lengths[next++] = previousLength + 1;
          if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
        }
        previousLength = length;
      }
    }
  }
  return false;
}

/** Browser-compatible restore-to-background: clear the previous frame's rectangle. */
function applyDisposal(
  rgba: Uint8Array,
  width: number,
  height: number,
  frame: { x: number; y: number; width: number; height: number; disposal: number },
): void {
  if (frame.disposal === 2) {
    const endX = Math.min(width, frame.x + frame.width);
    const endY = Math.min(height, frame.y + frame.height);
    for (let y = Math.max(0, frame.y); y < endY; y += 1) {
      const rowStart = (y * width + Math.max(0, frame.x)) * 4;
      rgba.fill(0, rowStart, rowStart + (endX - Math.max(0, frame.x)) * 4);
    }
    return;
  }
}

function normalizeLimit(value: number | undefined, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return undefined;
  const normalized = Math.max(1, Math.trunc(value));
  return Number.isFinite(normalized) ? normalized : undefined;
}

/** Header-only dimension read; avoids decoding an image that would exceed the frame budget. */
function readStaticDimensions(input: Uint8Array, mediaType: string): { width: number; height: number } | undefined {
  if (mediaType === "image/png") {
    if (input.length < 24) return undefined;
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mediaType === "image/jpeg" || mediaType === "image/jpg") {
    return readJpegDimensions(input);
  }
  return undefined;
}

/** Walks JPEG segment markers to the SOF frame header, which carries the real dimensions. */
function readJpegDimensions(input: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < input.length) {
    if (input[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = input[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (input[offset + 2]! << 8) | input[offset + 3]!;
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (input[offset + 5]! << 8) | input[offset + 6]!, width: (input[offset + 7]! << 8) | input[offset + 8]! };
    }
    offset += 2 + length;
  }
  return undefined;
}

function sampleIndices(totalFrames: number, maxFrames: number): number[] {
  if (maxFrames <= 1) return [0];
  if (totalFrames <= maxFrames) return Array.from({ length: totalFrames }, (_value, index) => index);
  const indices: number[] = [];
  for (let slot = 0; slot < maxFrames; slot += 1) {
    const index = Math.round((slot * (totalFrames - 1)) / (maxFrames - 1));
    if (indices.at(-1) !== index) indices.push(index);
  }
  return indices;
}

function decodeStaticImage(input: Uint8Array, mediaType: string): RgbaImage | undefined {
  if (mediaType === "image/png") {
    const png = PNG.sync.read(Buffer.from(input));
    return { width: png.width, height: png.height, rgba: new Uint8Array(png.data) };
  }
  if (mediaType === "image/jpeg" || mediaType === "image/jpg") {
    const jpeg = decodeJpeg(Buffer.from(input), { useTArray: true });
    return { width: jpeg.width, height: jpeg.height, rgba: jpeg.data };
  }
  return undefined;
}

function hasValidDimensions(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width * height <= MAX_FRAME_PIXELS;
}

function encodeRgbaToGif(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const hasTransparency = hasTransparentPixels(rgba);
  const colors = medianCutPalette(buildHistogram(rgba), hasTransparency ? 255 : 256);
  const nearest = createNearestIndex(colors, hasTransparency ? 1 : 0);
  const indexed = new Uint8Array(width * height);

  for (let pixel = 0; pixel < indexed.length; pixel += 1) {
    const offset = pixel * 4;
    if (hasTransparency && rgba[offset + 3]! < 128) {
      indexed[pixel] = 0;
      continue;
    }
    const r = rgba[offset]!;
    const g = rgba[offset + 1]!;
    const b = rgba[offset + 2]!;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    indexed[pixel] = nearest[key]!;
  }

  const palette = toGifPalette(colors, hasTransparency);
  const output = new Uint8Array(width * height * 2 + GIF_BUFFER_EXTRA);
  const writer = new GifWriter(output, width, height, { palette });
  writer.addFrame(0, 0, width, height, indexed as unknown as number[], { transparent: hasTransparency ? 1 : 0 });
  writer.end();
  return new Uint8Array(output.slice(0, writer.getOutputBufferPosition()));
}

function hasTransparentPixels(rgba: Uint8Array): boolean {
  for (let offset = 3; offset < rgba.length; offset += 4) {
    if (rgba[offset]! < 128) return true;
  }
  return false;
}

function buildHistogram(rgba: Uint8Array): HistogramBin[] {
  const bins = new Map<number, HistogramBin>();
  for (let pixel = 0; pixel * 4 < rgba.length; pixel += 1) {
    const offset = pixel * 4;
    if (rgba[offset + 3]! < 128) continue;
    const r = rgba[offset]!;
    const g = rgba[offset + 1]!;
    const b = rgba[offset + 2]!;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let bin = bins.get(key);
    if (!bin) {
      bin = { r: 0, g: 0, b: 0, count: 0 };
      bins.set(key, bin);
    }
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bin.count += 1;
  }
  return [...bins.values()].map((bin) => ({ r: bin.r / bin.count, g: bin.g / bin.count, b: bin.b / bin.count, count: bin.count }));
}

function medianCutPalette(bins: readonly HistogramBin[], maxColors: number): Array<[number, number, number]> {
  if (bins.length === 0) return [[0, 0, 0]];
  let boxes: HistogramBin[][] = [bins as HistogramBin[]];
  while (boxes.length < maxColors) {
    const index = widestBoxIndex(boxes);
    if (index < 0) break;
    const split = splitBox(boxes[index]!);
    if (!split) break;
    boxes.splice(index, 1, split[0], split[1]);
  }
  return boxes.map(averageBoxColor);
}

function widestBoxIndex(boxes: readonly (readonly HistogramBin[])[]): number {
  let best = -1;
  let bestRange = -1;
  for (let index = 0; index < boxes.length; index += 1) {
    const range = boxRange(boxes[index]!);
    if (range > bestRange) {
      bestRange = range;
      best = index;
    }
  }
  return best;
}

function boxRange(box: readonly HistogramBin[]): number {
  let rMin = 255;
  let rMax = 0;
  let gMin = 255;
  let gMax = 0;
  let bMin = 255;
  let bMax = 0;
  for (const bin of box) {
    rMin = Math.min(rMin, bin.r);
    rMax = Math.max(rMax, bin.r);
    gMin = Math.min(gMin, bin.g);
    gMax = Math.max(gMax, bin.g);
    bMin = Math.min(bMin, bin.b);
    bMax = Math.max(bMax, bin.b);
  }
  return Math.max(rMax - rMin, gMax - gMin, bMax - bMin);
}

function splitBox(box: readonly HistogramBin[]): [HistogramBin[], HistogramBin[]] | undefined {
  if (box.length < 2) return undefined;
  const channel = largestChannel(box);
  const sorted = [...box].sort((left, right) => left[channel] - right[channel]);
  const total = sorted.reduce((sum, bin) => sum + bin.count, 0);
  let accumulated = 0;
  let splitAt = sorted.length;
  for (let index = 0; index < sorted.length - 1; index += 1) {
    accumulated += sorted[index]!.count;
    if (accumulated * 2 >= total) {
      splitAt = index + 1;
      break;
    }
  }
  if (splitAt >= sorted.length) splitAt = Math.floor(sorted.length / 2);
  if (splitAt <= 0 || splitAt >= sorted.length) return undefined;
  return [sorted.slice(0, splitAt), sorted.slice(splitAt)];
}

function largestChannel(box: readonly HistogramBin[]): "r" | "g" | "b" {
  let rMin = 255;
  let rMax = 0;
  let gMin = 255;
  let gMax = 0;
  let bMin = 255;
  let bMax = 0;
  for (const bin of box) {
    rMin = Math.min(rMin, bin.r);
    rMax = Math.max(rMax, bin.r);
    gMin = Math.min(gMin, bin.g);
    gMax = Math.max(gMax, bin.g);
    bMin = Math.min(bMin, bin.b);
    bMax = Math.max(bMax, bin.b);
  }
  const rRange = rMax - rMin;
  const gRange = gMax - gMin;
  const bRange = bMax - bMin;
  if (rRange >= gRange && rRange >= bRange) return "r";
  if (gRange >= bRange) return "g";
  return "b";
}

function averageBoxColor(box: readonly HistogramBin[]): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (const bin of box) {
    r += bin.r * bin.count;
    g += bin.g * bin.count;
    b += bin.b * bin.count;
    count += bin.count;
  }
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

function createNearestIndex(colors: readonly (readonly [number, number, number])[], offset: number): Uint8Array {
  const nearest = new Uint8Array(1 << 15);
  for (let key = 0; key < nearest.length; key += 1) {
    const r = ((key >> 10) << 3) | ((key >> 10) >> 2);
    const g = (((key >> 5) & 0x1f) << 3) | (((key >> 5) & 0x1f) >> 2);
    const b = ((key & 0x1f) << 3) | ((key & 0x1f) >> 2);
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < colors.length; index += 1) {
      const color = colors[index]!;
      const dr = r - color[0];
      const dg = g - color[1];
      const db = b - color[2];
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    nearest[key] = offset + best;
  }
  return nearest;
}

function toGifPalette(colors: readonly (readonly [number, number, number])[], hasTransparency: boolean): number[] {
  const palette = hasTransparency ? [[0, 0, 0], ...colors] : colors;
  const flat = palette.map(([r, g, b]) => (r << 16) | (g << 8) | b);
  let size = 2;
  while (size < flat.length) size <<= 1;
  while (flat.length < size) flat.push(0);
  return flat;
}
