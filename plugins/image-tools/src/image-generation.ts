import { EphemeralImageProjectionStore, jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
import { APICallError, generateImage, NoImageGeneratedError, type ImageModel } from "ai";
import type { ChannelResources } from "koishi-plugin-yesimbot";

import {
  classifySourceFailure,
  extensionFor,
  isImageSourceUri,
  ImageCancellationError,
  ImageOutputBudget,
  IMAGE_PROMPT_MAX_LENGTH,
  imageToolFailure,
  imageToolModelOutput,
  runImageOperation,
  validateImageBytes,
  type ImageToolResources,
  type ImageToolResult,
  type ImageOrientation,
} from "./image-output.js";
import { createOpenAIImageEditor, ImageEditTransportError } from "./image-transport.js";

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
    subjectType: {
      type: "string",
      enum: ["generic", "specific"],
      description: "generic：无特定身份的创作；specific：需要保持身份外观的具体人物、角色、商品或对象，必须提供参考图。不得用 generic 绕过参考图要求。",
    },
    referenceUris: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: { type: "string", minLength: 1 },
      description: "已核对的当前频道 asset:// 或 artifact:// 参考图，最多四张、总大小不超过资源上限。参考图像素将显式传到后端。",
    },
    orientation: {
      type: "string",
      enum: ["square", "landscape", "portrait"],
      description: "图片方向：square 方形（默认）、landscape 横向、portrait 纵向",
    },
  },
  required: ["prompt", "subjectType"],
  anyOf: [{ properties: { subjectType: { enum: ["generic"] } } }, { properties: { subjectType: { enum: ["specific"] } }, required: ["referenceUris"] }],
  additionalProperties: false,
});

export type ImageGenerationErrorCode = Exclude<ImageToolResult, { ok: true }>["error"]["code"];

export type GenerateImageToolResult = ImageToolResult;

export type ImageGenerator = (options: ImageGenerateOptions) => Promise<ImageGenerateResultLike>;

export interface GenerateImageToolOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly referenceModelId?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly imageModel: ImageModel;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly resources: ImageToolResources & Pick<ChannelResources, "openStrict">;
  readonly imageProjection?: EphemeralImageProjectionStore;
  readonly budget?: ImageOutputBudget;
  readonly generate?: ImageGenerator;
}

interface GenerateImageInput {
  readonly prompt: string;
  readonly subjectType: "generic" | "specific";
  readonly referenceUris?: readonly string[];
  readonly orientation?: ImageOrientation;
}

interface GeneratedImageLike {
  readonly uint8Array: Uint8Array;
  readonly mediaType?: string;
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
  readonly totalImages?: number;
}

