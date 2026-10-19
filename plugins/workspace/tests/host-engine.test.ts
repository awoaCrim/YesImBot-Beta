import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { buildGuestCleanupSshArgs, buildGuestSshArgs, createHostRunner } from "../src/host-engine";

class FakeChild extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly signals: NodeJS.Signals[] = [];

  public constructor(public readonly pid: number) {
    super();
  }

  public kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.emit("close", null);
    return true;
  }
}

type SpawnFactory = ReturnType<typeof createSpawnFactory>;

function createSpawnFactory(options: { readonly closeOnSpawn?: boolean[]; readonly stdout?: string; readonly stderr?: string } = {}) {
  const children: FakeChild[] = [];
  const spawnProcess = vi.fn(() => {
    const child = new FakeChild(4321 + children.length);
    children.push(child);
    const closeImmediately = options.closeOnSpawn?.[children.length - 1] ?? false;
    queueMicrotask(() => {
      if (options.stdout) child.stdout.emit("data", Buffer.from(options.stdout));
      if (options.stderr) child.stderr.emit("data", Buffer.from(options.stderr));
      if (closeImmediately) child.emit("close", 0);
    });
    return child as never;
  });
  const killProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
    const child = children.find((candidate) => -candidate.pid === pid);
    child?.signals.push(signal);
    queueMicrotask(() => child?.emit("close", null));
  });
  return { spawnProcess, killProcess, children };
}

function createRunner(factory: SpawnFactory, options: { readonly defaultTimeoutMs?: number; readonly maxOutputBytes?: number } = {}) {
  return createHostRunner({
    platform: "linux",
    defaultTimeoutMs: options.defaultTimeoutMs ?? 100,
    maxTimeoutMs: 300,
    maxOutputBytes: options.maxOutputBytes ?? 16,
    killGraceMs: 1,
    cleanupTimeoutMs: 20,
    spawnProcess: factory.spawnProcess,
    killProcess: factory.killProcess,
    tokenGenerator: () => "a".repeat(32),
  });
}

describe("guest runner command construction", () => {
  it("uses the fixed guest SSH identity and quotes cwd and command", () => {
    const args = buildGuestSshArgs({ command: "printf '%s' \"$HOME\"", cwd: "/opt/yesimbot" }, "a".repeat(32));
    const remote = args.at(-1) ?? "";

    expect(args).toEqual(expect.arrayContaining(["-T", "StrictHostKeyChecking=yes", "IdentitiesOnly=yes", "-p", "10022"]));
    expect(args).not.toContain("/usr/bin/nsenter");
    expect(args).toContain("anon@172.20.0.1");
    expect(remote).toContain("marker=/tmp/yesimbot-guest-exec-$token.pid");
    expect(remote).toContain("'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'");
    expect(remote).toContain("'/opt/yesimbot'");
    expect(remote).toContain("$HOME");
    expect(remote).toContain("'printf ");
  });

  it("builds a separate fixed-target cleanup command", () => {
    const args = buildGuestCleanupSshArgs("b".repeat(32));
    expect(args).toContain("anon@172.20.0.1");
    expect(args.at(-1)).toContain("yesimbot-guest-exec-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.pid");
    expect(args.at(-1)).toContain("KILL");
  });
});

describe("guest runner lifecycle", () => {
  it("preserves exit/output and bounds each stream", async () => {
    const factory = createSpawnFactory({ closeOnSpawn: [true], stdout: "12345678901234567890", stderr: "abcdefghijklmnopqrst" });
    const runner = createRunner(factory, { maxOutputBytes: 8 });

    const result = await runner.run({ command: "id", cwd: "/" });

    expect(result).toMatchObject({ exitCode: 0, stdoutTruncated: true, stderrTruncated: true });
    expect(result.stdout).toContain("[output truncated:");
    expect(result.stderr).toContain("[output truncated:");
    expect(factory.spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/ssh",
      expect.arrayContaining(["-T", "anon@172.20.0.1"]),
      expect.objectContaining({ cwd: "/", detached: true, stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("terminates the local process group and cleans the remote group on timeout", async () => {
    const factory = createSpawnFactory({ closeOnSpawn: [false, true] });
    const runner = createRunner(factory, { defaultTimeoutMs: 10 });

    const result = await runner.run({ command: "sleep 10", cwd: "/", timeoutMs: 10 });

    expect(result).toMatchObject({ exitCode: 124, timedOut: true, stderr: expect.stringContaining("timed out") });
    expect(factory.killProcess).toHaveBeenCalledWith(-4321, "SIGTERM");
    expect(factory.spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("terminates on abort and drains queued calls on stop", async () => {
    const factory = createSpawnFactory({ closeOnSpawn: [false, true, true] });
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
    const factory = createSpawnFactory({ closeOnSpawn: [false, true] });
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
