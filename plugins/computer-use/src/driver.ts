import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

import type { ComputerAction, ComputerDriver, ComputerScreenshot } from "./types.js";

const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_LENGTH = 4_000;
const MAX_KEYS = 12;
const MAX_DRAG_POINTS = 128;
const REQUIRED_TOOLS = ["desktop_get_screenshot", "desktop_move", "desktop_click", "desktop_drag", "desktop_type", "desktop_key", "desktop_scroll"] as const;

export interface McpDesktopDriverOptions {
  readonly endpoint: string;
  readonly connectTimeoutMs?: number;
}

export class McpDesktopDriver implements ComputerDriver {
  private client: Client | undefined;
  private transport: SSEClientTransport | undefined;
  private connecting: Promise<void> | undefined;

  public constructor(private readonly options: McpDesktopDriverOptions) {}

  public async execute(actions: readonly ComputerAction[], signal: AbortSignal): Promise<ComputerScreenshot> {
    await this.ensureConnected(signal);
    for (const action of actions) {
      if (signal.aborted) throw new DOMException("The desktop action was aborted.", "AbortError");
      if (action.type === "screenshot") {
        await this.screenshot(signal);
        continue;
      }
      if (action.type === "wait") {
        await sleep(750, signal);
        continue;
      }
      await this.executeAction(action, signal);
    }
    // The Responses computer contract requires a fresh screenshot after the whole ordered batch,
    // even when the model did not include an explicit screenshot action.
    return await this.screenshot(signal);
  }

  public async close(): Promise<void> {
    this.connecting = undefined;
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    await Promise.allSettled([client?.close(), transport?.close()]);
  }

  private async ensureConnected(signal: AbortSignal): Promise<void> {
    if (this.client) return;
    if (this.connecting) return await raceAbort(this.connecting, signal);

    const task = (async () => {
      const endpoint = parseEndpoint(this.options.endpoint);
      const transport = new SSEClientTransport(endpoint);
      const client = new Client({ name: "yesimbot-computer-use", version: "0.0.1" });
      try {
        await raceAbort(client.connect(transport), signal, this.options.connectTimeoutMs ?? 10_000);
        const listed = await raceAbort(client.listTools(), signal, this.options.connectTimeoutMs ?? 10_000);
        const names = new Set((listed.tools ?? []).map((tool) => tool.name));
        for (const name of REQUIRED_TOOLS) {
          if (!names.has(name)) throw new Error(`computer-use MCP server 缺少工具 ${name}`);
        }
        this.client = client;
        this.transport = transport;
      } catch (cause) {
        await Promise.allSettled([client.close(), transport.close()]);
        throw new Error(`无法连接 Anon 桌面 MCP 服务：${safeErrorMessage(cause)}`);
      }
    })();
    this.connecting = task;
    try {
      await task;
    } finally {
      if (this.connecting === task) this.connecting = undefined;
    }
  }

  private async executeAction(action: Exclude<ComputerAction, { type: "screenshot" | "wait" }>, signal: AbortSignal): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("computer-use MCP client is not connected");

    switch (action.type) {
      case "click":
        await this.call(
          "desktop_click",
          { x: coordinate(action.x, "x"), y: coordinate(action.y, "y"), button: action.button, clicks: 1, keys: modifierKeys(action.keys) },
          signal,
        );
        return;
      case "double_click":
        await this.call(
          "desktop_click",
          { x: coordinate(action.x, "x"), y: coordinate(action.y, "y"), button: "left", clicks: 2, keys: modifierKeys(action.keys) },
          signal,
        );
        return;
      case "drag":
        if (action.path.length === 0 || action.path.length > MAX_DRAG_POINTS) throw new Error("drag 路径长度无效");
        await this.call(
          "desktop_drag",
          { path: action.path.map((point) => ({ x: coordinate(point.x, "x"), y: coordinate(point.y, "y") })), keys: modifierKeys(action.keys) },
          signal,
        );
        return;
      case "keypress":
        if (action.keys.length === 0 || action.keys.length > MAX_KEYS) throw new Error("keypress keys 数量无效");
        await this.call("desktop_key", { keys: action.keys }, signal);
        return;
      case "move":
        await this.call("desktop_move", { x: coordinate(action.x, "x"), y: coordinate(action.y, "y"), keys: modifierKeys(action.keys) }, signal);
        return;
      case "scroll":
        await this.call(
          "desktop_scroll",
          {
            x: coordinate(action.x, "x"),
            y: coordinate(action.y, "y"),
            scrollX: finiteNumber(action.scrollX, "scrollX"),
            scrollY: finiteNumber(action.scrollY, "scrollY"),
            keys: modifierKeys(action.keys),
          },
          signal,
        );
        return;
      case "type":
        if (action.text.length === 0 || action.text.length > MAX_TEXT_LENGTH) throw new Error("输入文本长度无效");
        await this.call("desktop_type", { text: action.text }, signal);
        return;
    }

    // Keep the local variable exhaustive if OpenAI adds an action type before this adapter is updated.
    throw new Error(`不支持的 computer action: ${(action as { type: string }).type}`);
  }

  private async screenshot(signal: AbortSignal): Promise<ComputerScreenshot> {
    const result = await this.call("desktop_get_screenshot", {}, signal);
    if (!isRecord(result) || !Array.isArray(result.content)) throw new Error("桌面截图结果格式无效");
    const image = result.content.find((block) => isRecord(block) && block.type === "image");
    if (!isRecord(image) || typeof image.data !== "string") throw new Error("桌面截图未返回图片");
    const mediaType = image.mimeType === "image/jpeg" || image.mimeType === "image/webp" ? image.mimeType : "image/png";
    const bytes = decodeBase64(image.data);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCREENSHOT_BYTES) throw new Error("桌面截图大小无效");
    return { bytes, mediaType };
  }

  private async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const client = this.client;
    if (!client) throw new Error("computer-use MCP client is not connected");
    const result = await raceAbort(client.callTool({ name, arguments: args }), signal, 10_000);
    if (isRecord(result) && result.isError === true) throw new Error(`桌面工具 ${name} 返回错误`);
    return result;
  }
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("MCP endpoint 不是有效 URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw new Error("MCP endpoint 必须使用 HTTP(S)");
  return endpoint;
}

function coordinate(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 16_383) throw new Error(`${name} 坐标无效`);
  return Math.round(value);
}

function finiteNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) throw new Error(`${name} 数值无效`);
  return value;
}

function modifierKeys(keys: readonly string[] | null | undefined): readonly string[] | undefined {
  if (!keys || keys.length === 0) return undefined;
  if (keys.length > MAX_KEYS) throw new Error("modifier keys 数量无效");
  return keys;
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw new Error("截图 Base64 无效");
  return new Uint8Array(Buffer.from(normalized, "base64"));
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await raceAbort(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  if (signal.aborted) throw new DOMException("The desktop action was aborted.", "AbortError");
  let timer: NodeJS.Timeout | undefined;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(new DOMException("The desktop action was aborted.", "AbortError"));
  signal.addEventListener("abort", onAbort, { once: true });
  if (timeoutMs !== undefined) timer = setTimeout(() => rejectAbort(new Error("桌面动作超时")), Math.max(1, timeoutMs));
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeErrorMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 240);
}
