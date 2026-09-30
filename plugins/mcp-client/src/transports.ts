import { readFile, stat } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Context } from "koishi";

import type { McpClientTransport, McpHttpServer, McpServer, McpSseServer, McpStdioServer } from "./types.js";

/** Configuration or credential error that must never echo the secret it was protecting. */
export class McpCredentialError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "McpCredentialError";
  }
}

export async function connectMcpServer(ctx: Context, name: string, server: McpServer): Promise<{ client: Client; transport: McpClientTransport }> {
  ctx.logger.info(`连接到 MCP 服务器 ${name}...`);

  switch (server.type) {
    case "stdio":
      return await connectToStdioServer(ctx, name, server);
    case "http":
      return await connectToHttpServer(ctx, name, server);
    case "sse":
      return await connectToSseServer(ctx, name, server);
  }
}

export function parseKeyValueString(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = input.split("\n");

  for (const line of lines) {
    const colon = line.indexOf(":");
    const equals = line.indexOf("=");
    const delimiter = colon === -1 ? equals : equals === -1 ? colon : Math.min(colon, equals);

    if (delimiter > -1) {
      const key = line.slice(0, delimiter).trim();
      if (!key) continue;
      result[key] = line.slice(delimiter + 1).trim();
    }
  }

  return result;
}

/** Resolves the configured headers without exposing any value to logs. */
export function parseHeaders(input: Record<string, string> | string | undefined): Record<string, string> {
  return typeof input === "string" ? parseKeyValueString(input) : { ...(input ?? {}) };
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

/** Removes every literal occurrence of a secret from a message before it can reach a logger. */
export function redactSecret(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    result = result.split(secret).join("[redacted]");
  }
  return result;
}

/**
 * Reads a Bearer token from an owner-only file. Every failure mode is fail-closed and reports only the
 * category, never the file content.
 */
export async function readBearerTokenFile(path: string): Promise<string> {
  if (path.trim().length === 0) {
    throw new McpCredentialError("bearerTokenFile 必须是非空路径");
  }

  let mode: number;
  let uid: number;
  let isFile: boolean;
  try {
    const stats = await stat(path);
    mode = stats.mode;
    uid = stats.uid;
    isFile = stats.isFile();
  } catch {
    throw new McpCredentialError("bearer token 文件不可读或不存在");
  }

  if (!isFile) {
    throw new McpCredentialError("bearer token 路径不是普通文件");
  }
  if ((mode & 0o077) !== 0) {
    throw new McpCredentialError("bearer token 文件权限不是 owner-only（要求 600 或更严格）");
  }
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new McpCredentialError("bearer token 文件 owner 与运行进程不一致");
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new McpCredentialError("bearer token 文件不可读");
  }

  const token = raw.trim();
  if (token.length === 0) {
    throw new McpCredentialError("bearer token 文件为空");
  }
  if (/\s/.test(token)) {
    throw new McpCredentialError("bearer token 文件必须只包含单行 token");
  }

  return token;
}

async function connectToStdioServer(ctx: Context, name: string, server: McpStdioServer): Promise<{ client: Client; transport: StdioClientTransport }> {
  ctx.logger.info(`连接到 STDIO 服务器 ${name}，命令: ${server.command}`);
  const env = typeof server.env === "string" ? parseKeyValueString(server.env) : server.env;
  // Environment values may carry credentials; log the configured field names only.
  ctx.logger.debug(`STDIO 环境变量字段: ${describeFieldNames(env ?? {})}`);

  const transport = new StdioClientTransport({ command: server.command, args: server.args, env });
  const client = new Client({ name, version: "1.0.0" });
  try {
    await client.connect(transport);
  } catch (error) {
    const secrets = [...Object.values(env ?? {}), ...(server.args ?? [])];
    const reason = redactSecret(error instanceof Error ? error.message : String(error), secrets);
    throw new Error(`连接 STDIO 服务器失败: ${reason}`);
  }
  return { client, transport };
}

async function connectToHttpServer(ctx: Context, name: string, server: McpHttpServer): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  return connectToRemoteServer(ctx, name, "HTTP", server, StreamableHTTPClientTransport);
}

async function connectToSseServer(ctx: Context, name: string, server: McpSseServer): Promise<{ client: Client; transport: SSEClientTransport }> {
  return connectToRemoteServer(ctx, name, "SSE", server, SSEClientTransport);
}

async function connectToRemoteServer<TTransport extends StreamableHTTPClientTransport | SSEClientTransport>(
  ctx: Context,
  name: string,
  protocol: "HTTP" | "SSE",
  server: McpHttpServer | McpSseServer,
  Transport: new (url: URL, options: { requestInit: { headers: Record<string, string> } }) => TTransport,
): Promise<{ client: Client; transport: TTransport }> {
  ctx.logger.info(`连接到 ${protocol} 服务器 ${name}，URL: ${server.url}`);

  const headers = parseHeaders(server.headers);
  const tokenFile = typeof server.bearerTokenFile === "string" && server.bearerTokenFile.length > 0 ? server.bearerTokenFile : undefined;

  // Two competing Authorization sources are ambiguous; refuse instead of guessing an order.
  if (tokenFile !== undefined && hasHeader(headers, "authorization")) {
    throw new McpCredentialError("bearerTokenFile 与显式 Authorization 请求头不能同时配置");
  }

  const token = tokenFile === undefined ? undefined : await readBearerTokenFile(tokenFile);
  const requestHeaders = token === undefined ? headers : { ...headers, Authorization: `Bearer ${token}` };
  // Header values may carry credentials; log the configured field names only.
  ctx.logger.debug(`${protocol} 请求头字段: ${describeFieldNames(requestHeaders)}`);

  const transport = new Transport(new URL(server.url), { requestInit: { headers: requestHeaders } });
  const client = new Client({ name, version: "1.0.0" });

  try {
    await client.connect(transport);
  } catch (error) {
    // Upstream errors are re-emitted through a redactor so a secret cannot leak through a stack message.
    const reason = redactSecret(error instanceof Error ? error.message : String(error), collectSecretValues(requestHeaders));
    throw new Error(`连接 ${protocol} 服务器失败: ${reason}`);
  }

  return { client, transport };
}

function describeFieldNames(headers: Record<string, string>): string {
  const names = Object.keys(headers);
  return names.length === 0 ? "(无)" : names.join(", ");
}

function collectSecretValues(headers: Record<string, string>): string[] {
  return Object.entries(headers).flatMap(([name, value]) => {
    const bearer = name.toLowerCase() === "authorization" ? /^Bearer\s+(.+)$/i.exec(value.trim()) : undefined;
    return bearer?.[1] ? [value, bearer[1]] : [value];
  });
}
