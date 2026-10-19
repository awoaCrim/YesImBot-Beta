import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const SSH_PATH = "/usr/bin/ssh";
const GUEST_HOST = "172.20.0.1";
const GUEST_PORT = 10022;
const GUEST_USER = "anon";
const GUEST_IDENTITY_FILE = "/run/yesimbot/anon-vm/anon_ed25519";
const GUEST_KNOWN_HOSTS_FILE = "/run/yesimbot/anon-vm/anon_known_hosts";
const REMOTE_MARKER_PREFIX = "/tmp/yesimbot-guest-exec-";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 30_000;
const DEFAULT_KILL_GRACE_MS = 250;
const REMOTE_CLEANUP_TIMEOUT_MS = 10_000;
const TIMEOUT_EXIT_CODE = 124;
const CANCEL_EXIT_CODE = 130;

const REMOTE_EXEC_SCRIPT = String.raw`set -eu

token=$1
cwd=$2
command=$3
marker=/tmp/yesimbot-guest-exec-$token.pid
umask 077
printf '%s\n' "$$" > "$marker"

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -s "$marker" ]; then
    while IFS= read -r pid; do
      case "$pid" in
        ''|*[!0-9]*) continue ;;
        "$$") continue ;;
        *) kill -TERM -- "-$pid" 2>/dev/null || true ;;
      esac
    done < "$marker"
  fi
  rm -f -- "$marker"
  exit "$status"
}

trap cleanup EXIT HUP INT TERM
cd -- "$cwd"
setsid /bin/bash --noprofile --norc -c "$command" &
child=$!
printf '%s\n%s\n' "$$" "$child" > "$marker"
set +e
wait "$child"
status=$?
set -e
exit "$status"
`;

const DEFAULT_GUEST_SSH: GuestSshConfig = {
  sshPath: SSH_PATH,
  host: GUEST_HOST,
  port: GUEST_PORT,
  user: GUEST_USER,
  identityFile: GUEST_IDENTITY_FILE,
  knownHostsFile: GUEST_KNOWN_HOSTS_FILE,
};

type TerminationReason = "abort" | "timeout" | "stop";

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
};

type CleanupResult = {
  readonly ok: boolean;
  readonly detail?: string;
};

type SpawnProcess = typeof spawn;

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

export interface GuestSshConfig {
  readonly sshPath: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly identityFile: string;
  readonly knownHostsFile: string;
}

export interface HostRunnerOptions {
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly killGraceMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: SpawnProcess;
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly guestSsh?: Partial<GuestSshConfig>;
  readonly cleanupTimeoutMs?: number;
  readonly tokenGenerator?: () => string;
}

class HostRunnerImpl implements HostRunner {
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly spawnProcess: SpawnProcess;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly guestSsh: GuestSshConfig;
  private readonly cleanupTimeoutMs: number;
  private readonly tokenGenerator: () => string;
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
    this.environment = options.environment ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.guestSsh = { ...DEFAULT_GUEST_SSH, ...options.guestSsh };
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? REMOTE_CLEANUP_TIMEOUT_MS;
    this.tokenGenerator = options.tokenGenerator ?? (() => randomBytes(16).toString("hex"));

    if (!Number.isSafeInteger(this.defaultTimeoutMs) || this.defaultTimeoutMs <= 0) {
      throw new Error("Guest runner defaultTimeoutMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.maxTimeoutMs) || this.maxTimeoutMs < this.defaultTimeoutMs) {
      throw new Error("Guest runner maxTimeoutMs must be an integer at least defaultTimeoutMs");
    }
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new Error("Guest runner maxOutputBytes must be a positive integer");
    }
    if (!Number.isSafeInteger(this.killGraceMs) || this.killGraceMs < 0) {
      throw new Error("Guest runner killGraceMs must be a non-negative integer");
    }
    if (!Number.isSafeInteger(this.cleanupTimeoutMs) || this.cleanupTimeoutMs <= 0) {
      throw new Error("Guest runner cleanupTimeoutMs must be a positive integer");
    }
  }

  public run(input: HostRunnerInput): Promise<HostCommandResult> {
    try {
      validateInput(input, this.platform, this.maxTimeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.stopped) return Promise.reject(new Error("Guest runner is stopped"));
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

    const token = this.tokenGenerator();
    if (!/^[a-f0-9]{32,64}$/.test(token)) throw new Error("Guest runner token generator returned an invalid token");
    const args = buildGuestSshArgs(entry.input, token, this.guestSsh);
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
        child = this.spawnProcess(this.guestSsh.sshPath, args, spawnOptions);
      } catch (error) {
        reject(error);
        return;
      }
      this.children.add(child);
      let settled = false;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      let cleanupPromise: Promise<CleanupResult> | undefined;

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
        cleanupPromise ??= this.cleanupRemote(token);
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
        void (cleanupPromise ?? Promise.resolve<CleanupResult>({ ok: true }))
          .then((cleanup) => finish(appendCleanupResult(result, cleanup)))
          .catch(fail);
      });

      if (entry.terminationReason) {
        terminate(entry.terminationReason);
      } else {
        timeoutTimer = setTimeout(() => terminate("timeout"), this.resolveTimeout(entry.input.timeoutMs));
        timeoutTimer.unref?.();
      }
    });
  }

  private cleanupRemote(token: string): Promise<CleanupResult> {
    const args = buildGuestCleanupSshArgs(token, this.guestSsh);
    const spawnOptions: SpawnOptions = {
      cwd: "/",
      env: this.environment,
      detached: this.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    };

    return new Promise<CleanupResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawnProcess(this.guestSsh.sshPath, args, spawnOptions);
      } catch (error) {
        resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) });
        return;
      }
      this.children.add(child);
      const stderr = createBoundedBuffer(4_000);
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const settle = (result: CleanupResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.children.delete(child);
        resolve(result);
      };
      const killCleanup = (): void => {
        signalProcessGroup(child, "SIGKILL", this.platform, this.killProcess);
        settle({ ok: false, detail: "cleanup SSH timed out" });
      };

      child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
      child.once("error", (error) => settle({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
      child.once("close", (code) => {
        settle(code === 0 ? { ok: true } : { ok: false, detail: stderr.toString() || `cleanup SSH exited with ${code ?? 1}` });
      });
      timer = setTimeout(killCleanup, this.cleanupTimeoutMs);
      timer.unref?.();
    });
  }
}

