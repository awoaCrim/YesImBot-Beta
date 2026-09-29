import { jsonSchema, type AgentTool } from "@yesimbot/agent-runtime";

import type { HostCommandResult, HostRunner } from "./host-engine";

const DEFAULT_MAX_TIMEOUT_MS = 300_000;

export interface HostExecToolOptions {
  readonly runner: HostRunner;
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs?: number;
}

export interface HostExecInput {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface HostExecOutput extends HostCommandResult {
  readonly ok: boolean;
  readonly error?: string;
}

export function createHostExecTool(options: HostExecToolOptions): AgentTool<HostExecInput, HostExecOutput> {
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  return {
    name: "hostExec",
    description:
      "在 SSH1 宿主机上执行一条真实 Bash 命令。命令不是 just-bash 虚拟沙箱；它会以 host 用户 anon 运行，而 anon 可以使用现有 sudo 权限管理整台 SSH1。只在确实需要宿主机状态或维护时使用；先执行 id、pwd、docker ps 等小范围检查，再进行变更。不要把秘密、API key、密码或完整环境变量写入命令或输出。必须检查 ok、exitCode、stdout 和 stderr，不要假设命令成功。",
    inputSchema: jsonSchema<HostExecInput>({
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, description: "要在 SSH1 宿主机执行的完整 Bash 命令；不要拆成多个互相依赖的调用" },
        cwd: { type: "string", description: "宿主机绝对工作目录；省略时使用 /" },
        timeoutMs: {
          type: "integer",
          minimum: 1_000,
          maximum: maxTimeoutMs,
          description: `本次命令超时毫秒数，默认 ${options.defaultTimeoutMs}，最大 ${maxTimeoutMs}`,
        },
      },
      required: ["command"],
      additionalProperties: false,
    }),
    execute: async (input, execution) => {
      const command = input?.command;
      if (typeof command !== "string" || command.length === 0) return invalidInput("command must be a non-empty string");
      if (command.includes("\u0000")) return invalidInput("command must not contain NUL bytes");
      const cwd = input.cwd ?? "/";
      if (typeof cwd !== "string" || cwd.length === 0 || !cwd.startsWith("/")) return invalidInput("cwd must be an absolute POSIX path");
      if (cwd.includes("\u0000")) return invalidInput("cwd must not contain NUL bytes");
      if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > maxTimeoutMs)) {
        return invalidInput(`timeoutMs must be an integer between 1000 and ${maxTimeoutMs}`);
      }

      try {
        const result = await options.runner.run({ command, cwd, timeoutMs: input.timeoutMs, signal: execution.abortSignal });
        return { ...result, ok: result.exitCode === 0 };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, stdout: "", stderr: message, exitCode: 1, error: "host_exec_failed" };
      }
    },
  };
}

function invalidInput(message: string): HostExecOutput {
  return { ok: false, stdout: "", stderr: message, exitCode: 2, error: "invalid_input" };
}