export function createGenerateImageTool(options: GenerateImageToolOptions): AgentTool<GenerateImageInput, GenerateImageToolResult> {
  const writer = options.resources.artifacts.forTool("generate_image");
  const generate = options.generate ?? (generateImage as ImageGenerator);
  const imageProjection = options.imageProjection ?? new EphemeralImageProjectionStore();
  const budget = options.budget ?? new ImageOutputBudget();
  const referenceModelId = options.referenceModelId ?? options.modelId;
  const edit = createOpenAIImageEditor({ ...options, modelId: referenceModelId, maxBytes: options.resources.maxBytes });

  return {
    name: "generate_image",
    description: [
      "在当前频道生成一张图片，并保存为 artifact 资源。",
      "具体人物、角色、具名商品或需保持外观的特定对象必须用 specific，并提供已核对的 referenceUris；自拍指向当前角色时同样属于 specific，身份不明先澄清。通用场景才可用 generic，不得绕过参考图要求。",
      "优先使用频道已有参考图。公开对象缺图时使用已提供的图片搜索工具查找，导入后核对来源和实际图像；私人或自定义对象缺图、搜索失败或匹配含糊时请用户提供图片，不要纯文字硬生成。",
      "保留参考图中的稳定身份特征（如发长、发型轮廓、脸部和物体辨识细节），不要凭文字猜测改写；衣服、动作和背景可按场景变化。",
      "只有 referenceInput.includedInRequest 表示像素已随本次请求传出，不证明上游遵循参考图或结果已保持身份一致。实际宽高与方向校验不符时会警告，复查后决定重绘或说明偏差再发送。",
      "成功结果会自动附带图片像素。必须先实际查看并对照用户要求，再决定发送、编辑或重绘；未完成视觉检查前不得发送。",
      "局部问题优先使用 edit_image；构图或概念根本错误时重新生成。generate_image 与 edit_image 每轮合计最多输出 3 张图片。",
      "达到上限时不要继续生成或编辑，使用 send_message 发送已有最佳图片并简短说明限制。本工具不会直接发送消息。",
      "只可选择方向，不支持 quality、fallback、多图或任意尺寸。若 provider 拒绝内容，应向用户说明，不能尝试规避。",
    ].join("\n"),
    inputSchema: INPUT_SCHEMA,
    execute: async (input, execution) => {
      imageProjection.clear(execution.toolCallId);
      if (execution.abortSignal?.aborted) return imageToolFailure("aborted");
      if (input.subjectType !== "generic" && input.subjectType !== "specific") return imageToolFailure("invalid_input");
      if (input.referenceUris !== undefined && (!Array.isArray(input.referenceUris) || input.referenceUris.length < 1 || input.referenceUris.length > 4))
        return imageToolFailure("invalid_input");
      const referenceUris = input.referenceUris ?? [];
      if (input.subjectType === "specific" && referenceUris.length === 0) return imageToolFailure("reference_required");
      if (referenceUris.some((uri) => typeof uri !== "string" || !isImageSourceUri(uri))) return imageToolFailure("invalid_source_uri");
      if (input.orientation !== undefined && !Object.hasOwn(ORIENTATION_SIZE, input.orientation)) return imageToolFailure("invalid_input");
      const requestedOrientation = input.orientation ?? "square";
      if (!budget.reserve(execution.turnId)) return imageToolFailure("image_budget_exhausted");
      let committed = false;
      try {
        let generated: ImageGenerateResultLike | Extract<ImageToolResult, { ok: false }>;
        try {
          generated = await runImageOperation({
            timeoutMs: options.timeoutMs,
            signal: execution.abortSignal,
            operation: async (abortSignal) => {
              const sourceDataUrls: string[] = [];
              let totalBytes = 0;
              for (const uri of referenceUris) {
                let opened: Awaited<ReturnType<ChannelResources["openStrict"]>>;
                try {
                  opened = await options.resources.openStrict(uri, abortSignal);
                } catch (cause) {
                  return classifySourceFailure(cause);
                }
                abortSignal.throwIfAborted();
                const source = validateImageBytes(opened.bytes, options.resources);
                if ("error" in source) return imageToolFailure(source.error === "image_too_large" ? "source_too_large" : "invalid_source_image");
                totalBytes += source.bytes.byteLength;
                if (totalBytes > options.resources.maxBytes) return imageToolFailure("source_too_large");
                sourceDataUrls.push(`data:${source.mediaType};base64,${Buffer.from(source.bytes).toString("base64")}`);
              }
              if (sourceDataUrls.length > 0)
                return edit({ sourceDataUrls, prompt: input.prompt.trim(), size: ORIENTATION_SIZE[requestedOrientation], abortSignal });
              return generate({
                model: options.imageModel,
                prompt: input.prompt.trim(),
                n: 1,
                size: ORIENTATION_SIZE[requestedOrientation],
                maxRetries: 0,
                abortSignal,
              });
            },
          });
        } catch (cause) {
          if (cause instanceof ImageCancellationError) return imageToolFailure(cause.kind);
          if (cause instanceof ImageEditTransportError) return imageToolFailure(cause.code, cause.retryable);
          return classifyGenerationFailure(cause);
        }

        if ("ok" in generated) return generated;
        const image = generated.images[0];
        if (!image) return imageToolFailure("empty_result");
        const validated = validateImageBytes(image.uint8Array, options.resources);
        if ("error" in validated) return imageToolFailure(validated.error);
        const filename = `generated-1.${extensionFor(validated.mediaType)}`;
        if (execution.abortSignal?.aborted) return imageToolFailure("aborted");
        let uri: string;
        try {
          uri = await writer.put(validated.bytes, { mediaType: validated.mediaType, filename });
        } catch {
          return imageToolFailure(execution.abortSignal?.aborted ? "aborted" : "artifact_write_failed");
        }
        if (execution.abortSignal?.aborted) return imageToolFailure("aborted");
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
          model: referenceUris.length > 0 ? referenceModelId : options.modelId,
          images: [
            {
              uri,
              mediaType: validated.mediaType,
              filename,
              byteLength: validated.bytes.byteLength,
              width: validated.width,
              height: validated.height,
              orientation: validated.orientation,
            },
          ],
          referenceInput: { includedInRequest: referenceUris.length > 0, uris: [...referenceUris] },
          requestedOrientation,
          orientationMatches: validated.orientation === requestedOrientation,
          sendMessageMarkup: [`<img src="${uri}"/>`],
          warnings: [
            ...((generated.totalImages ?? generated.images.length) > 1 ? ["The provider returned multiple images; only the first was saved."] : []),
            ...(validated.orientation !== requestedOrientation
              ? [
                  `Requested orientation ${requestedOrientation}, but received ${validated.orientation} (${validated.width}x${validated.height}). Inspect and regenerate or disclose the mismatch before sending.`,
                ]
              : []),
          ],
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
