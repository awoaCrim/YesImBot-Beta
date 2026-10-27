/** Maximum MP4 bytes projected into one model request. */
export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

export const VIDEO_SOURCE_MAX_BYTES = 200 * 1024 * 1024;

/**
 * MP4-family major brands. Anything else — including QuickTime (`qt  `) and unknown ASCII
 * brands — fails closed instead of being treated as an MP4 because it merely looks like one.
 */
const MP4_MAJOR_BRANDS = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "iso8",
  "iso9",
  "mp41",
  "mp42",
  "mp4v",
  "avc1",
  "m4v",
  "m4vp",
  "mmp4",
  "dash",
  "msdh",
  "msix",
  "msnv",
  "cmfc",
  "cmff",
  "cmfs",
]);

/** Containers the validator descends into; `meta` is a FullBox whose children start 4 bytes later. */
const CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "meta"]);

/** Only a handler directly inside `moov/trak/mdia` proves a real track rather than metadata. */
const VIDEO_TRACK_PATH = "moov/trak/mdia";
const MAX_BOX_DEPTH = 12;
const MAX_BOXES = 4096;

interface BoxHeader {
  readonly type: string;
  readonly headerSize: number;
  readonly end: number;
}

/**
 * Detects a real MP4 with at least one video track by walking ISO BMFF boxes. Ordinary 32-bit
 * sizes plus 64-bit (`largesize`) extents are honored, the whole layout must be well formed (so a
 * truncated tail is rejected even after an earlier `moov`), and a `vide` handler only counts as a
 * video track when it sits at `moov/trak/mdia`. This validates container structure only: codec
 * support, duration and audio remain upstream concerns, and no filename or MIME is trusted.
 */
export function detectVideoMediaType(bytes: Uint8Array): string | undefined {
  if (!isMp4FileType(bytes)) return undefined;
  return hasVideoTrack(bytes) ? "video/mp4" : undefined;
}

function isMp4FileType(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const box = readBoxHeader(bytes, 0, bytes.length);
  if (!box || box.type !== "ftyp") return false;
  const payload = box.headerSize;
  if (payload + 8 > box.end || (box.end - payload - 8) % 4 !== 0) return false;
  return MP4_MAJOR_BRANDS.has(readAscii(bytes, payload, 4).trim().toLowerCase());
}

function hasVideoTrack(bytes: Uint8Array): boolean {
  let boxes = 0;
  let videoTrack = false;
  let mediaData = false;
  const visit = (start: number, end: number, depth: number, path: readonly string[]): boolean => {
    if (depth > MAX_BOX_DEPTH) return false;
    let offset = start;
    while (offset + 8 <= end) {
      const box = readBoxHeader(bytes, offset, end);
      if (!box) return false;
      boxes += 1;
      if (boxes > MAX_BOXES) return false;
      const payload = offset + box.headerSize;
      if (box.type === "mdat" && path.length === 0 && payload < box.end) mediaData = true;
      if (box.type === "hdlr") {
        // FullBox: version/flags (4) + pre_defined (4) + handler_type (4) must fit in the box.
        if (payload + 12 <= box.end && path.join("/") === VIDEO_TRACK_PATH && readAscii(bytes, payload + 8, 4) === "vide") videoTrack = true;
      } else if (CONTAINER_BOXES.has(box.type)) {
        const nestedStart = box.type === "meta" ? payload + 4 : payload;
        if (nestedStart > box.end) return false;
        if (!visit(nestedStart, box.end, depth + 1, [...path, box.type])) return false;
      }
      offset = box.end;
    }
    // A leftover shorter-than-header tail means the box layout is malformed or truncated.
    return offset === end;
  };
  return visit(0, bytes.length, 0, []) && videoTrack && mediaData;
}

function readBoxHeader(bytes: Uint8Array, offset: number, end: number): BoxHeader | undefined {
  const size32 = readUint32(bytes, offset);
  const type = readAscii(bytes, offset + 4, 4);
  if (!/^[\x20-\x7e]{4}$/.test(type)) return undefined;
  let headerSize = 8;
  let size = size32;
  if (size32 === 1) {
    if (offset + 16 > end) return undefined;
    size = readUint32(bytes, offset + 8) * 2 ** 32 + readUint32(bytes, offset + 12);
    headerSize = 16;
  } else if (size32 === 0) {
    size = end - offset;
  }
  if (!Number.isSafeInteger(size) || size < headerSize) return undefined;
  const boxEnd = offset + size;
  if (boxEnd > end) return undefined;
  return { type, headerSize, end: boxEnd };
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return "";
  let text = "";
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[offset + index]!);
  return text;
}
