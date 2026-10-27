import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prepareVideoForModel } from "../src/resources/video-compression.js";
import { VIDEO_BYTES, paddedVideo } from "./helpers/video.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const limit = 128 * 1024;
const source = paddedVideo(limit + 8);
const metadata = {
  format: { duration: "3" },
  streams: [
    { index: 0, codec_type: "video", duration: "3", start_time: "0", disposition: { default: 1, attached_pic: 0 } },
    { index: 1, codec_type: "audio", duration: "3", start_time: "0", disposition: { default: 1, attached_pic: 0 } },
  ],
};
let output: Uint8Array;
let inputMetadata: typeof metadata;
let outputMetadata: typeof metadata;
let holdEncoding: boolean;
let deferEncoderClose: boolean;
let missingCommand: string | undefined;
const paths: string[] = [];
const pendingCloses: Array<() => void> = [];

type ProcessOptions = { signal: AbortSignal; killSignal: string; maxBuffer: number };

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

beforeEach(() => {
  output = VIDEO_BYTES;
  inputMetadata = metadata;
  outputMetadata = metadata;
  holdEncoding = false;
  deferEncoderClose = false;
  missingCommand = undefined;
  vi.mocked(execFile)
    .mockReset()
    .mockImplementation(((command: string, args: string[], options: ProcessOptions, callback: Callback) => {
      const path = args.at(-1)!;
      paths.push(path);
      const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
      const complete = (error: Error | null, stdout = "") => {
        callback(error, stdout, "");
        const close = () => child.emit("close", error ? 1 : 0, null);
        if (command === "ffmpeg" && deferEncoderClose) pendingCloses.push(close);
        else queueMicrotask(close);
      };
      if (command === missingCommand) {
        complete(Object.assign(new Error("private/path?token=secret"), { code: "ENOENT" }));
      } else if (command === "ffprobe") {
        complete(null, JSON.stringify(path.endsWith("input.mp4") ? inputMetadata : outputMetadata));
      } else if (holdEncoding) {
        options.signal.addEventListener("abort", () => complete(Object.assign(new Error("cancelled"), { code: "ABORT_ERR" })), { once: true });
      } else {
        void writeFile(path, output).then(
          () => complete(null),
          (error: Error) => complete(error),
        );
      }
      return child;
    }) as never);
});

afterEach(async () => {
  pendingCloses.splice(0).forEach((close) => close());
  for (const path of paths.splice(0)) await assert.rejects(access(dirname(path)), { code: "ENOENT" });
});

