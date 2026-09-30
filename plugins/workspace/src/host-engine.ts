import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const NSENTER_PATH = "/usr/bin/nsenter";
const HOST_SUDO_PATH = "/usr/bin/sudo";
const HOST_BASH_PATH = "/bin/bash";
const HOST_USER = "anon";
const HOST_ENTRYPOINT = "yesimbot-host-exec";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 30_000;
const DEFAULT_KILL_GRACE_MS = 250;
const TIMEOUT_EXIT_CODE = 124;
const CANCEL_EXIT_CODE = 130;

type TerminationReason = "abort" | "timeout" | "stop";

type SpawnProcess = typeof spawn;

type QueueEntry = {
  input: HostRunnerInput;
  resolve: (result: HostCommandResult) => void;
  reject: (error: unknown) => void;
  state: "queued" | "active" | "settled";
  onAbort: () => void;
  terminationReason?: TerminationReason;
  terminate?: (reason: TerminationReason) => void;
};

type BoundedBuffer = {
  append(chunk: Buffer | string): void;
  toString(): string;
  get truncated(): boolean;
  get droppedBytes(): number;
};

export interface HostCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
}

export interface HostRunnerInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface HostRunner {
  run(input: HostRunnerInput): Promise<HostCommandResult>;
  stop(): Promise<void>;
}

export interface HostRunnerOptions {
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly killGraceMs?: number;
  readonly nsenterPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: SpawnProcess;
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

class HostRunnerImpl implements HostRunner {
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;
  private readonly nsenterPath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly spawnProcess: SpawnProcess;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly children = new Set<ChildProcess>();
  private readonly queue: QueueEntry[] = [];
  private active?: QueueEntry;
  private pumpPromise?: Promise<void>;
  private stopped = false;

  public constructor(options: HostRunnerOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTimeoutMs = options.maxTimeoutMs ?? MAX_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.nsenterPath = options.nsenterPath ?? NSENTER_PATH;
    this.environment = options.environment ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));

    if (!Number.isSafeInteger(this.defaultTimeoutMs) || this.defaultTimeoutMs <= 0) {
      throw new Error("Host runner defaultTimeoutMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.maxTimeoutMs) || this.maxTimeoutMs < this.defaultTimeoutMs) {
      throw new Error("Host runner maxTimeoutMs must be an integer at least defaultTimeoutMs");
    }
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new Error("Host runner maxOutputBytes must be a positive integer");
    }
    if (!Number.isSafeInteger(this.killGraceMs) || this.killGraceMs < 0) {
      throw new Error("Host runner killGraceMs must be a non-negative integer");
    }
  }

  public run(input: HostRunnerInput): Promise<HostCommandResult> {
    try {
      validateInput(input, this.platform, this.maxTimeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.stopped) return Promise.reject(new Error("Host runner is stopped"));
    if (input.signal?.aborted) return Promise.resolve(cancellationResult("abort", this.resolveTimeout(input.timeoutMs)));

    return new Promise<HostCommandResult>((resolve, reject) => {
      const entry: QueueEntry = {
        input,
        resolve,
        reject,
        state: "queued",
        onAbort: () => this.cancel(entry, "abort"),
      };
      input.signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.queue.push(entry);
      this.startPump();
    });
  }

  public async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      for (const entry of this.queue.splice(0)) {
        this.settle(entry, cancellationResult("stop", this.resolveTimeout(entry.input.timeoutMs)));
      }
      this.active?.terminate?.("stop");
    }

    const pumpPromise = this.pumpPromise;
    if (pumpPromise) await pumpPromise;
  }

  private resolveTimeout(timeoutMs: number | undefined): number {
    return timeoutMs ?? this.defaultTimeoutMs;
  }

  private startPump(): void {
    if (this.pumpPromise) return;
    this.pumpPromise = this.drainQueue().finally(() => {
      this.pumpPromise = undefined;
      if (!this.stopped && this.queue.length > 0) this.startPump();
    });
  }

  private async drainQueue(): Promise<void> {
    while (!this.stopped) {
      const entry = this.queue.shift();
      if (!entry) return;
      if (entry.state !== "queued") continue;

      entry.state = "active";
      this.active = entry;
      try {
        this.settle(entry, await this.execute(entry));
      } catch (error) {
        this.settleError(entry, error);
      } finally {
        this.active = undefined;
      }
    }
  }

  private cancel(entry: QueueEntry, reason: TerminationReason): void {
    if (entry.state === "settled") return;
    entry.terminationReason ??= reason;
    if (entry.state === "queued") {
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
      this.settle(entry, cancellationResult(reason, this.resolveTimeout(entry.input.timeoutMs)));
      return;
    }
    entry.terminate?.(reason);
  }

  private settle(entry: QueueEntry, result: HostCommandResult): void {
    if (entry.state === "settled") return;
    entry.state = "settled";
    entry.input.signal?.removeEventListener("abort", entry.onAbort);
    entry.resolve(result);
  }

  private settleError(entry: QueueEntry, error: unknown): void {
    if (entry.state === "settled") return;
    entry.state = "settled";
    entry.input.signal?.removeEventListener("abort", entry.onAbort);
    entry.reject(error);
  }

  private async execute(entry: QueueEntry): Promise<HostCommandResult> {
    if (entry.terminationReason) return cancellationResult(entry.terminationReason, this.resolveTimeout(entry.input.timeoutMs));

    const args = buildNsenterArgs(entry.input);
    const spawnOptions: SpawnOptions = {
      cwd: "/",
      env: this.environment,
      detached: this.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    };

    return await new Promise<HostCommandResult>((resolve, reject) => {
      const stdout = createBoundedBuffer(this.maxOutputBytes);
      const stderr = createBoundedBuffer(this.maxOutputBytes);
      let child: ChildProcess;
      try {
        child = this.spawnProcess(this.nsenterPath, args, spawnOptions);
      } catch (error) {
        reject(error);
        return;
      }
      this.children.add(child);
      let settled = false;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;

      const clearTimers = (): void => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = undefined;
        }
      };
      const finish = (result: HostCommandResult): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        entry.terminate = undefined;
        this.children.delete(child);
        resolve(result);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        entry.terminate = undefined;
        this.children.delete(child);
        reject(error);
      };
      const terminate = (reason: TerminationReason): void => {
        if (settled) return;
        entry.terminationReason ??= reason;
        signalProcessGroup(child, "SIGTERM", this.platform, this.killProcess);
        if (!graceTimer) {
          graceTimer = setTimeout(() => {
            if (!settled) signalProcessGroup(child, "SIGKILL", this.platform, this.killProcess);
          }, this.killGraceMs);
          graceTimer.unref?.();
        }
      };
      entry.terminate = terminate;

      child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
      child.once("error", fail);
      child.once("close", (code) => {
        const reason = entry.terminationReason;
        const timedOut = reason === "timeout";
        const cancelled = reason === "abort" || reason === "stop";
        const result: HostCommandResult = {
          stdout: stdout.toString(),
          stderr: appendTerminationMessage(stderr.toString(), reason, this.resolveTimeout(entry.input.timeoutMs)),
          exitCode: timedOut ? TIMEOUT_EXIT_CODE : cancelled ? CANCEL_EXIT_CODE : (code ?? 1),
          ...(timedOut ? { timedOut: true } : {}),
          ...(cancelled ? { cancelled: true } : {}),
          ...(stdout.truncated ? { stdoutTruncated: true } : {}),
          ...(stderr.truncated ? { stderrTruncated: true } : {}),
        };
        finish(result);
      });

      if (entry.terminationReason) {
        terminate(entry.terminationReason);
      } else {
        timeoutTimer = setTimeout(() => terminate("timeout"), this.resolveTimeout(entry.input.timeoutMs));
        timeoutTimer.unref?.();
      }
    });
  }
}

