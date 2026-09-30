import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolAccessRule } from "koishi-plugin-yesimbot";

export type McpServer = McpStdioServer | McpHttpServer | McpSseServer;

export type McpClientTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

export interface McpStdioServer {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string> | string;
  enable?: boolean;
}

export interface McpHttpServer {
  type: "http";
  url: string;
  headers?: Record<string, string> | string;
  /** Owner-only file holding a Bearer token. Mutually exclusive with an explicit `Authorization` header. */
  bearerTokenFile?: string;
  enable?: boolean;
}

export interface McpSseServer {
  type: "sse";
  url: string;
  headers?: Record<string, string> | string;
  /** Owner-only file holding a Bearer token. Mutually exclusive with an explicit `Authorization` header. */
  bearerTokenFile?: string;
  enable?: boolean;
}

export interface McpClientConfig {
  mcpServers: Record<string, McpServer>;
  /** Sensitive MCP tools are exposed only to explicitly authorized scopes. */
  allowedScopes?: ToolAccessRule[];
}
