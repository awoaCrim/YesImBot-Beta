import { describe, expect, it, vi } from "vitest";

import { McpDesktopDriver } from "../src/driver.js";

const CLIENT = {
  connect: vi.fn(async () => undefined),
  listTools: vi.fn(async () => ({
    tools: [
      { name: "desktop_get_screenshot" },
      { name: "desktop_move" },
      { name: "desktop_click" },
      { name: "desktop_drag" },
      { name: "desktop_type" },
      { name: "desktop_key" },
      { name: "desktop_scroll" },
    ],
  })),
  callTool: vi.fn(async ({ name }: { name: string }) =>
    name === "desktop_get_screenshot"
      ? { content: [{ type: "image", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"), mimeType: "image/png" }] }
      : { content: [{ type: "text", text: "ok" }] },
  ),
  close: vi.fn(async () => undefined),
};

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    public connect = CLIENT.connect;
    public listTools = CLIENT.listTools;
    public callTool = CLIENT.callTool;
    public close = CLIENT.close;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    public async close(): Promise<void> {}
  },
}));

describe("McpDesktopDriver", () => {
  it("connects to the fixed MCP catalog and maps the ordered native actions", async () => {
    const driver = new McpDesktopDriver({ endpoint: "http://guest.invalid/sse" });
    const screenshot = await driver.execute(
      [
        { type: "move", x: 10, y: 20 },
        { type: "click", button: "left", x: 10, y: 20 },
        {
          type: "drag",
          path: [
            { x: 10, y: 20 },
            { x: 30, y: 40 },
          ],
        },
        { type: "keypress", keys: ["CTRL", "L"] },
        { type: "type", text: "https://example.com" },
        { type: "scroll", x: 30, y: 40, scrollX: 0, scrollY: 500 },
      ],
      new AbortController().signal,
    );

    expect(screenshot.mediaType).toBe("image/png");
    expect(CLIENT.callTool).toHaveBeenCalledWith({ name: "desktop_move", arguments: { x: 10, y: 20, keys: undefined } });
    expect(CLIENT.callTool).toHaveBeenCalledWith({
      name: "desktop_drag",
      arguments: {
        path: [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
        keys: undefined,
      },
    });
    expect(CLIENT.callTool).toHaveBeenCalledWith({ name: "desktop_key", arguments: { keys: ["CTRL", "L"] } });
    expect(CLIENT.callTool).toHaveBeenCalledWith({
      name: "desktop_scroll",
      arguments: { x: 30, y: 40, scrollX: 0, scrollY: 500, keys: undefined },
    });
    await driver.close();
  });

  it("rejects WebP screenshots instead of relabeling them as a supported format", async () => {
    CLIENT.callTool.mockImplementationOnce(async ({ name }: { name: string }) =>
      name === "desktop_get_screenshot"
        ? { content: [{ type: "image", data: Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBP", "binary").toString("base64"), mimeType: "image/webp" }] }
        : { content: [{ type: "text", text: "ok" }] },
    );
    const driver = new McpDesktopDriver({ endpoint: "http://guest.invalid/sse" });

    await expect(driver.execute([], new AbortController().signal)).rejects.toThrow("桌面截图格式不受 Responses 路由支持");
    await driver.close();
  });
});
