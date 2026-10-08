import type { AgentMessage } from "@yesimbot/agent-runtime";

export interface StickerPreviewEvidence {
  readonly stickerId: string;
  readonly mediaType: string;
  readonly contentHash: string;
  readonly mode: "native" | "description";
  readonly toolCallId: string;
}

/** Channel-instance, turn-local evidence. A new preview invalidates earlier in-flight reads. */
export class StickerPreviewGate {
  private turnId: string | undefined;
  private evidence: StickerPreviewEvidence | undefined;
  private generation = 0;

  public begin(turnId: string): number {
    this.turnId = turnId;
    this.evidence = undefined;
    return ++this.generation;
  }

  public record(turnId: string, evidence: StickerPreviewEvidence, ticket: number, signal?: AbortSignal): boolean {
    if (signal?.aborted || this.turnId !== turnId || this.generation !== ticket) return false;
    this.evidence = evidence;
    return true;
  }

  public resolve(turnId: string, messages: readonly AgentMessage[]): StickerPreviewEvidence | undefined {
    const evidence = this.turnId === turnId ? this.evidence : undefined;
    return evidence && hasCompletedPreviewResult(messages, evidence) ? evidence : undefined;
  }

  public clearTurn(turnId: string): void {
    if (this.turnId === turnId) this.clear();
  }

  public clear(): void {
    this.generation += 1;
    this.turnId = undefined;
    this.evidence = undefined;
  }
}

/** Single send claim; an ambiguous transport failure never licenses an automatic duplicate. */
export class StickerSendSlot {
  private turnId: string | undefined;
  private state: "pending" | "delivered" | "uncertain" | undefined;

  public tryClaim(turnId: string, signal?: AbortSignal): "claimed" | "already" | "closed" {
    if (signal?.aborted) return "closed";
    if (this.state) return "already";
    this.turnId = turnId;
    this.state = "pending";
    return "claimed";
  }

  public release(turnId: string): void {
    if (this.turnId === turnId && this.state === "pending") this.clear();
  }

  public confirm(turnId: string): void {
    if (this.turnId === turnId && this.state === "pending") this.state = "delivered";
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
  }
}

/** Runtime appends these results only after all tools in the producing step finish. */
export function hasCompletedPreviewResult(messages: readonly AgentMessage[], evidence: StickerPreviewEvidence): boolean {
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
