import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  created: [] as Array<{ kind: string; url?: URL; headers?: Record<string, string>; env?: unknown }>,
  statModes: new Map<string, number>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const stats = await actual.stat(...args);
      const mode = mocks.statModes.get(String(args[0]));
      return mode === undefined ? stats : Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { mode });
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    public async connect(transport: unknown) {
      void transport;
      return mocks.connect();
    }

    public async close() {
      return undefined;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    public constructor(url: URL, options: { requestInit: { headers: Record<string, string> } }) {
      mocks.created.push({ headers: options.requestInit.headers, kind: "http", url });
    }

    public async close() {
      return undefined;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    public constructor(url: URL, options: { requestInit: { headers: Record<string, string> } }) {
      mocks.created.push({ headers: options.requestInit.headers, kind: "sse", url });
    }

    public async close() {
      return undefined;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    public constructor(config: { env?: unknown }) {
      mocks.created.push({ env: config.env, kind: "stdio" });
    }

    public async close() {
      return undefined;
    }
  },
}));

import { connectMcpServer, readBearerTokenFile, redactSecret } from "../src/transports";

const TOKEN = "luckin-test-token-0123456789abcdef";

let directory = "";
let secretPath = "";
let logger: {
  debug: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  success: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mcp-client-token-"));
  secretPath = join(directory, "luckin-mcp.token");
  await writeFile(secretPath, `  ${TOKEN}  \n`, "utf8");
  await chmod(secretPath, 0o600);
  mocks.statModes.set(secretPath, 0o100600);
});

afterAll(async () => {
  await rm(directory, { force: true, recursive: true });
});

beforeEach(() => {
  mocks.created.length = 0;
  mocks.connect.mockClear();
  logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn() };
});

function createContext() {
  return { logger } as never;
}

function loggedText(): string {
  return [...logger.debug.mock.calls, ...logger.info.mock.calls, ...logger.error.mock.calls, ...logger.warn.mock.calls, ...logger.success.mock.calls]
    .flat()
    .map((value) => String(value))
    .join("\n");
}

describe("readBearerTokenFile", () => {
  it("reads and trims an owner-only token file", async () => {
    await expect(readBearerTokenFile(secretPath)).resolves.toBe(TOKEN);
  });

  it("rejects missing, empty, multi-line, and permissive files without echoing content", async () => {
    const cases = [
      { file: join(directory, "missing.token"), mode: undefined },
      { file: join(directory, "empty.token"), mode: 0o600, content: "   \n" },
      { file: join(directory, "multiline.token"), mode: 0o600, content: "first-token\nsecond-token\n" },
      { file: join(directory, "permissive.token"), mode: 0o644, content: `${TOKEN}\n` },
    ];

    for (const item of cases) {
      if (item.content !== undefined) {
        await writeFile(item.file, item.content, "utf8");
      }
      if (item.mode !== undefined) {
        await chmod(item.file, item.mode);
        mocks.statModes.set(item.file, 0o100000 | item.mode);
      }

      await expect(readBearerTokenFile(item.file)).rejects.toThrow();
      const error = await readBearerTokenFile(item.file).catch((reason: unknown) => reason as Error);
      expect(error.message).not.toContain(TOKEN);
      expect(error.message).not.toContain("first-token");
      expect(error.message).not.toContain("second-token");
    }
  });

  it("rejects a directory path", async () => {
    await expect(readBearerTokenFile(directory)).rejects.toThrow(/普通文件/);
  });
});

describe("connectMcpServer bearer token handling", () => {
  it("derives the Authorization header from the token file without logging the token", async () => {
    await connectMcpServer(createContext(), "luckin", { bearerTokenFile: secretPath, type: "http", url: "https://example.test/mcp" });

    expect(mocks.created).toHaveLength(1);
    expect(mocks.created[0]?.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    const logged = loggedText();
    expect(logged).toContain("Authorization");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("Bearer ");
  });

  it("redacts token values from remote connection errors", async () => {
    mocks.connect.mockRejectedValueOnce(new Error(`upstream echoed ${TOKEN}`));

    await expect(
      connectMcpServer(createContext(), "luckin", {
        bearerTokenFile: secretPath,
        type: "http",
        url: "https://example.test/mcp",
      }),
    ).rejects.toThrow(/连接 HTTP 服务器失败/);

    expect(loggedText()).not.toContain(TOKEN);
  });

  it("fails closed when an explicit Authorization header competes with the token file", async () => {
    await expect(
      connectMcpServer(createContext(), "luckin", {
        bearerTokenFile: secretPath,
        headers: { Authorization: "Bearer explicit-value" },
        type: "http",
        url: "https://example.test/mcp",
      }),
    ).rejects.toThrow(/不能同时配置/);

    expect(mocks.created).toHaveLength(0);
    const logged = loggedText();
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("explicit-value");
  });

  it("redacts explicit header values from remote connection errors", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("upstream echoed explicit-value"));

    await expect(
      connectMcpServer(createContext(), "docs", {
        headers: { Authorization: "Bearer explicit-value" },
        type: "http",
        url: "https://example.test/mcp",
      }),
    ).rejects.toThrow(/连接 HTTP 服务器失败/);

    expect(loggedText()).not.toContain("explicit-value");
  });

  it("keeps explicit headers working when no token file is configured", async () => {
    await connectMcpServer(createContext(), "docs", { headers: { "X-Api-Key": "plain-value" }, type: "http", url: "https://example.test/mcp" });

    expect(mocks.created[0]?.headers).toEqual({ "X-Api-Key": "plain-value" });
    expect(loggedText()).toContain("X-Api-Key");
    expect(loggedText()).not.toContain("plain-value");
  });

  it("parses a string header block and still never logs values", async () => {
    await connectMcpServer(createContext(), "docs", { headers: "X-Api-Key: from-string-block", type: "sse", url: "https://example.test/mcp" });

    expect(mocks.created[0]?.headers).toEqual({ "X-Api-Key": "from-string-block" });
    expect(loggedText()).not.toContain("from-string-block");
  });

  it("redacts stdio environment values from connection errors", async () => {
    mocks.connect.mockRejectedValueOnce(new Error("spawn failed with super-secret-value"));

    await expect(connectMcpServer(createContext(), "local", { command: "node", env: { API_KEY: "super-secret-value" }, type: "stdio" })).rejects.toThrow(
      /连接 STDIO 服务器失败/,
    );

    expect(loggedText()).not.toContain("super-secret-value");
  });

  it("redacts stdio environment values from debug logs", async () => {
    await connectMcpServer(createContext(), "local", { command: "node", env: { API_KEY: "super-secret-value" }, type: "stdio" });

    expect(mocks.created[0]?.env).toEqual({ API_KEY: "super-secret-value" });
    const logged = loggedText();
    expect(logged).toContain("API_KEY");
    expect(logged).not.toContain("super-secret-value");
  });
});

describe("redactSecret", () => {
  it("replaces every occurrence of a secret", () => {
    expect(redactSecret("failed with abc123 and abc123", ["abc123"])).toBe("failed with [redacted] and [redacted]");
    expect(redactSecret("failed", ["", "missing"])).toBe("failed");
  });
});
