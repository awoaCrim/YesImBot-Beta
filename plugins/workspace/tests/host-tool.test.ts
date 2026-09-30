import { describe, expect, it, vi } from "vitest";

import { createHostExecTool } from "../src/host-tool";
import { formatHostExecPrompt } from "../src/prompt";

function execution(abortSignal?: AbortSignal) {
  return { abortSignal, toolCallId: "call-1", turnId: "turn-1", messages: [] } as never;
}

describe("hostExec tool", () => {
  it("describes the real-host boundary and failure handling in the prompt", () => {
    const prompt = formatHostExecPrompt(60000);

    expect(prompt).toContain("真实 SSH1 宿主机 Bash");
    expect(prompt).toContain("host 用户 anon");
    expect(prompt).toContain("不要读取、打印或复制 API key");
    expect(prompt).toContain("默认命令超时为 60000 ms");
  });

  it("exposes a complete host command schema and forwards cwd, timeout, and abort signal", async () => {
    const run = vi.fn(async () => ({ stdout: "uid=1003(anon)\n", stderr: "", exitCode: 0 }));
    const abort = new AbortController();
    const tool = createHostExecTool({ runner: { run, stop: vi.fn() }, defaultTimeoutMs: 60000 });

    const result = await tool.execute!({ command: "id", cwd: "/opt", timeoutMs: 120000 }, execution(abort.signal));

    expect(result).toEqual({ stdout: "uid=1003(anon)\n", stderr: "", exitCode: 0, ok: true });
    expect(run).toHaveBeenCalledWith({ command: "id", cwd: "/opt", timeoutMs: 120000, signal: abort.signal });
    expect(tool.description).toContain("真实 Bash");
    expect(tool.inputSchema).toBeDefined();
  });

  it("returns a bounded failure result for invalid input without invoking the runner", async () => {
    const run = vi.fn();
    const tool = createHostExecTool({ runner: { run, stop: vi.fn() }, defaultTimeoutMs: 60000 });

    await expect(tool.execute!({ command: "", cwd: "/" }, execution())).resolves.toMatchObject({ ok: false, error: "invalid_input", exitCode: 2 });
    await expect(tool.execute!({ command: "id", cwd: "relative" }, execution())).resolves.toMatchObject({ ok: false, error: "invalid_input", exitCode: 2 });
    expect(run).not.toHaveBeenCalled();
  });

  it("reports runner failures without leaking an exception into the Agent turn", async () => {
    const tool = createHostExecTool({
      runner: { run: vi.fn(async () => Promise.reject(new Error("namespace unavailable"))), stop: vi.fn() },
      defaultTimeoutMs: 60000,
    });

    await expect(tool.execute!({ command: "id" }, execution())).resolves.toEqual({
      ok: false,
      stdout: "",
      stderr: "namespace unavailable",
      exitCode: 1,
      error: "host_exec_failed",
    });
  });
});
