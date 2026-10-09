import { EphemeralImageProjectionStore, type AgentMessage } from "@yesimbot/agent-runtime";

export interface StickerPreviewEvidence {
  readonly stickerId: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly mode: "native" | "description";
  readonly toolCallId: string;
}

export interface StickerPreviewFrame {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly label: string;
}

/**
 * Exact-content snapshot of what the model actually saw. It is captured when the preview becomes
 * real evidence, so later projection cleanup or a late preview cannot revive a stale candidate, and
 * the expression owner receives the same bytes/description the main model saw.
 */
export interface StickerViewSnapshot {
  readonly stickerId: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly mode: "native" | "description";
  readonly frames: readonly StickerPreviewFrame[];
  readonly description?: string;
}

/** Channel-instance, turn-local evidence. A new preview invalidates earlier in-flight reads. */
export class StickerPreviewGate {
  private turnId: string | undefined;
  private evidence: StickerPreviewEvidence | undefined;
  private snapshot: StickerViewSnapshot | undefined;
  private generation = 0;

  public begin(turnId: string): number {
    this.turnId = turnId;
    this.evidence = undefined;
    this.snapshot = undefined;
    return ++this.generation;
  }

  public record(turnId: string, evidence: StickerPreviewEvidence, ticket: number, signal?: AbortSignal): boolean {
    if (signal?.aborted || this.turnId !== turnId || this.generation !== ticket) return false;
    this.evidence = evidence;
    this.snapshot = undefined;
    return true;
  }

  /** Bounded actual content captured for the verified view path; never a catalog label. */
  public recordSnapshot(turnId: string, snapshot: StickerViewSnapshot, ticket: number, signal?: AbortSignal): boolean {
    if (signal?.aborted || this.turnId !== turnId || this.generation !== ticket) return false;
    if (
      this.evidence?.stickerId !== snapshot.stickerId ||
      this.evidence.contentHash !== snapshot.contentHash ||
      this.evidence.mode !== snapshot.mode ||
      this.evidence.mediaType !== snapshot.mediaType
    )
      return false;
    if (snapshot.mode === "native" && snapshot.frames.length === 0) return false;
    if (snapshot.mode === "description" && (!snapshot.description?.trim() || snapshot.description.length > 6000)) return false;
    if (
      snapshot.frames.length > 6 ||
      snapshot.frames.reduce((bytes, frame) => bytes + frame.bytes.byteLength, 0) > 5 * 1024 * 1024 ||
      snapshot.frames.some((frame) => !frame.bytes.length)
    )
      return false;
    this.snapshot = {
      ...snapshot,
      frames: snapshot.frames.map((frame) => ({ bytes: new Uint8Array(frame.bytes), mediaType: frame.mediaType, label: frame.label })),
    };
    return true;
  }

  public resolve(turnId: string, messages: readonly AgentMessage[]): StickerPreviewEvidence | undefined {
    const evidence = this.turnId === turnId ? this.evidence : undefined;
    return evidence && hasCompletedPreviewResult(messages, evidence) ? evidence : undefined;
  }

  /** Raw turn-local evidence without requiring the SDK result; internal preflight only. */
  public resolveRaw(turnId: string): StickerPreviewEvidence | undefined {
    return this.turnId === turnId ? this.evidence : undefined;
  }

  public snapshotFor(evidence: StickerPreviewEvidence): StickerViewSnapshot | undefined {
    const current = this.snapshot;
    if (evidence !== this.evidence || !current || current.stickerId !== evidence.stickerId || current.contentHash !== evidence.contentHash) return undefined;
    return current;
  }

  public clearTurn(turnId: string): void {
    if (this.turnId === turnId) this.clear();
  }

  public clear(): void {
    this.generation += 1;
    this.turnId = undefined;
    this.evidence = undefined;
    this.snapshot = undefined;
  }
}

/** Single send claim; an ambiguous transport failure never licenses an automatic duplicate. */
export class StickerSendSlot {
  private turnId: string | undefined;
  private state: "pending" | "delivered" | "uncertain" | undefined;
  private token: object | undefined;

