import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3Message,
  LanguageModelV3Middleware,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider";

export const imageToolResultUserMessageMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) => ({
    ...params,
    prompt: promoteImageToolResultsToUserMessages(params.prompt),
  }),
};

type ToolResultContentPart = Extract<LanguageModelV3ToolResultOutput, { type: "content" }>["value"][number];

export function promoteImageToolResultsToUserMessages(prompt: LanguageModelV3Prompt): LanguageModelV3Prompt {
  const transformed: LanguageModelV3Prompt = [];

  for (const sourceMessage of prompt) {
    if (sourceMessage.role !== "tool") {
      transformed.push(cloneMessage(sourceMessage));
      continue;
    }

    let content: typeof sourceMessage.content = [];
    for (const sourcePart of sourceMessage.content) {
      if (sourcePart.type !== "tool-result") {
        content.push({ ...sourcePart });
        continue;
      }

      const output = cloneToolResultOutput(sourcePart.output);
      if (output.type !== "content") {
        content.push({ ...sourcePart, output });
        continue;
      }

      const promotedImages: LanguageModelV3FilePart[] = [];
      const retained: typeof output.value = [];
      for (const part of output.value) {
        const image = promoteImagePart(part);
        if (image === undefined) retained.push(part);
        else if (image !== null) promotedImages.push(image);
      }

      if (retained.length === output.value.length) {
        content.push({ ...sourcePart, output });
        continue;
      }

      const value: typeof output.value =
        retained.length > 0
          ? retained
          : [
              {
                type: "text",
                text: promotedImages.length > 0 ? "[Image attached in the following user message.]" : "[Image URL could not be safely promoted.]",
              },
            ];
      content.push({ ...sourcePart, output: { ...output, value } });

      if (promotedImages.length > 0) {
        transformed.push({ ...sourceMessage, content });
        transformed.push({ role: "user", content: promotedImages });
        content = [];
      }
    }

    if (content.length > 0 || sourceMessage.content.length === 0) transformed.push({ ...sourceMessage, content });
  }

  return transformed;
}

export function withUserMessageImageToolResults(model: LanguageModelV3): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(params) {
      return model.doGenerate(await transformCallParams(model, params, "generate"));
    },
    async doStream(params) {
      return model.doStream(await transformCallParams(model, params, "stream"));
    },
  };
}

function cloneMessage(message: LanguageModelV3Message): LanguageModelV3Message {
  if (message.role === "system") return { ...message };
  return { ...message, content: message.content.map((part) => ({ ...part })) } as LanguageModelV3Message;
}

function cloneToolResultOutput(output: LanguageModelV3ToolResultOutput): LanguageModelV3ToolResultOutput {
  if (output.type !== "content") return { ...output };
  return { ...output, value: output.value.map((part) => ({ ...part })) };
}

function promoteImagePart(part: ToolResultContentPart): LanguageModelV3FilePart | null | undefined {
  if (part.type === "image-data") {
    return {
      type: "file",
      data: part.data,
      mediaType: part.mediaType,
      providerOptions: part.providerOptions,
    };
  }
  if (part.type === "image-url") {
    const data = parseSafeImageUrl(part.url);
    if (!data) return null;
    return {
      type: "file",
      data,
      mediaType: "image/*",
      providerOptions: part.providerOptions,
    };
  }
  return undefined;
}

function parseSafeImageUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "data:") return value.toLowerCase().startsWith("data:image/") ? url : undefined;
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) return url;
  } catch {
    // Invalid and non-absolute image URLs must not break the provider call.
  }
  return undefined;
}

async function transformCallParams(model: LanguageModelV3, params: LanguageModelV3CallOptions, type: "generate" | "stream") {
  return imageToolResultUserMessageMiddleware.transformParams!({ model, params, type });
}
