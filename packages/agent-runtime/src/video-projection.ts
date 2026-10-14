import { EphemeralProjectionRegistry } from "./ephemeral-projection.js";

export interface EphemeralVideoProjection {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  /** Opaque live owner tag; never serialized, and carries no media/policy itself. */
  readonly owner?: object;
}

export interface EphemeralVideoProjectionStage extends EphemeralVideoProjection {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly signal?: AbortSignal;
}

export interface EphemeralVideoProjectionStoreOptions {
  readonly ttlMs?: number;
  readonly capacity?: number;
}

/**
 * Typed facade over the shared payload-agnostic registry. Image consumers never receive video
 * bytes: both capabilities share only the TTL/capacity/abort/turn cleanup mechanism.
 */
export class EphemeralVideoProjectionStore {
  private readonly registry: EphemeralProjectionRegistry<EphemeralVideoProjection>;

  public constructor(options: EphemeralVideoProjectionStoreOptions = {}) {
    this.registry = new EphemeralProjectionRegistry<EphemeralVideoProjection>({
      ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
      ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
      normalize: (value) => (value.bytes instanceof Uint8Array && value.bytes.byteLength > 0 ? value : undefined),
    });
  }

  public stage(input: EphemeralVideoProjectionStage): boolean {
    return this.registry.set({
      toolCallId: input.toolCallId,
      turnId: input.turnId,
      value: { bytes: input.bytes, mediaType: input.mediaType, ...(input.owner === undefined ? {} : { owner: input.owner }) },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  public get(toolCallId: string): EphemeralVideoProjection | undefined {
    return this.registry.get(toolCallId);
  }

  public has(toolCallId: string): boolean {
    return this.registry.has(toolCallId);
  }

  public clear(toolCallId: string): void {
    this.registry.clear(toolCallId);
  }

  public clearTurn(turnId: string): void {
    this.registry.clearTurn(turnId);
  }

  public clearAll(): void {
    this.registry.clearAll();
  }
}