  public claimToken(turnId: string): object | undefined {
    return this.turnId === turnId ? this.token : undefined;
  }
  public isCurrent(turnId: string, token: object): boolean {
    return this.turnId === turnId && this.token === token;
  }
  public status(turnId: string): "eligible" | "reserved" | "consumed" {
    return this.turnId !== turnId || !this.state ? "eligible" : this.state === "pending" ? "reserved" : "consumed";
  }
  public beginTransport(turnId: string, token: object): boolean {
    if (!this.isCurrent(turnId, token) || this.state !== "pending") return false;
    this.state = "uncertain";
    return true;
  }

  public tryClaim(turnId: string, signal?: AbortSignal): "claimed" | "already" | "closed" {
    if (signal?.aborted) return "closed";
    if (this.state) return "already";
    this.turnId = turnId;
    this.state = "pending";
    this.token = {};
    return "claimed";
  }

  public release(turnId: string, token?: object): void {
    if (this.turnId === turnId && (!token || this.token === token) && this.state === "pending") this.clear();
  }

  public confirm(turnId: string, token?: object): void {
    if (this.turnId === turnId && (!token || this.token === token) && (this.state === "pending" || this.state === "uncertain")) this.state = "delivered";
  }

  public markUncertain(turnId: string): void {
    if (this.turnId === turnId && this.state === "pending") this.state = "uncertain";
  }

  public isConsumed(turnId: string): boolean {
    return this.turnId === turnId && this.state !== undefined;
  }

  public clearTurn(turnId: string): void {
    if (this.turnId === turnId) this.clear();
  }

  public clear(): void {
    this.turnId = undefined;
    this.state = undefined;
    this.token = undefined;
  }
}

/** Runtime appends these results only after all tools in the producing step finish. */
export function hasCompletedPreviewResult(messages: readonly AgentMessage[], evidence: StickerPreviewEvidence | undefined, requireCall = false): boolean {
  if (!evidence) return false;
  if (requireCall) {
    const calls: number[] = [];
    const results: number[] = [];
    for (const [index, message] of messages.entries()) {
      if ((message.role !== "assistant" && message.role !== "tool") || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if ((part.type !== "tool-call" && part.type !== "tool-result") || part.toolCallId !== evidence.toolCallId) continue;
        if (part.toolName !== "sticker_preview") return false;
        if (message.role === "assistant" && part.type === "tool-call") calls.push(index);
        if (message.role === "tool" && part.type === "tool-result") results.push(index);
      }
    }
    if (calls.length !== 1 || results.length !== 1 || calls[0]! >= results[0]!) return false;
  }
  return messages.some(
    (message) =>
      message.role === "tool" &&
      Array.isArray(message.content) &&
      message.content.some((part) => {
        if (part.type !== "tool-result" || part.toolName !== "sticker_preview" || part.toolCallId !== evidence.toolCallId) return false;
        const output = part.output;
        const values: unknown[] = [];
        if (output.type === "json") values.push(output.value);
        if (output.type === "content") {
          for (const item of output.value) {
            if (item.type !== "text") continue;
            try {
              values.push(JSON.parse(item.text));
            } catch {
              /* Not a preview receipt. */
            }
          }
        }
        const valid = values.some((value) => {
          if (!value || typeof value !== "object") return false;
          const receipt = value as Record<string, unknown>;
          return (
            receipt.ok === true &&
            receipt.previewed === true &&
            receipt.id === evidence.stickerId &&
            receipt.contentHash === evidence.contentHash &&
            receipt.mode === evidence.mode &&
            (evidence.mode === "native" || (typeof receipt.description === "string" && receipt.description.trim().length > 0))
          );
        });
        // A staged native image that expired before SDK materialization is not visual evidence.
        return (
          valid &&
          (evidence.mode === "description" || (output.type === "content" && output.value.some((item) => item.type === "image-data" && item.data.length > 0)))
        );
      }),
  );
}

/** Projects one staged frame set into a bounded snapshot without leaking base64 into history. */
export function snapshotFrames(projection: EphemeralImageProjectionStore, toolCallId: string): readonly StickerPreviewFrame[] {
  return projection.getFrames(toolCallId).map((frame, index) => ({ bytes: frame.bytes, mediaType: frame.mediaType, label: `frame ${index + 1}` }));
}
