import { EphemeralImageProjectionStore, jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
import { ResourceReadError, type ChannelResources } from "koishi-plugin-yesimbot";

import {
  extensionFor,
  ImageCancellationError,
  ImageOutputBudget,
  IMAGE_PROMPT_MAX_LENGTH,
  imageToolFailure,
  imageToolModelOutput,
  runImageOperation,
  validateImageBytes,
  type ImageToolResources,
  type ImageToolResult,
} from "./image-output.js";

const INPUT_SCHEMA = jsonSchema<EditImageInput>({
  type: "object",
  properties: {
    uri: { type: "string", minLength: 1, description: "当前频道中的 artifact:// 或 asset:// 源图片 URI" },
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: IMAGE_PROMPT_MAX_LENGTH,
      pattern: "\\S",
      description: `对现有图片的精确修改指令，1-${IMAGE_PROMPT_MAX_LENGTH} 字符`,
    },
  },
  required: ["uri", "prompt"],
  additionalProperties: false,
});

export type EditImageToolResult = ImageToolResult;

export type ImageEditor = (options: ImageEditRequest) => Promise<ImageEditResponse>;

export interface EditImageToolOptions {
  readonly baseURL?: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly resources: ImageToolResources & Pick<ChannelResources, "openStrict">;
  readonly imageProjection?: EphemeralImageProjectionStore;
  readonly budget?: ImageOutputBudget;
  readonly fetch?: typeof globalThis.fetch;
  readonly edit?: ImageEditor;
}

interface EditImageInput {
  readonly uri: string;
  readonly prompt: string;
}

interface ImageEditRequest {
  readonly sourceDataUrl: string;
  readonly prompt: string;
  readonly abortSignal: AbortSignal;
}

interface ImageEditResponse {
  readonly images: readonly { readonly uint8Array: Uint8Array }[];
  readonly totalImages?: number;
}

class ImageEditTransportError extends Error {
  public constructor(
    public readonly code: "provider_error" | "content_refused" | "empty_result" | "invalid_image" | "image_too_large",
    public readonly retryable: boolean,
  ) {
    super(code);
  }
}

export function createEditImageTool(options: EditImageToolOptions): AgentTool<EditImageInput, EditImageToolResult> {
  const writer = options.resources.artifacts.forTool("edit_image");
  const imageProjection = options.imageProjection ?? new EphemeralImageProjectionStore();
  const budget = options.budget ?? new ImageOutputBudget();
  const edit = options.edit ?? createOpenAIImageEditor(options);

  return {
    name: "edit_image",
    description: [
      "对当前频道已有的 artifact:// 或 asset:// 图片进行局部修改，并把结果保存为新的不可变 artifact。",
      "用户消息中的 [图片：asset://<32 位十六进制 id>] 就是可编辑的当前频道图片；用户要求修改这张图时，将消息里的完整 URI 原样作为 uri 传入，不要猜测或改写 URI。",
      "成功结果会自动附带修改后的像素。必须实际复查后才能发送；不要只根据提示词、文件名或元数据判断。",
      "局部问题使用本工具；没有已有图片而需要全新创作时使用 generate_image。两者每轮合计最多输出 3 张图片。",
      "达到上限时发送已有最佳图片并简短说明限制，不要继续生成或编辑。本工具不会直接发送消息。",
    ].join("\n"),
    inputSchema: INPUT_SCHEMA,
    execute: async (input, execution) => {
      imageProjection.clear(execution.toolCallId);
      if (execution.abortSignal?.aborted) return imageToolFailure("aborted");
      if (!budget.reserve(execution.turnId)) return imageToolFailure("image_budget_exhausted");
      let committed = false;
      try {
        if (!input.uri.startsWith("asset://") && !input.uri.startsWith("artifact://")) return imageToolFailure("invalid_source_uri");
        let opened: Awaited<ReturnType<ChannelResources["openStrict"]>>;
        try {
          opened = await options.resources.openStrict(input.uri, execution.abortSignal);
        } catch (cause) {
          return classifySourceFailure(cause);
        }
        const source = validateImageBytes(opened.bytes, options.resources);
        if ("error" in source) return imageToolFailure(source.error === "image_too_large" ? "source_too_large" : "invalid_source_image");

        let edited: ImageEditResponse;
        try {
          edited = await runImageOperation({
            timeoutMs: options.timeoutMs,
            signal: execution.abortSignal,
            operation: (abortSignal) =>
              edit({
                sourceDataUrl: `data:${source.mediaType};base64,${Buffer.from(source.bytes).toString("base64")}`,
                prompt: input.prompt.trim(),
                abortSignal,
              }),
          });
        } catch (cause) {
          if (cause instanceof ImageCancellationError) return imageToolFailure(cause.kind);
          if (cause instanceof ImageEditTransportError) return imageToolFailure(cause.code, cause.retryable);
          return imageToolFailure("provider_error");
        }

        const image = edited.images[0];
        if (!image) return imageToolFailure("empty_result");
        const validated = validateImageBytes(image.uint8Array, options.resources);
        if ("error" in validated) return imageToolFailure(validated.error);
        const filename = `edited-1.${extensionFor(validated.mediaType)}`;
        let uri: string;
        try {
          uri = await writer.put(validated.bytes, { mediaType: validated.mediaType, filename });
        } catch {
          return imageToolFailure("artifact_write_failed");
        }
        committed = true;
        imageProjection.stage({
          toolCallId: execution.toolCallId,
          turnId: execution.turnId,
          bytes: validated.bytes,
          mediaType: validated.mediaType,
          signal: execution.abortSignal,
        });
        return {
          ok: true,
          model: options.modelId,
          images: [{ uri, mediaType: validated.mediaType, filename, byteLength: validated.bytes.byteLength }],
          sendMessageMarkup: [`<img src="${uri}"/>`],
          warnings: (edited.totalImages ?? edited.images.length) > 1 ? ["The provider returned multiple images; only the first was saved."] : [],
        };
      } finally {
        if (!committed) budget.release(execution.turnId);
      }
    },
    toModelOutput: ({ toolCallId, output }) => imageToolModelOutput(imageProjection, toolCallId, output),
  };
}

function createOpenAIImageEditor(options: EditImageToolOptions): ImageEditor {
  const endpoint = `${(options.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/images/edits`;
  const fetch = options.fetch ?? globalThis.fetch;
  return async ({ sourceDataUrl, prompt, abortSignal }) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: options.modelId,
        prompt,
        images: [{ image_url: sourceDataUrl }],
        n: 1,
        response_format: "b64_json",
      }),
      signal: abortSignal,
    });
    const maxResponseBytes = Math.ceil(options.resources.maxBytes / 3) * 4 + 65_536;
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
    const bytes = decodeBase64(encoded, options.resources.maxBytes);
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

function classifySourceFailure(cause: unknown): EditImageToolResult {
  const code =
    cause instanceof ResourceReadError
      ? cause.code
      : cause instanceof Error && cause.constructor.name === "ResourceReadError" && isRecord(cause) && typeof cause.code === "string"
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
