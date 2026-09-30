import { EphemeralImageProjectionStore, jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
import { APICallError, generateImage, NoImageGeneratedError, type ImageModel } from "ai";

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

export const DEFAULT_IMAGE_TIMEOUT_SECONDS = 120;

const ORIENTATION_SIZE = {
  square: "1024x1024",
  landscape: "1536x1024",
  portrait: "1024x1536",
} as const;
const INPUT_SCHEMA = jsonSchema<GenerateImageInput>({
  type: "object",
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: IMAGE_PROMPT_MAX_LENGTH,
      pattern: "\\S",
      description: `图片内容提示词，1-${IMAGE_PROMPT_MAX_LENGTH} 字符`,
    },
    orientation: {
      type: "string",
      enum: ["square", "landscape", "portrait"],
      description: "图片方向：square 方形（默认）、landscape 横向、portrait 纵向",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
});

export type ImageOrientation = keyof typeof ORIENTATION_SIZE;

export type ImageGenerationErrorCode = Exclude<ImageToolResult, { ok: true }>["error"]["code"];

export type GenerateImageToolResult = ImageToolResult;

export type ImageGenerator = (options: ImageGenerateOptions) => Promise<ImageGenerateResultLike>;

export interface ImageGenerationConfig {
  readonly enabled?: boolean;
  readonly model?: string;
  readonly editModel?: string;
  readonly timeout?: number;
}

export interface GenerateImageToolOptions {
  readonly imageModel: ImageModel;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly resources: ImageToolResources;
  readonly imageProjection?: EphemeralImageProjectionStore;
  readonly budget?: ImageOutputBudget;
  readonly generate?: ImageGenerator;
}

interface GenerateImageInput {
  readonly prompt: string;
  readonly orientation?: ImageOrientation;
}

interface GeneratedImageLike {
  readonly uint8Array: Uint8Array;
  readonly mediaType: string;
}

interface ImageGenerateOptions {
  readonly model: ImageModel;
  readonly prompt: string;
  readonly n: 1;
  readonly size: (typeof ORIENTATION_SIZE)[ImageOrientation];
  readonly maxRetries: 0;
  readonly abortSignal: AbortSignal;
}

interface ImageGenerateResultLike {
  readonly images: readonly GeneratedImageLike[];
}

export function createGenerateImageTool(options: GenerateImageToolOptions): AgentTool<GenerateImageInput, GenerateImageToolResult> {
  const writer = options.resources.artifacts.forTool("generate_image");
  const generate = options.generate ?? (generateImage as ImageGenerator);
  const imageProjection = options.imageProjection ?? new EphemeralImageProjectionStore();
  const budget = options.budget ?? new ImageOutputBudget();

  return {
    name: "generate_image",
    description: [
      "根据文本提示在当前频道生成一张图片，并保存为 artifact 资源。",
      "成功结果会自动附带图片像素。必须先实际查看并对照用户要求，再决定发送、编辑或重绘；未完成视觉检查前不得发送。",
      "局部问题优先使用 edit_image；构图或概念根本错误时重新生成。generate_image 与 edit_image 每轮合计最多输出 3 张图片。",
      "达到上限时不要继续生成或编辑，使用 send_message 发送已有最佳图片并简短说明限制。本工具不会直接发送消息。",
      "只可选择方向，不支持 quality、fallback、多图或任意尺寸。若 provider 拒绝内容，应向用户说明，不能尝试规避。",
    ].join("\n"),
    inputSchema: INPUT_SCHEMA,
    execute: async (input, execution) => {
      imageProjection.clear(execution.toolCallId);
      if (execution.abortSignal?.aborted) return imageToolFailure("aborted");
      if (!budget.reserve(execution.turnId)) return imageToolFailure("image_budget_exhausted");
      let committed = false;
      try {
        let generated: ImageGenerateResultLike;
        try {
          generated = await runImageOperation({
            timeoutMs: options.timeoutMs,
            signal: execution.abortSignal,
            operation: (abortSignal) =>
              generate({
                model: options.imageModel,
                prompt: input.prompt.trim(),
                n: 1,
                size: ORIENTATION_SIZE[input.orientation ?? "square"],
                maxRetries: 0,
                abortSignal,
              }),
          });
        } catch (cause) {
          if (cause instanceof ImageCancellationError) return imageToolFailure(cause.kind);
          return classifyGenerationFailure(cause);
        }

        const image = generated.images[0];
        if (!image) return imageToolFailure("empty_result");
        const validated = validateImageBytes(image.uint8Array, options.resources);
        if ("error" in validated) return imageToolFailure(validated.error);
        const filename = `generated-1.${extensionFor(validated.mediaType)}`;
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
          warnings: generated.images.length > 1 ? ["The provider returned multiple images; only the first was saved."] : [],
        };
      } finally {
        if (!committed) budget.release(execution.turnId);
      }
    },
    toModelOutput: ({ toolCallId, output }) => imageToolModelOutput(imageProjection, toolCallId, output),
  };
}

function classifyGenerationFailure(cause: unknown): GenerateImageToolResult {
  if (containsContentRefusal(cause)) return imageToolFailure("content_refused");
  if (NoImageGeneratedError.isInstance(cause)) return imageToolFailure("empty_result");
  const apiError = findApiCallError(cause);
  return imageToolFailure("provider_error", apiError?.isRetryable ?? true);
}

function findApiCallError(cause: unknown): APICallError | undefined {
  let current = cause;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (APICallError.isInstance(current)) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function containsContentRefusal(cause: unknown): boolean {
  const refusal = /content[ _-]?policy|safety|moderation|refus(?:e|ed|al)|blocked|disallowed|unsafe/i;
  let current = cause;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && refusal.test(current.message.slice(0, 4096))) return true;
    if (APICallError.isInstance(current)) {
      if (typeof current.responseBody === "string" && refusal.test(current.responseBody.slice(0, 4096))) return true;
      try {
        if (current.data !== undefined && refusal.test(JSON.stringify(current.data).slice(0, 4096))) return true;
      } catch {}
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}