export function createHostRunner(options: HostRunnerOptions = {}): HostRunner {
  return new HostRunnerImpl(options);
}

export function buildNsenterArgs(input: HostRunnerInput): string[] {
  return [
    "-t",
    "1",
    "-m",
    "-u",
    "-i",
    "-n",
    "-p",
    "--",
    HOST_SUDO_PATH,
    "-n",
    "-u",
    HOST_USER,
    "--",
    HOST_BASH_PATH,
    "--noprofile",
    "--norc",
    "-c",
    'cd -- "$1" || exit $?; exec /bin/bash --noprofile --norc -c "$2"',
    HOST_ENTRYPOINT,
    input.cwd,
    input.command,
  ];
}

function validateInput(input: HostRunnerInput, platform: NodeJS.Platform, maxTimeoutMs: number): void {
  if (platform !== "linux") throw new Error("Host runner requires Linux namespace support");
  if (typeof input.command !== "string" || input.command.length === 0) throw new Error("Host runner command must be a non-empty string");
  if (input.command.includes("\u0000")) throw new Error("Host runner command must not contain NUL bytes");
  if (typeof input.cwd !== "string" || input.cwd.length === 0 || !input.cwd.startsWith("/")) {
    throw new Error("Host runner cwd must be an absolute POSIX path");
  }
  if (input.cwd.includes("\u0000")) throw new Error("Host runner cwd must not contain NUL bytes");
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > maxTimeoutMs)) {
    throw new Error(`Host runner timeoutMs must be an integer between 1 and ${maxTimeoutMs}`);
  }
}

function signalProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
  killProcess: (pid: number, signal: NodeJS.Signals) => void,
): void {
  if (platform !== "win32" && child.pid !== undefined && child.pid !== null) {
    try {
      killProcess(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The process may have exited between close checks and signalling.
  }
}

function createBoundedBuffer(maxBytes: number): BoundedBuffer {
  const chunks: Buffer[] = [];
  let size = 0;
  let droppedBytes = 0;

  return {
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxBytes - size);
      if (remaining > 0) {
        const retained = bytes.subarray(0, remaining);
        chunks.push(retained);
        size += retained.byteLength;
      }
      if (bytes.byteLength > remaining) droppedBytes += bytes.byteLength - remaining;
    },
    toString() {
      const value = Buffer.concat(chunks).toString("utf8");
      return droppedBytes > 0 ? `${value}\n[output truncated: ${droppedBytes} bytes removed]` : value;
    },
    get truncated() {
      return droppedBytes > 0;
    },
    get droppedBytes() {
      return droppedBytes;
    },
  };
}

function appendTerminationMessage(stderr: string, reason: TerminationReason | undefined, timeoutMs: number): string {
  if (!reason) return stderr;
  const message = reason === "timeout" ? `Command timed out after ${timeoutMs}ms` : "Command cancelled";
  return stderr.length > 0 ? `${stderr}\n${message}` : message;
}

function cancellationResult(reason: TerminationReason, timeoutMs: number): HostCommandResult {
  return {
    stdout: "",
    stderr: reason === "timeout" ? `Command timed out after ${timeoutMs}ms` : "Command cancelled",
    exitCode: reason === "timeout" ? TIMEOUT_EXIT_CODE : CANCEL_EXIT_CODE,
    ...(reason === "timeout" ? { timedOut: true } : { cancelled: true }),
  };
}
