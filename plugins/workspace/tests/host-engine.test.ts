import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { buildNsenterArgs, createHostRunner } from "../src/host-engine";

class FakeChild extends EventEmitter {
  public readonly pid = 4321;
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly signals: NodeJS.Signals[] = [];

  public kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.emit("close", null);
    return true;
  }
}

type SpawnFactory = ReturnType<typeof createSpawnFactory>;

function createSpawnFactory(options: { readonly closeImmediately?: boolean; readonly stdout?: string; readonly stderr?: string } = {}) {
  let child: FakeChild | undefined;
  const spawnProcess = vi.fn(() => {
    child = new FakeChild();
    queueMicrotask(() => {
      if (options.stdout) child?.stdout.emit("data", Buffer.from(options.stdout));
      if (options.stderr) child?.stderr.emit("data", Buffer.from(options.stderr));
      if (options.closeImmediately) child?.emit("close", 0);
    });
    return child as never;
  });
  const killProcess = vi.fn((_pid: number, signal: NodeJS.Signals) => {
    child?.signals.push(signal);
    queueMicrotask(() => child?.emit("close", null));
  });
  return { spawnProcess, killProcess, getChild: () => child };
}

function createRunner(factory: SpawnFactory, options: { readonly defaultTimeoutMs?: number; readonly maxOutputBytes?: number } = {}) {
  return createHostRunner({
    platform: "linux",
    defaultTimeoutMs: options.defaultTimeoutMs ?? 100,
    maxTimeoutMs: 300,
    maxOutputBytes: options.maxOutputBytes ?? 16,
    killGraceMs: 1,
    spawnProcess: factory.spawnProcess,
    killProcess: factory.killProcess,
  });
}

describe("host runner command construction", () => {
  it("enters the host namespaces and runs as anon without shell interpolation", () => {
    const args = buildNsenterArgs({ command: "printf '%s' \"$HOME\"", cwd: "/opt/yesimbot" });

    expect(args.slice(0, 8)).toEqual(["-t", "1", "-m", "-u", "-i", "-n", "-p", "--"]);
    expect(args).toContain("/usr/bin/sudo");
    expect(args).toContain("anon");
    expect(args.at(-3)).toBe("yesimbot-host-exec");
    expect(args.at(-2)).toBe("/opt/yesimbot");
    expect(args.at(-1)).toBe("printf '%s' \"$HOME\"");
  });
});

describe("host runner lifecycle", () => {
  it("preserves exit/output and bounds each stream", async () => {
    const factory = createSpawnFactory({ closeImmediately: true, stdout: "12345678901234567890", stderr: "abcdefghijklmnopqrst" });
    const runner = createRunner(factory, { maxOutputBytes: 8 });

    const result = await runner.run({ command: "id", cwd: "/" });

    expect(result).toMatchObject({ exitCode: 0, stdoutTruncated: true, stderrTruncated: true });
    expect(result.stdout).toContain("[output truncated:");
    expect(result.stderr).toContain("[output truncated:");
    expect(factory.spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/nsenter",
      expect.arrayContaining(["-t", "1", "/usr/bin/sudo", "anon"]),
      expect.objectContaining({ cwd: "/", detached: true, stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("terminates the process group on timeout", async () => {
    const factory = createSpawnFactory();
    const runner = createRunner(factory, { defaultTimeoutMs: 10 });

    const result = await runner.run({ command: "sleep 10", cwd: "/", timeoutMs: 10 });

    expect(result).toMatchObject({ exitCode: 124, timedOut: true, stderr: expect.stringContaining("timed out") });
    expect(factory.killProcess).toHaveBeenCalledWith(-4321, "SIGTERM");
  });

  it("terminates the process group on abort and drains queued calls on stop", async () => {
    const factory = createSpawnFactory({ closeImmediately: true });
    const runner = createRunner(factory);
    const abort = new AbortController();
    const active = runner.run({ command: "sleep 10", cwd: "/", signal: abort.signal });
    const queued = runner.run({ command: "echo queued", cwd: "/" });

    abort.abort();
    const activeResult = await active;
    expect(activeResult).toMatchObject({ exitCode: 130, cancelled: true });

    const queuedResult = await queued;
    expect(queuedResult).toMatchObject({ exitCode: 0 });

    await runner.stop();
  });

  it("cancels queued work when the runner stops", async () => {
    const factory = createSpawnFactory();
    const runner = createRunner(factory);
    const active = runner.run({ command: "sleep 10", cwd: "/" });
    const queued = runner.run({ command: "echo queued", cwd: "/" });

    const stop = runner.stop();
    const queuedResult = await queued;
    const activeResult = await active;
    await stop;

    expect(queuedResult).toMatchObject({ exitCode: 130, cancelled: true });
    expect(activeResult).toMatchObject({ exitCode: 130, cancelled: true });
  });
});
