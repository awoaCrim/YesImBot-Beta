import { jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";
import type { ChannelResources } from "koishi-plugin-yesimbot";

const MAX_HTML_BYTES = 200_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

type HtmlRenderInput = { html: string; width?: number };

type HtmlRenderOutput = { ok: true; uri: string; mediaType: "image/png"; byteLength: number; sendMessageMarkup: string } | { ok: false; error: string };

type RenderResources = Pick<ChannelResources, "artifacts" | "maxBytes" | "detectImageMediaType">;

export function createHtmlRenderTool(url: string, resources: RenderResources): AgentTool<HtmlRenderInput, HtmlRenderOutput> {
  const endpoint = new URL(url);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("HTML renderer must use an HTTP(S) URL without credentials");
  }
  return {
    name: "render_html",
    description:
      "将完整 HTML 文档与内联 CSS 在独立后台浏览器中渲染为 PNG，不操作用户桌面，不执行脚本或加载外部资源。返回当前频道的图片 URI 和 sendMessageMarkup；这不是发送回执，随后须用 send_message 的 parts 发送一个 kind:text 单元，text 为该 sendMessageMarkup，使用默认 element 模式解析为图片，不能只回复 HTML、URI 或文字正文。",
    inputSchema: jsonSchema<HtmlRenderInput>({
      type: "object",
      properties: {
        html: { type: "string", minLength: 1, maxLength: MAX_HTML_BYTES, description: "完整 HTML 文档，包含 UTF-8 声明和内联样式；正文总大小不超过 200 KB" },
        width: { type: "integer", minimum: 480, maximum: 1440, description: "截图宽度，默认 1000 像素；高度按页面内容自动确定，最多 8000 像素" },
      },
      required: ["html"],
      additionalProperties: false,
    }),
    execute: async (input, execution) => {
      if (typeof input?.html !== "string" || !input.html.trim() || Buffer.byteLength(input.html) > MAX_HTML_BYTES) {
        return { ok: false, error: "invalid_html" };
      }
      const width = input.width ?? 1000;
      if (!Number.isSafeInteger(width) || width < 480 || width > 1440) return { ok: false, error: "invalid_width" };
      const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(execution.abortSignal ? [execution.abortSignal] : [])]);
      try {
        signal.throwIfAborted();
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ html: input.html, width }),
          redirect: "error",
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          return { ok: false, error: `renderer_http_${response.status}` };
        }
        if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "image/png" || !response.body) {
          await response.body?.cancel();
          return { ok: false, error: "invalid_renderer_image" };
        }
        const maxBytes = Math.min(resources.maxBytes, MAX_IMAGE_BYTES);
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            byteLength += value.byteLength;
            if (byteLength > maxBytes) {
              await reader.cancel();
              return { ok: false, error: "renderer_image_too_large" };
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const bytes = Buffer.concat(chunks, byteLength);
        if (resources.detectImageMediaType(bytes) !== "image/png") return { ok: false, error: "invalid_renderer_image" };
        signal.throwIfAborted();
        const uri = await resources.artifacts.forTool("render_html").put(bytes, { mediaType: "image/png", filename: "report.png" });
        return { ok: true, uri, mediaType: "image/png", byteLength, sendMessageMarkup: `<img src="${uri}"/>` };
      } catch {
        return { ok: false, error: execution.abortSignal?.aborted ? "aborted" : signal.aborted ? "renderer_timeout" : "html_render_failed" };
      }
    },
  };
}
