import { execFile, type ExecFileException } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectVideoMediaType, VIDEO_MAX_BYTES, VIDEO_SOURCE_MAX_BYTES } from "./video-media.js";

const COMPRESSION_TIMEOUT_MS = 120_000;
const AUDIO_BITRATE = 64_000;
const MIN_VIDEO_BITRATE = 64_000;
const MAX_VIDEO_BITRATE = 4_000_000;
const MAX_TIMING_DRIFT_SECONDS = 0.25;
let compressionTail = Promise.resolve();

export type VideoCompressionErrorCode =
  | "video_compression_unavailable"
  | "video_compression_failed"
  | "resource_read_aborted"
  | "resource_too_large"
  | "timeout";

export interface VideoCompressionOptions {
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

interface VideoMetadata {
  readonly duration: number;
  readonly videoIndex: number;
  readonly audioIndex?: number;
  readonly audioDuration?: number;
  readonly audioOffset?: number;
}

interface ProbeStream {
  readonly index: number;
  readonly codec_type?: string;
  readonly duration?: string;
  readonly start_time?: string;
  readonly width?: number;
  readonly height?: number;
  readonly disposition?: { readonly default?: number; readonly attached_pic?: number };
}

export class VideoCompressionError extends Error {
  public constructor(public readonly code: VideoCompressionErrorCode) {
    super(code);
    this.name = "VideoCompressionError";
  }
}

export async function prepareVideoForModel(bytes: Uint8Array, options: VideoCompressionOptions = {}): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? VIDEO_MAX_BYTES;
  if (options.signal?.aborted) throw new VideoCompressionError("resource_read_aborted");
  if (bytes.byteLength > VIDEO_SOURCE_MAX_BYTES) throw new VideoCompressionError("resource_too_large");
  if (bytes.byteLength <= maxBytes) return bytes;

  const previous = compressionTail;
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Cancelled waiters must not let later encoders overtake the active process.
  compressionTail = previous.then(() => slot);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? COMPRESSION_TIMEOUT_MS);
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  const onCancelled = () => rejectAborted(new VideoCompressionError("resource_read_aborted"));
  controller.signal.addEventListener("abort", onCancelled, { once: true });
  let directory: string | undefined;
  try {
    await Promise.race([previous, aborted]);
    controller.signal.throwIfAborted();
    directory = await mkdtemp(join(tmpdir(), "yesimbot-video-"));
    const input = join(directory, "input.mp4");
    const output = join(directory, "output.mp4");
    await writeFile(input, bytes, { mode: 0o600, signal: controller.signal });
    const original = await probeVideo(input, controller.signal);
    const bitrate = Math.min(MAX_VIDEO_BITRATE, Math.floor((maxBytes * 8 * 0.9) / original.duration) - (original.audioIndex === undefined ? 0 : AUDIO_BITRATE));
    if (bitrate < MIN_VIDEO_BITRATE) throw new VideoCompressionError("video_compression_failed");
    await runProcess(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-protocol_whitelist",
        "file,pipe",
        "-enable_drefs",
        "0",
        "-threads",
        "1",
        "-filter_threads",
        "1",
        "-i",
        input,
        "-map",
        `0:${original.videoIndex}`,
        ...(original.audioIndex === undefined ? [] : ["-map", `0:${original.audioIndex}`]),
        "-vf",
        "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "1",
        "-b:v",
        String(bitrate),
        "-maxrate",
        String(bitrate),
        "-bufsize",
        String(bitrate * 2),
        "-c:a",
        "aac",
        "-b:a",
        String(AUDIO_BITRATE),
        "-ac",
        "2",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-movflags",
        "+faststart",
        "-y",
        output,
      ],
      controller.signal,
    );
    if ((await stat(output)).size > maxBytes) throw new VideoCompressionError("video_compression_failed");
    const prepared = await probeVideo(output, controller.signal);
    if (
      Math.abs(prepared.duration - original.duration) > MAX_TIMING_DRIFT_SECONDS ||
      (original.audioIndex !== undefined && prepared.audioIndex === undefined) ||
      (original.audioDuration !== undefined &&
        (prepared.audioDuration === undefined || Math.abs(prepared.audioDuration - original.audioDuration) > MAX_TIMING_DRIFT_SECONDS)) ||
      (original.audioOffset !== undefined &&
        (prepared.audioOffset === undefined || Math.abs(prepared.audioOffset - original.audioOffset) > MAX_TIMING_DRIFT_SECONDS))
    ) {
      throw new VideoCompressionError("video_compression_failed");
    }
    const result = await readFile(output, { signal: controller.signal });
    controller.signal.throwIfAborted();
    if (!detectVideoMediaType(result)) throw new VideoCompressionError("video_compression_failed");
    return result;
  } catch (cause) {
    if (options.signal?.aborted) throw new VideoCompressionError("resource_read_aborted");
    if (timedOut) throw new VideoCompressionError("timeout");
    if (cause instanceof VideoCompressionError) throw cause;
    throw new VideoCompressionError("video_compression_failed");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    controller.signal.removeEventListener("abort", onCancelled);
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally {
      release();
    }
  }
}

async function probeVideo(path: string, signal: AbortSignal): Promise<VideoMetadata> {
  const output = await runProcess(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-enable_drefs",
      "0",
      "-f",
      "mov",
      "-show_entries",
      "format=duration:stream=index,codec_type,duration,start_time,width,height:stream_disposition=default,attached_pic",
      "-of",
      "json",
      path,
    ],
    signal,
  );
  const data = JSON.parse(output) as { format?: { duration?: string }; streams?: ProbeStream[] };
  const video = data.streams
    ?.filter((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic)
    .sort(
      (a, b) =>
        (b.disposition?.default ?? 0) - (a.disposition?.default ?? 0) ||
        Number(b.duration ?? data.format?.duration ?? 0) - Number(a.duration ?? data.format?.duration ?? 0) ||
        (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0),
    )[0];
  const audio = data.streams
    ?.filter((stream) => stream.codec_type === "audio")
    .sort((a, b) => (b.disposition?.default ?? 0) - (a.disposition?.default ?? 0))[0];
  const duration = Number(video?.duration ?? data.format?.duration);
  if (
    !video ||
    !Number.isInteger(video.index) ||
    video.index < 0 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    (audio && (!Number.isInteger(audio.index) || audio.index < 0))
  )
    throw new VideoCompressionError("video_compression_failed");
  const audioDuration = Number(audio?.duration);
  const audioOffset = Number(audio?.start_time) - Number(video.start_time);
  return {
    duration,
    videoIndex: video.index,
    ...(audio ? { audioIndex: audio.index } : {}),
    ...(Number.isFinite(audioDuration) && audioDuration > 0 ? { audioDuration } : {}),
    ...(Number.isFinite(audioOffset) ? { audioOffset } : {}),
  };
}

function runProcess(command: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let outcome: { cause: ExecFileException | null; stdout: string } | undefined;
    let closed = false;
    const settle = () => {
      if (!closed || !outcome) return;
      if (outcome.cause) reject(outcome.cause.code === "ENOENT" ? new VideoCompressionError("video_compression_unavailable") : outcome.cause);
      else resolve(outcome.stdout);
    };
    const child = execFile(command, args, { encoding: "utf8", signal, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true }, (cause, stdout) => {
      outcome = { cause, stdout };
      settle();
    });
    // Node's AbortSignal path can send SIGTERM despite execFile's killSignal option.
    const terminate = () => child.kill("SIGKILL");
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) terminate();
    child.once("close", () => {
      signal.removeEventListener("abort", terminate);
      closed = true;
      settle();
    });
  });
}
