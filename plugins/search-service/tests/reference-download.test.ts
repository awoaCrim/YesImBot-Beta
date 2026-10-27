import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: transport.request }));

import { PNG_BYTES } from "../../image-tools/tests/helpers.js";
import { downloadReferenceImage, type ReferenceHttpResponse } from "../src/reference-download.js";

const ADDRESS = { address: "93.184.216.34", family: 4 };
const options = { timeoutMs: 1000, maxBytes: 1024 };

function response(bytes = PNG_BYTES, overrides: Partial<ReferenceHttpResponse> = {}): ReferenceHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) },
    body: Readable.from([bytes]),
    cancel: vi.fn(),
    ...overrides,
  };
}

function fixture(reply = response()) {
  const resolve = vi.fn(async (_hostname: string) => [ADDRESS]);
  const request = vi.fn(async (_url: URL, _address: typeof ADDRESS, _signal: AbortSignal) => reply);
  return { resolve, request, seams: { resolve, request } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("bounded public reference downloads", () => {
  it("connects to a validated literal without a second lookup, preserving Host and TLS identity", async () => {
    transport.request.mockImplementation((requestOptions, onResponse) =>
      Object.assign(new EventEmitter(), {
        end() {
          onResponse(Object.assign(Readable.from([PNG_BYTES]), { statusCode: 200, headers: { "content-type": "image/png" } }));
        },
      }),
    );
    const resolve = vi.fn(async () => [ADDRESS]);
    const image = await downloadReferenceImage("https://images.example/a.png?token=not-logged", { ...options, seams: { resolve } });
    expect(image).toMatchObject({ width: 1, height: 1, mediaType: "image/png", bytes: PNG_BYTES });
    expect(resolve).toHaveBeenCalledOnce();
    expect(transport.request).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: ADDRESS.address,
        family: 4,
        servername: "images.example",
        headers: { host: "images.example", accept: "image/png,image/jpeg,image/webp" },
        path: "/a.png?token=not-logged",
        rejectUnauthorized: true,
        agent: false,
      }),
      expect.any(Function),
    );
    expect(JSON.stringify(transport.request.mock.calls[0]?.[0])).not.toMatch(/Authorization|Cookie/);
  });

  it.each(["file:///etc/passwd", "data:image/png;base64,AA==", "ftp://images.example/a.png", "https://user:password@images.example/a.png", "not-a-url"])(
    "rejects URL %s without network access",
    async (url) => {
      const f = fixture();
      await expect(downloadReferenceImage(url, { ...options, seams: f.seams })).rejects.toMatchObject({ code: "invalid_url" });
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "[::1]",
    "[fc00::1]",
    "[fe80::1]",
    "[::ffff:127.0.0.1]",
    "[2001:db8::1]",
    "[64:ff9b::7f00:1]",
  ])("rejects non-public destination %s", async (host) => {
    const f = fixture();
    await expect(downloadReferenceImage(`http://${host}/a.png`, { ...options, seams: f.seams })).rejects.toMatchObject({ code: "unsafe_destination" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rejects a mixed public/private DNS answer set", async () => {
    const f = fixture();
    f.resolve.mockResolvedValue([ADDRESS, { address: "10.0.0.1", family: 4 }]);
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, seams: f.seams })).rejects.toMatchObject({ code: "unsafe_destination" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("revalidates redirect destinations before connection", async () => {
    const redirect = response(PNG_BYTES, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    const f = fixture(redirect);
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, seams: f.seams })).rejects.toMatchObject({ code: "unsafe_destination" });
    expect(f.request).toHaveBeenCalledOnce();
    expect(redirect.cancel).toHaveBeenCalledOnce();
  });

  it("follows bounded public redirects with a freshly pinned address per host", async () => {
    const redirect = response(PNG_BYTES, { status: 302, headers: { location: "https://cdn.example/a.png" } });
    const f = fixture(redirect);
    f.request.mockResolvedValueOnce(redirect).mockResolvedValueOnce(response());
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, seams: f.seams })).resolves.toMatchObject({ width: 1, height: 1 });
    expect(f.resolve.mock.calls.map(([host]) => host)).toEqual(["images.example", "cdn.example"]);
    const loop = fixture(redirect);
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, seams: loop.seams })).rejects.toMatchObject({
      code: "too_many_redirects",
    });
    expect(loop.request).toHaveBeenCalledTimes(4);
  });

  it("enforces streamed bytes without trusting Content-Length", async () => {
    const reply = response(PNG_BYTES, { headers: {}, body: Readable.from([PNG_BYTES, PNG_BYTES]) });
    const f = fixture(reply);
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, maxBytes: PNG_BYTES.byteLength, seams: f.seams })).rejects.toMatchObject({
      code: "too_large",
    });
    expect(reply.cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { headers: { "content-type": "text/html" } },
    { headers: { "content-type": "image/jpeg" } },
    { headers: { "content-type": "image/gif" } },
    { body: Readable.from([PNG_BYTES.subarray(0, 8)]), headers: {} },
    { headers: { "content-length": "1" } },
    { status: 404 },
  ])("rejects invalid content or status before returning an image: %j", async (overrides) => {
    const reply = response(PNG_BYTES, overrides);
    const f = fixture(reply);
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, seams: f.seams })).rejects.toMatchObject({
      code: expect.stringMatching(/invalid_image|download_failed/),
    });
    expect(reply.cancel).toHaveBeenCalled();
  });

  it("rejects declared overflow before reading a response body", async () => {
    const body = { [Symbol.asyncIterator]: vi.fn() };
    const reply = response(PNG_BYTES, { headers: { "content-length": "999999" }, body });
    const f = fixture(reply);
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, seams: f.seams })).rejects.toMatchObject({ code: "too_large" });
    expect(body[Symbol.asyncIterator]).not.toHaveBeenCalled();
  });

  it("bounds slow DNS and never connects after a late resolution", async () => {
    vi.useFakeTimers();
    let finish!: (value: (typeof ADDRESS)[]) => void;
    const f = fixture();
    f.resolve.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = downloadReferenceImage("https://images.example/a.png", { ...options, seams: f.seams }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await result).toMatchObject({ code: "timeout" });
    finish([ADDRESS]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("cancels late headers and does not accept a late successful body", async () => {
    vi.useFakeTimers();
    let finish!: (value: ReferenceHttpResponse) => void;
    const f = fixture();
    f.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = downloadReferenceImage("https://images.example/a.png", { ...options, seams: f.seams }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await result).toMatchObject({ code: "timeout" });
    const late = response();
    finish(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.cancel).toHaveBeenCalledOnce();
  });

  it("bounds a stalled body and proactively cancels it", async () => {
    vi.useFakeTimers();
    const reply = response(PNG_BYTES, {
      headers: {},
      body: {
        async *[Symbol.asyncIterator]() {
          yield PNG_BYTES.subarray(0, 8);
          await new Promise(() => undefined);
        },
      },
    });
    const f = fixture(reply);
    const result = downloadReferenceImage("https://images.example/a.png", { ...options, seams: f.seams }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await result).toMatchObject({ code: "timeout" });
    expect(reply.cancel).toHaveBeenCalledOnce();
  });

  it("honors pre-abort and live cancellation without accepting partial pixels", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fixture();
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, signal: controller.signal, seams: f.seams })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(f.resolve).not.toHaveBeenCalled();
    const live = new AbortController();
    const reply = response(PNG_BYTES, {
      headers: {},
      body: {
        async *[Symbol.asyncIterator]() {
          yield PNG_BYTES.subarray(0, 8);
          live.abort();
        },
      },
    });
    const active = fixture(reply);
    await expect(downloadReferenceImage("https://images.example/a.png", { ...options, signal: live.signal, seams: active.seams })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(reply.cancel).toHaveBeenCalledOnce();
  });
});