export function createHostRunner(options: HostRunnerOptions = {}): HostRunner {
  return new HostRunnerImpl(options);
}

export function buildGuestSshArgs(input: HostRunnerInput, token: string, config: GuestSshConfig = DEFAULT_GUEST_SSH): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${config.knownHostsFile}`,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "PubkeyAuthentication=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ClearAllForwardings=yes",
    "-p",
    String(config.port),
    "-i",
    config.identityFile,
    `${config.user}@${config.host}`,
    buildRemoteExecCommand(token, input.cwd, input.command),
  ];
}

export function buildGuestCleanupSshArgs(token: string, config: GuestSshConfig = DEFAULT_GUEST_SSH): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${config.knownHostsFile}`,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "PubkeyAuthentication=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ClearAllForwardings=yes",
    "-p",
    String(config.port),
    "-i",
    config.identityFile,
    `${config.user}@${config.host}`,
    buildRemoteCleanupCommand(token),
  ];
}

function buildRemoteExecCommand(token: string, cwd: string, command: string): string {
  return [
    shellQuote("/usr/bin/setsid"),
    shellQuote("/bin/bash"),
    shellQuote("--noprofile"),
    shellQuote("--norc"),
    shellQuote("-c"),
    shellQuote(REMOTE_EXEC_SCRIPT),
    shellQuote("yesimbot-guest-exec"),
    shellQuote(token),
    shellQuote(cwd),
    shellQuote(command),
  ].join(" ");
}

function buildRemoteCleanupCommand(token: string): string {
  const marker = `${REMOTE_MARKER_PREFIX}${token}.pid`;
  const script = `set +e\nmarker=${shellQuote(marker)}\nif [ -s "$marker" ]; then\n  while IFS= read -r pid; do\n    case "$pid" in ''|*[!0-9]*) continue ;; *) kill -TERM -- "-$pid" 2>/dev/null || true ;; esac\n  done < "$marker"\n  sleep 0.2\n  while IFS= read -r pid; do\n    case "$pid" in ''|*[!0-9]*) continue ;; *) kill -KILL -- "-$pid" 2>/dev/null || true ;; esac\n  done < "$marker"\n  rm -f -- "$marker"\nfi\nexit 0\n`;
  return [shellQuote("/bin/bash"), shellQuote("--noprofile"), shellQuote("--norc"), shellQuote("-c"), shellQuote(script)].join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function validateInput(input: HostRunnerInput, platform: NodeJS.Platform, maxTimeoutMs: number): void {
  if (platform !== "linux") throw new Error("Guest runner requires Linux support");
  if (typeof input.command !== "string" || input.command.length === 0) throw new Error("Guest command must be a non-empty string");
  if (input.command.includes("\u0000")) throw new Error("Guest command must not contain NUL bytes");
  if (typeof input.cwd !== "string" || input.cwd.length === 0 || !input.cwd.startsWith("/")) {
    throw new Error("Guest command cwd must be an absolute POSIX path");
  }
  if (input.cwd.includes("\u0000")) throw new Error("Guest command cwd must not contain NUL bytes");
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > maxTimeoutMs)) {
    throw new Error(`Guest command timeoutMs must be an integer between 1 and ${maxTimeoutMs}`);
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
  };
}

function appendTerminationMessage(stderr: string, reason: TerminationReason | undefined, timeoutMs: number): string {
  if (!reason) return stderr;
  const message = reason === "timeout" ? `Command timed out after ${timeoutMs}ms` : "Command cancelled";
  return stderr.length > 0 ? `${stderr}\n${message}` : message;
}

function appendCleanupResult(result: HostCommandResult, cleanup: CleanupResult): HostCommandResult {
  if (cleanup.ok) return result;
  const detail = cleanup.detail ? `: ${cleanup.detail}` : "";
  return { ...result, stderr: `${result.stderr}${result.stderr.length > 0 ? "\n" : ""}Remote cleanup status unknown${detail}` };
}

function cancellationResult(reason: TerminationReason, timeoutMs: number): HostCommandResult {
  return {
    stdout: "",
    stderr: reason === "timeout" ? `Command timed out after ${timeoutMs}ms` : "Command cancelled",
    exitCode: reason === "timeout" ? TIMEOUT_EXIT_CODE : CANCEL_EXIT_CODE,
    ...(reason === "timeout" ? { timedOut: true } : { cancelled: true }),
  };
}
