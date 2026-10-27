import { EphemeralImageProjectionStore } from "@yesimbot/agent-runtime";
import { imageSize } from "image-size";
import { ResourceReadError, type ChannelResources } from "koishi-plugin-yesimbot";

export const IMAGE_OUTPUT_LIMIT = 3;

export const IMAGE_PROMPT_MAX_LENGTH = 4000;

const MAX_OUTPUT_OR_REFERENCE_PIXELS = 40_000_000;

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
  | "invalid_source_image"
  | "invalid_input"
  | "reference_required";

export type ImageToolResult =
  | {
      readonly ok: true;
      readonly model: string;
      readonly images: readonly ImageArtifactMetadata[];
      readonly sendMessageMarkup: readonly string[];
      readonly warnings: readonly string[];
      readonly referenceInput?: { readonly includedInRequest: boolean; readonly uris: readonly string[] };
      readonly requestedOrientation?: ImageOrientation;
      readonly orientationMatches?: boolean;
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

export type ImageOrientation = "square" | "landscape" | "portrait";

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
  readonly orientation: ImageOrientation;
}

export interface ImageArtifactMetadata extends ImageDimensions {
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
): ({ readonly bytes: Uint8Array; readonly mediaType: string } & ImageDimensions) | { readonly error: "invalid_image" | "image_too_large" } {
  if (!(bytes instanceof Uint8Array)) return { error: "invalid_image" };
  if (bytes.byteLength > resources.maxBytes) return { error: "image_too_large" };
  const mediaType = resources.detectImageMediaType(bytes);
  if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp") return { error: "invalid_image" };
  try {
    const { width, height } = imageSize(bytes);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_OUTPUT_OR_REFERENCE_PIXELS)
      return { error: "invalid_image" };
    return { bytes, mediaType, width, height, orientation: width === height ? "square" : width > height ? "landscape" : "portrait" };
  } catch {
    return { error: "invalid_image" };
  }
}

export function classifySourceFailure(cause: unknown): Extract<ImageToolResult, { ok: false }> {
  const code =
    cause instanceof ResourceReadError
      ? cause.code
      : cause instanceof Error && cause.constructor.name === "ResourceReadError" && "code" in cause && typeof cause.code === "string"
        ? cause.code
        : undefined;
  switch (code) {
    case "invalid_resource_uri":
      return imageToolFailure("invalid_source_uri");
    case "resource_not_found":
      return imageToolFailure("source_not_found");
    case "resource_too_large":
      return imageToolFailure("source_too_large");
    case "resource_read_aborted":
      return imageToolFailure("aborted");
    case "timeout":
      return imageToolFailure("timeout");
    default:
      return imageToolFailure("source_read_failed");
  }
}

export function isImageSourceUri(uri: string): boolean {
  return (uri.startsWith("asset://") || uri.startsWith("artifact://")) && !uri.startsWith("artifact://sticker/");
}

export function extensionFor(mediaType: string): "png" | "jpg" | "webp" {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  return "png";
}

export function imageToolFailure(code: ImageToolErrorCode, retryable?: boolean): Extract<ImageToolResult, { ok: false }> {
  const details = {
    invalid_input: { message: "Declare subjectType as generic or specific and supply at most four reference URIs.", retryable: false },
    reference_required: {
      message:
        "Specific subjects require reference images. Find and inspect a reliable public reference, or ask the user for an image. Do not fall back to text-only generation.",
      retryable: false,
    },
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
