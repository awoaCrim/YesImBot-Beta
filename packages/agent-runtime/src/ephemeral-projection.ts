const DEFAULT_TTL_MS = 60_000;
const DEFAULT_CAPACITY = 16;

export interface EphemeralProjectionSetInput<T> {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly value: T;
  readonly signal?: AbortSignal;
}

export interface EphemeralProjectionRegistryOptions<T> {
  readonly ttlMs?: number;
  readonly capacity?: number;
  /** Returns undefined when the value cannot be projected; called after clearing a reused call id. */
  readonly normalize: (value: T) => T | undefined;
}

interface PendingProjection<T> {
  readonly value: T;
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  timeout: NodeJS.Timeout;
}

/**
 * Payload-agnostic ephemeral ownership: one call id, one sliding TTL, one capacity slot and one
 * abort/turn cleanup boundary. Payload owners supply validation; callers own routing and policy.
 */
export class EphemeralProjectionRegistry<T> {
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly normalize: (value: T) => T | undefined;
  private readonly pending = new Map<string, PendingProjection<T>>();

  public constructor(options: EphemeralProjectionRegistryOptions<T>) {
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS);
    this.capacity = positiveInteger(options.capacity, DEFAULT_CAPACITY);
    this.normalize = options.normalize;
  }

  /** Stages one value under a call id; a reused id or aborted signal never inherits earlier bytes. */
  public set(input: EphemeralProjectionSetInput<T>): boolean {
    this.clear(input.toolCallId);
    if (input.signal?.aborted) return false;
    const value = this.normalize(input.value);
    if (value === undefined) return false;

    while (this.pending.size >= this.capacity) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.clear(oldest);
    }

    const onAbort = () => this.clear(input.toolCallId);
    const timeout = this.createTimeout(input.toolCallId);
    this.pending.set(input.toolCallId, { value, turnId: input.turnId, signal: input.signal, onAbort, timeout });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    return true;
  }

  /** Returns the staged value while refreshing only the sliding TTL. */
  public get(toolCallId: string): T | undefined {
    const current = this.pending.get(toolCallId);
    if (!current) return undefined;
    clearTimeout(current.timeout);
    current.timeout = this.createTimeout(toolCallId);
    return current.value;
  }

  /** True while the call id still owns a live projection; used to reject evidence after abort. */
  public has(toolCallId: string): boolean {
    return this.pending.has(toolCallId);
  }

  public clear(toolCallId: string): void {
    const current = this.pending.get(toolCallId);
    if (!current) return;
    this.pending.delete(toolCallId);
    clearTimeout(current.timeout);
    if (current.signal && current.onAbort) current.signal.removeEventListener("abort", current.onAbort);
  }

  public clearTurn(turnId: string): void {
    for (const [toolCallId, current] of this.pending) {
      if (current.turnId === turnId) this.clear(toolCallId);
    }
  }

  public clearAll(): void {
    for (const toolCallId of [...this.pending.keys()]) this.clear(toolCallId);
  }

  private createTimeout(toolCallId: string): NodeJS.Timeout {
    const timeout = setTimeout(() => this.clear(toolCallId), this.ttlMs);
    timeout.unref?.();
    return timeout;
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}
