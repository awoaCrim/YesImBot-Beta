const DEFAULT_TTL_MS = 60_000;
const DEFAULT_CAPACITY = 16;

export interface EphemeralImageProjection {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface EphemeralImageProjectionStage extends EphemeralImageProjection {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
}

/**
 * Multi-frame variant for tools whose evidence is a bounded sample rather than one image, for
 * example a GIF preview. Frames share one call id, one TTL and one cleanup boundary.
 */
export interface EphemeralImageFramesStage {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly frames: readonly EphemeralImageProjection[];
  readonly signal?: AbortSignal;
}

export interface EphemeralImageProjectionStoreOptions {
  readonly ttlMs?: number;
  readonly capacity?: number;
}

interface PendingImageProjection {
  readonly frames: readonly EphemeralImageProjection[];
  readonly turnId: string;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  timeout: NodeJS.Timeout;
}

/**
 * Keeps image bytes available only for the bounded live-turn projection window.
 * Durable message sanitization remains a separate storage-boundary concern.
 */
export class EphemeralImageProjectionStore {
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly pending = new Map<string, PendingImageProjection>();

  public constructor(options: EphemeralImageProjectionStoreOptions = {}) {
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS);
    this.capacity = positiveInteger(options.capacity, DEFAULT_CAPACITY);
  }

  public stage(input: EphemeralImageProjectionStage): boolean {
    return this.stageFrames({
      toolCallId: input.toolCallId,
      turnId: input.turnId,
      frames: [{ bytes: input.bytes, mediaType: input.mediaType }],
      signal: input.signal,
    });
  }

  /** Stages a bounded frame set under one call id; an aborted signal releases any previous set. */
  public stageFrames(input: EphemeralImageFramesStage): boolean {
    this.clear(input.toolCallId);
    if (input.signal?.aborted) return false;
    const frames = input.frames.filter((frame) => frame.bytes instanceof Uint8Array && frame.bytes.byteLength > 0);
    if (frames.length === 0) return false;

    while (this.pending.size >= this.capacity) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.clear(oldest);
    }

    const onAbort = () => this.clear(input.toolCallId);
    const timeout = this.createTimeout(input.toolCallId);
    this.pending.set(input.toolCallId, {
      frames: frames.map((frame) => ({ bytes: frame.bytes, mediaType: frame.mediaType })),
      turnId: input.turnId,
      signal: input.signal,
      onAbort,
      timeout,
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    return true;
  }

  public get(toolCallId: string): EphemeralImageProjection | undefined {
    return this.getFrames(toolCallId)[0];
  }

  /** Returns every staged frame for the call id, refreshing only the shared sliding TTL. */
  public getFrames(toolCallId: string): readonly EphemeralImageProjection[] {
    const current = this.pending.get(toolCallId);
    if (!current) return [];
    clearTimeout(current.timeout);
    current.timeout = this.createTimeout(toolCallId);
    return current.frames;
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
