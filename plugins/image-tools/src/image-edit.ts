import { EphemeralImageProjectionStore, jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
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
} from "./image-output.js";
import { createOpenAIImageEditor, ImageEditTransportError, type ImageEditor, type ImageEditResponse } from "./image-transport.js";

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

export function createEditImageTool(options: EditImageToolOptions): AgentTool<EditImageInput, EditImageToolResult> {
  const writer = options.resources.artifacts.forTool("edit_image");
  const imageProjection = options.imageProjection ?? new EphemeralImageProjectionStore();
  const budget = options.budget ?? new ImageOutputBudget();
  const edit = options.edit ?? createOpenAIImageEditor({ ...options, maxBytes: options.resources.maxBytes });

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
        if (!isImageSourceUri(input.uri)) return imageToolFailure("invalid_source_uri");
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
                sourceDataUrls: [`data:${source.mediaType};base64,${Buffer.from(source.bytes).toString("base64")}`],
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
          model: options.modelId,
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