describe("bounded native-video compression", () => {
  it("passes through video already within the model cap without requiring ffmpeg", async () => {
    expect(await prepareVideoForModel(VIDEO_BYTES, { maxBytes: limit })).toBe(VIDEO_BYTES);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("honors cancellation even for a pass-through video", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(prepareVideoForModel(VIDEO_BYTES, { signal: controller.signal })).rejects.toMatchObject({ code: "resource_read_aborted" });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("compresses a private local copy, retains duration and audio, and cleans all temporary files", async () => {
    const original = Buffer.from(source);
    expect(await prepareVideoForModel(source, { maxBytes: limit })).toEqual(Buffer.from(VIDEO_BYTES));
    expect(Buffer.from(source)).toEqual(original);
    const call = vi.mocked(execFile).mock.calls.find(([command]) => command === "ffmpeg")!;
    const args = call[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining(["-nostdin", "-xerror", "-protocol_whitelist", "file,pipe", "-c:v", "libx264", "-c:a", "aac", "-map", "0:1", "-threads", "1"]),
    );
    for (const truncation of ["-fs", "-t", "-to", "-shortest", "-an"]) expect(args).not.toContain(truncation);
    expect(call[2]).toMatchObject({ killSignal: "SIGKILL", maxBuffer: expect.any(Number) });
  });

  it("selects default main streams rather than cover art, an auxiliary video or commentary audio", async () => {
    inputMetadata = {
      ...metadata,
      streams: [
        { ...metadata.streams[0]!, index: 0, duration: "0.1", disposition: { default: 1, attached_pic: 1 } },
        { ...metadata.streams[0]!, index: 1, duration: "1", disposition: { default: 0, attached_pic: 0 } },
        { ...metadata.streams[0]!, index: 2 },
        { ...metadata.streams[1]!, index: 3, duration: "1", disposition: { default: 0, attached_pic: 0 } },
        { ...metadata.streams[1]!, index: 4 },
      ],
    };
    await prepareVideoForModel(source, { maxBytes: limit });
    const args = vi.mocked(execFile).mock.calls.find(([command]) => command === "ffmpeg")![1] as string[];
    expect(args.filter((_value, index) => args[index - 1] === "-map")).toEqual(["0:2", "0:4"]);
  });

  it.each(["too_large", "not_video", "truncated", "missing_audio", "truncated_audio", "shifted_audio"] as const)(
    "refuses %s output rather than uploading it",
    async (failure) => {
      if (failure === "too_large") output = paddedVideo(limit + 1);
      if (failure === "not_video") output = new Uint8Array([1, 2, 3]);
      if (failure === "truncated") outputMetadata = { ...metadata, streams: [{ ...metadata.streams[0]!, duration: "1" }, metadata.streams[1]!] };
      if (failure === "missing_audio") outputMetadata = { ...metadata, streams: [metadata.streams[0]!] };
      if (failure === "truncated_audio") outputMetadata = { ...metadata, streams: [metadata.streams[0]!, { ...metadata.streams[1]!, duration: "1" }] };
      if (failure === "shifted_audio") outputMetadata = { ...metadata, streams: [metadata.streams[0]!, { ...metadata.streams[1]!, start_time: "1" }] };
      await expect(prepareVideoForModel(source, { maxBytes: limit })).rejects.toMatchObject({ code: "video_compression_failed" });
    },
  );

  it.each(["ffprobe", "ffmpeg"])("reports missing %s without exposing raw process errors", async (command) => {
    missingCommand = command;
    await expect(prepareVideoForModel(source, { maxBytes: limit })).rejects.toMatchObject({
      code: "video_compression_unavailable",
      message: "video_compression_unavailable",
    });
  });

  it("cancels encoding and rejects the result before it can be projected", async () => {
    holdEncoding = true;
    const controller = new AbortController();
    const pending = prepareVideoForModel(source, { maxBytes: limit, signal: controller.signal });
    const outcome = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(vi.mocked(execFile).mock.calls.some(([command]) => command === "ffmpeg")).toBe(true));
    controller.abort();
    expect(await outcome).toMatchObject({ code: "resource_read_aborted" });
    const index = vi.mocked(execFile).mock.calls.findIndex(([command]) => command === "ffmpeg");
    expect(vi.mocked(execFile).mock.results[index]!.value.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("times out stalled encoding and removes the local copy", async () => {
    holdEncoding = true;
    await expect(prepareVideoForModel(source, { maxBytes: limit, timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("does not let an aborted queue waiter release the active encoder's slot", async () => {
    holdEncoding = true;
    const active = new AbortController();
    const first = prepareVideoForModel(source, { maxBytes: limit, signal: active.signal });
    const firstOutcome = first.catch((error: unknown) => error);
    await vi.waitFor(() => expect(vi.mocked(execFile).mock.calls.some(([command]) => command === "ffmpeg")).toBe(true));
    const waiting = new AbortController();
    const second = prepareVideoForModel(source, { maxBytes: limit, signal: waiting.signal });
    const secondOutcome = second.catch((error: unknown) => error);
    waiting.abort();
    expect(await secondOutcome).toMatchObject({ code: "resource_read_aborted" });
    holdEncoding = false;
    const third = prepareVideoForModel(source, { maxBytes: limit });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(vi.mocked(execFile).mock.calls.filter(([command]) => command === "ffmpeg")).toHaveLength(1);
    active.abort();
    expect(await firstOutcome).toMatchObject({ code: "resource_read_aborted" });
    await expect(third).resolves.toEqual(Buffer.from(VIDEO_BYTES));
  });

  it("waits for actual child close before cleaning files or starting the next encoder", async () => {
    holdEncoding = true;
    deferEncoderClose = true;
    const active = new AbortController();
    const first = prepareVideoForModel(source, { maxBytes: limit, signal: active.signal });
    const outcome = first.catch((error: unknown) => error);
    await vi.waitFor(() => expect(vi.mocked(execFile).mock.calls.some(([command]) => command === "ffmpeg")).toBe(true));
    holdEncoding = false;
    const next = prepareVideoForModel(source, { maxBytes: limit });
    active.abort();
    await vi.waitFor(() => expect(pendingCloses).toHaveLength(1));
    await expect(access(paths[0]!)).resolves.toBeUndefined();
    expect(vi.mocked(execFile).mock.calls.filter(([command]) => command === "ffmpeg")).toHaveLength(1);
    deferEncoderClose = false;
    pendingCloses.shift()!();
    expect(await outcome).toMatchObject({ code: "resource_read_aborted" });
    await expect(next).resolves.toEqual(Buffer.from(VIDEO_BYTES));
  });
});
