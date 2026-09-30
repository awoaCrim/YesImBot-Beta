import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import type { ChannelResources } from "koishi-plugin-yesimbot";

export const IMAGE_OUTPUT_LIMIT = 3;

export const IMAGE_PROMPT_MAX_LENGTH = 4000;

export type ImageToolErrorCode =
  | "provider_error"
  | "timeout"
  | "aborted"
  | "content_refused"
  | "empty_result"
  | "invalid_image"
  | "image_too_large"
  | "artifact_write_failed"
  | "image_budget_exhausted"
  | "invalid_source_uri"
  | "source_not_found"
  | "source_read_failed"
  | "source_too_large"
  | "invalid_source_image";

export type ImageToolResult =
  | {
      readonly ok: true;
      readonly model: string;
      readonly images: readonly ImageArtifactMetadata[];
      readonly sendMessageMarkup: readonly string[];
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ImageToolErrorCode;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

export type ImageToolResources = Pick<ChannelResources, "artifacts" | "maxBytes" | "detectImageMediaType">;

export interface ImageArtifactMetadata {
  readonly uri: string;
  readonly mediaType: string;
  readonly filename: string;
  readonly byteLength: number;
}

export class ImageOutputBudget {
  private readonly counts = new Map<string, number>();

  public reserve(turnId: string): boolean {
    const count = this.counts.get(turnId) ?? 0;
    if (count >= IMAGE_OUTPUT_LIMIT) return false;
    this.counts.set(turnId, count + 1);
    return true;
  }

  public release(turnId: string): void {
    const count = this.counts.get(turnId);
    if (count === undefined) return;
    if (count <= 1) this.counts.delete(turnId);
    else this.counts.set(turnId, count - 1);
  }

  public clearTurn(turnId: string): void {
    this.counts.delete(turnId);
  }

  public clearAll(): void {
    this.counts.clear();
  }
}

export class ImageCancellationError extends Error {
  public constructor(public readonly kind: "timeout" | "aborted") {
    super(kind);
  }
}

export async function runImageOperation<T>(options: {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly operation: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  if (options.signal?.aborted) throw new ImageCancellationError("aborted");
  const controller = new AbortController();
  let rejectCancelled!: (cause: ImageCancellationError) => void;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancelled = reject;
  });
  const onAbort = () => {
    controller.abort(options.signal?.reason);
    rejectCancelled(new ImageCancellationError("aborted"));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => {
      controller.abort(new Error("Image operation timed out"));
      rejectCancelled(new ImageCancellationError("timeout"));
    },
    Math.max(1, options.timeoutMs),
  );
  timeout.unref?.();

  try {
    const result = await Promise.race([options.operation(controller.signal), cancelled]);
    if (options.signal?.aborted) throw new ImageCancellationError("aborted");
    return result;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function validateImageBytes(
  bytes: unknown,
  resources: ImageToolResources,
): { readonly bytes: Uint8Array; readonly mediaType: string } | { readonly error: "invalid_image" | "image_too_large" } {
  if (!(bytes instanceof Uint8Array)) return { error: "invalid_image" };
  if (bytes.byteLength > resources.maxBytes) return { error: "image_too_large" };
  const mediaType = resources.detectImageMediaType(bytes);
  if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp") return { error: "invalid_image" };
  return { bytes, mediaType };
}

export function extensionFor(mediaType: string): "png" | "jpg" | "webp" {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  return "png";
}

export function imageToolFailure(code: ImageToolErrorCode, retryable?: boolean): ImageToolResult {
  const details = {
    provider_error: { message: "The image request failed at the provider.", retryable: retryable ?? true },
    timeout: { message: "The image request timed out.", retryable: true },
    aborted: { message: "The image request was aborted.", retryable: false },
    content_refused: { message: "The image request was refused by the provider.", retryable: false },
    empty_result: { message: "The provider returned no image.", retryable: true },
    invalid_image: { message: "The provider returned invalid image data.", retryable: true },
    image_too_large: { message: "The image exceeds the resource size limit.", retryable: false },
    artifact_write_failed: { message: "The image could not be saved.", retryable: true },
    image_budget_exhausted: {
      message: "This turn has reached the 3-image output limit. Send the best existing image with a brief note.",
      retryable: false,
    },
    invalid_source_uri: { message: "The source must be a current-channel asset or artifact URI.", retryable: false },
    source_not_found: { message: "The source image was not found in the current channel.", retryable: false },
    source_read_failed: { message: "The source image could not be read.", retryable: true },
    source_too_large: { message: "The source image exceeds the resource size limit.", retryable: false },
    invalid_source_image: { message: "The source resource is not a supported PNG, JPEG, or WebP image.", retryable: false },
  } as const;
  return { ok: false, error: { code, ...details[code] } };
}

export function imageToolModelOutput(imageProjection: EphemeralImageProjectionStore, toolCallId: string, output: ImageToolResult) {
  const image = imageProjection.get(toolCallId);
  return {
    type: "content" as const,
    value: [
      { type: "text" as const, text: JSON.stringify(output) },
      ...(image ? [{ type: "image-data" as const, data: Buffer.from(image.bytes).toString("base64"), mediaType: image.mediaType }] : []),
    ],
  };
}
