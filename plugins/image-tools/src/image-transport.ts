export type ImageEditor = (options: ImageEditRequest) => Promise<ImageEditResponse>;

export interface ImageEditRequest {
  readonly sourceDataUrls: readonly string[];
  readonly prompt: string;
  readonly size?: string;
  readonly abortSignal: AbortSignal;
}

export interface ImageEditResponse {
  readonly images: readonly { readonly uint8Array: Uint8Array }[];
  readonly totalImages?: number;
}

interface ImageTransportOptions {
  readonly baseURL?: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly maxBytes: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class ImageEditTransportError extends Error {
  public constructor(
    public readonly code: "provider_error" | "content_refused" | "empty_result" | "invalid_image" | "image_too_large",
    public readonly retryable: boolean,
  ) {
    super(code);
  }
}

export function createOpenAIImageEditor(options: ImageTransportOptions): ImageEditor {
  const endpoint = `${(options.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/images/edits`;
  const fetch = options.fetch ?? globalThis.fetch;
  return async ({ sourceDataUrls, prompt, size, abortSignal }) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: options.modelId,
        prompt,
        images: sourceDataUrls.map((image_url) => ({ image_url })),
        ...(size ? { size } : {}),
        n: 1,
        response_format: "b64_json",
      }),
      signal: abortSignal,
    });
    const maxResponseBytes = Math.ceil(options.maxBytes / 3) * 4 + 65_536;
    const text = await readBoundedResponseText(response, maxResponseBytes);
    if (!response.ok) {
      if (containsContentRefusal(text)) throw new ImageEditTransportError("content_refused", false);
      throw new ImageEditTransportError("provider_error", response.status === 429 || response.status >= 500);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ImageEditTransportError("provider_error", false);
    }
    const data = isRecord(value) && Array.isArray(value.data) ? value.data : [];
    if (data.length === 0) throw new ImageEditTransportError("empty_result", true);
    const encoded = readImageBase64(data[0]);
    const bytes = decodeBase64(encoded, options.maxBytes);
    return { images: [{ uint8Array: bytes }], totalImages: data.length };
  };
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ImageEditTransportError("image_too_large", false);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function readImageBase64(value: unknown): string {
  if (!isRecord(value)) throw new ImageEditTransportError("invalid_image", true);
  if (typeof value.b64_json === "string" && value.b64_json.length > 0) return value.b64_json;
  if (typeof value.url === "string") {
    const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=]+)$/i.exec(value.url);
    if (match?.[1]) return match[1];
  }
  throw new ImageEditTransportError("empty_result", true);
}

function decodeBase64(value: string, maxBytes: number): Uint8Array {
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new ImageEditTransportError("image_too_large", false);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ImageEditTransportError("invalid_image", true);
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (bytes.byteLength > maxBytes) throw new ImageEditTransportError("image_too_large", false);
  return bytes;
}

function containsContentRefusal(value: string): boolean {
  return /content[ _-]?policy|safety|moderation|refus(?:e|ed|al)|blocked|disallowed|unsafe/i.test(value.slice(0, 4096));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
