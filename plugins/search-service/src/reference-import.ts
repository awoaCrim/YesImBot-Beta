import { EphemeralImageProjectionStore, jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
import type { ChannelResources, ImagePreviewCapability } from "koishi-plugin-yesimbot";

import { downloadReferenceImage, ReferenceDownloadError, type ReferenceDownloadErrorCode, type ReferenceDownloadSeams } from "./reference-download.js";
import { normalizeHttpUrl } from "./utils.js";

type ImportReferenceResult =
  | {
      readonly ok: true;
      readonly uri: string;
      readonly mediaType: string;
      readonly width: number;
      readonly height: number;
      readonly byteLength: number;
      readonly source: { readonly imageUrl: string; readonly sourcePageUrl?: string };
      readonly inspection: { readonly mode: "native" | "vision"; readonly description?: string };
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: ReferenceDownloadErrorCode | "image_input_unavailable" | "artifact_write_failed"; readonly message: string };
    };

interface ImportReferenceInput {
  readonly imageUrl: string;
  readonly subject: string;
  readonly sourcePageUrl?: string;
}

export function createImportImageReferenceTool(options: {
  readonly resources: Pick<ChannelResources, "artifacts" | "maxBytes">;
  readonly imageProjection: EphemeralImageProjectionStore;
  readonly imagePreview?: ImagePreviewCapability;
  readonly timeoutMs: number;
  readonly seams?: ReferenceDownloadSeams;
}): AgentTool<ImportReferenceInput, ImportReferenceResult> {
  const writer = options.resources.artifacts.forTool("import_image_reference");
  const failure = (code: Extract<ImportReferenceResult, { ok: false }>["error"]["code"]): ImportReferenceResult => ({
    ok: false,
    error: {
      code,
      message:
        "Reference import or visual inspection failed. Do not claim a verified match; ask for a usable image or clarification when no reliable candidate is available.",
    },
  });
  return {
    name: "import_image_reference",
    description:
      "Download a selected public image candidate into this channel and expose its actual content for inspection. Supply the intended subject and known source page; inspect pixels and source context, not just titles. Success makes content available, NOT verified identity. Use the returned artifact URI for generate_image references; never send a private/custom identity to public search or invent missing sources. This tool does not generate or send images.",
    inputSchema: jsonSchema<ImportReferenceInput>({
      type: "object",
      properties: {
        imageUrl: { type: "string", minLength: 1, maxLength: 4096 },
        subject: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        sourcePageUrl: { type: "string", minLength: 1, maxLength: 4096 },
      },
      required: ["imageUrl", "subject"],
      additionalProperties: false,
    }),
    execute: async (input, execution) => {
      options.imageProjection.clear(execution.toolCallId);
      if (execution.abortSignal?.aborted) return failure("aborted");
      const imageUrl = normalizeHttpUrl(input.imageUrl);
      const sourcePageUrl = input.sourcePageUrl === undefined ? undefined : normalizeHttpUrl(input.sourcePageUrl);
      if (!imageUrl || imageUrl.length > 4096 || !input.subject.trim() || input.subject.length > 200 || (input.sourcePageUrl !== undefined && !sourcePageUrl))
        return failure("invalid_url");
      const capability = options.imagePreview;
      if (!capability || capability.mode === "unavailable") return failure("image_input_unavailable");
      try {
        const image = await downloadReferenceImage(imageUrl, {
          signal: execution.abortSignal,
          timeoutMs: options.timeoutMs,
          maxBytes: options.resources.maxBytes,
          seams: options.seams,
        });
        if (execution.abortSignal?.aborted) return failure("aborted");
        const frames = [{ bytes: image.bytes, mediaType: image.mediaType, label: "Candidate reference image" }];
        let inspection: Extract<ImportReferenceResult, { ok: true }>["inspection"];
        if (capability.mode === "native") {
          const preview = capability.preview({ toolCallId: execution.toolCallId, turnId: execution.turnId, frames, signal: execution.abortSignal });
          if (preview.mode !== "native") return failure("image_input_unavailable");
          inspection = { mode: "native" };
        } else {
          const description = await capability.describe({
            frames,
            question: `描述可见的稳定形象特征，并说明能否确认与目标“${input.subject}”相符；不能从来源标题推断画面内容，无法确认身份时明确指出。`,
            signal: execution.abortSignal,
          });
          if (execution.abortSignal?.aborted) return failure("aborted");
          if (!description?.trim()) return failure("image_input_unavailable");
          inspection = { mode: "vision", description: description.trim().slice(0, 6000) };
        }
        let uri: string;
        try {
          uri = await writer.put(image.bytes, {
            mediaType: image.mediaType,
            filename: `reference.${image.mediaType === "image/jpeg" ? "jpg" : image.mediaType === "image/webp" ? "webp" : "png"}`,
          });
        } catch {
          options.imageProjection.clear(execution.toolCallId);
          return failure("artifact_write_failed");
        }
        if (execution.abortSignal?.aborted) {
          options.imageProjection.clear(execution.toolCallId);
          return failure("aborted");
        }
        return {
          ok: true,
          uri,
          mediaType: image.mediaType,
          width: image.width,
          height: image.height,
          byteLength: image.bytes.byteLength,
          source: { imageUrl, ...(sourcePageUrl ? { sourcePageUrl } : {}) },
          inspection,
        };
      } catch (cause) {
        options.imageProjection.clear(execution.toolCallId);
        return failure(cause instanceof ReferenceDownloadError ? cause.code : "image_input_unavailable");
      }
    },
    toModelOutput: ({ toolCallId, output }) => ({
      type: "content",
      value: [
        { type: "text", text: JSON.stringify(output) },
        ...(output.ok && output.inspection.mode === "native"
          ? options.imageProjection
              .getFrames(toolCallId)
              .map((frame) => ({ type: "image-data" as const, data: Buffer.from(frame.bytes).toString("base64"), mediaType: frame.mediaType }))
          : []),
      ],
    }),
  };
}
