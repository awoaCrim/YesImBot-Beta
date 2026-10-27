import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import { imageSize } from "image-size";
import ipaddr from "ipaddr.js";

const MAX_REFERENCE_PIXELS = 40_000_000;

export type ReferenceDownloadErrorCode =
  | "invalid_url"
  | "unsafe_destination"
  | "dns_failed"
  | "too_many_redirects"
  | "timeout"
  | "aborted"
  | "download_failed"
  | "too_large"
  | "invalid_image";

export interface ReferenceHttpResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: AsyncIterable<Uint8Array>;
  cancel(): void;
}

export interface ReferenceDownloadSeams {
  readonly resolve?: (hostname: string) => Promise<readonly LookupAddress[]>;
  readonly request?: (url: URL, address: LookupAddress, signal: AbortSignal) => Promise<ReferenceHttpResponse>;
}

export interface ReferenceImage {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
}

export class ReferenceDownloadError extends Error {
  public constructor(public readonly code: ReferenceDownloadErrorCode) {
    super(code);
  }
}

export async function downloadReferenceImage(
  rawUrl: string,
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly seams?: ReferenceDownloadSeams;
  },
): Promise<ReferenceImage> {
  if (options.signal?.aborted) throw new ReferenceDownloadError("aborted");
  const controller = new AbortController();
  let activeResponse: ReferenceHttpResponse | undefined;
  let rejectCancelled!: (cause: ReferenceDownloadError) => void;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancelled = reject;
  });
  const cancel = (code: "timeout" | "aborted") => {
    controller.abort();
    rejectCancelled(new ReferenceDownloadError(code));
  };
  const onAbort = () => cancel("aborted");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => cancel("timeout"), options.timeoutMs);
  const assertActive = () => {
    if (controller.signal.aborted) throw new ReferenceDownloadError(options.signal?.aborted ? "aborted" : "timeout");
  };
  try {
    return await Promise.race([
      cancelled,
      (async () => {
        let url = parseReferenceUrl(rawUrl);
        for (let redirects = 0; redirects <= 3; redirects++) {
          assertActive();
          const hostname = url.hostname.replace(/^\[|\]$/g, "");
          let addresses: readonly LookupAddress[];
          try {
            addresses = isIP(hostname)
              ? [{ address: hostname, family: isIP(hostname) }]
              : await (options.seams?.resolve ?? ((host) => lookup(host, { all: true, verbatim: true })))(hostname);
          } catch {
            throw new ReferenceDownloadError("dns_failed");
          }
          assertActive();
          if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new ReferenceDownloadError("unsafe_destination");
          const response = await (options.seams?.request ?? requestImage)(url, addresses[0]!, controller.signal);
          activeResponse = response;
          try {
            assertActive();
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              if (redirects === 3) throw new ReferenceDownloadError("too_many_redirects");
              const location = response.headers.location;
              if (!location) throw new ReferenceDownloadError("download_failed");
              url = parseReferenceUrl(new URL(location, url).href);
              continue;
            }
            if (response.status < 200 || response.status >= 300) throw new ReferenceDownloadError("download_failed");
            const contentType = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
            if (contentType && !["image/png", "image/jpeg", "image/webp", "application/octet-stream"].includes(contentType))
              throw new ReferenceDownloadError("invalid_image");
            const length = Number(response.headers["content-length"]);
            if (Number.isFinite(length) && length > options.maxBytes) throw new ReferenceDownloadError("too_large");
            const chunks: Uint8Array[] = [];
            let total = 0;
            for await (const chunk of response.body) {
              assertActive();
              total += chunk.byteLength;
              if (total > options.maxBytes) throw new ReferenceDownloadError("too_large");
              chunks.push(chunk);
            }
            assertActive();
            if (Number.isFinite(length) && length >= 0 && total !== length) throw new ReferenceDownloadError("invalid_image");
            const bytes = new Uint8Array(Buffer.concat(chunks, total));
            const image = inspectImage(bytes);
            if (contentType && contentType !== "application/octet-stream" && contentType !== image.mediaType) throw new ReferenceDownloadError("invalid_image");
            return image;
          } finally {
            if (activeResponse === response) {
              activeResponse = undefined;
              response.cancel();
            }
          }
        }
        throw new ReferenceDownloadError("too_many_redirects");
      })(),
    ]);
  } catch (cause) {
    if (cause instanceof ReferenceDownloadError) throw cause;
    throw new ReferenceDownloadError("download_failed");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    const response = activeResponse;
    activeResponse = undefined;
    response?.cancel();
  }
}

function parseReferenceUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ReferenceDownloadError("invalid_url");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new ReferenceDownloadError("invalid_url");
  return url;
}

function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

function requestImage(url: URL, address: LookupAddress, signal: AbortSignal): Promise<ReferenceHttpResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    // Connect to the validated literal, preserving TLS identity without a second DNS lookup.
    const request = transport(
      {
        protocol: url.protocol,
        hostname: address.address,
        family: address.family,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: { host: url.host, accept: "image/png,image/jpeg,image/webp" },
        servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
        rejectUnauthorized: true,
        agent: false,
        signal,
      },
      (response) =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          cancel: () => {
            response.destroy();
          },
        }),
    );
    request.on("error", reject);
    request.end();
  });
}

function inspectImage(bytes: Uint8Array): ReferenceImage {
  const prefix = Buffer.from(bytes.subarray(0, 12));
  const mediaType = prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff
      ? "image/jpeg"
      : prefix.toString("ascii", 0, 4) === "RIFF" && prefix.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : undefined;
  if (!mediaType) throw new ReferenceDownloadError("invalid_image");
  try {
    const { width, height } = imageSize(bytes);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_REFERENCE_PIXELS)
      throw new Error("invalid_dimensions");
    return { bytes, mediaType, width, height };
  } catch {
    throw new ReferenceDownloadError("invalid_image");
  }
}
