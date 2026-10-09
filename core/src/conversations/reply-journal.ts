import { createMessageEntry, type AgentEntry, type AgentPlugin } from "@yesimbot/agent-runtime";

import {
  createReplyDeliveryCheckpoint,
  createReplyDeliveryClose,
  createReplyDeliveryLateObservation,
  createReplyDeliveryProofMessage,
  createReplyDeliveryStart,
  isReplyDeliveryProof,
  excludeCurrentReplyJournal,
  type ReplyDeliveryLateObservation,
  type ReplyDeliveryProofData,
} from "./reply-receipt.js";

export const DEFAULT_LATE_OBSERVATION_MS = 5_000;

export const DEFAULT_REPLY_PROOF_WRITE_MS = 5_000;

export interface ReplyJournalStartInput {
  readonly turnId: string;
  readonly phaseId: string;
  readonly toolCallId: string;
  readonly channelId: string;
  readonly expectedUnits: readonly { readonly kind: "text" | "sticker"; readonly segments: number }[];
  readonly inputFingerprint: string;
}

export interface ReplyProofWriter {
  readonly invocationId: string;
  checkpoint(input: {
    readonly sequence: number;
    readonly unitIndex: number;
    readonly unitKind: "text" | "sticker";
    readonly segmentIndex: number;
    readonly messageIds: readonly string[];
    readonly unitText?: string;
    readonly stickerId?: string;
    readonly contentHash?: string;
  }): Promise<void>;
  close(input: {
    readonly sequence: number;
    readonly status: "complete" | "failed";
    readonly failureStage?: "preflight" | "delivery";
    readonly failedUnitIndex?: number;
    readonly uncertainTransport?: "text" | "sticker";
  }): Promise<void>;
  /**
   * Bounded late observation for an already-attempted transport boundary. It appends actual IDs
   * only; it can never start another send, revive the plan or re-open the turn.
   */
  observeLate(input: {
    readonly unitIndex: number;
    readonly unitKind: "text" | "sticker";
    readonly segmentIndex: number;
    readonly ids: Promise<readonly string[] | undefined>;
    readonly unitText?: string;
    readonly stickerId?: string;
    readonly contentHash?: string;
    readonly onObserved?: (ids: readonly string[]) => void;
    readonly timeoutMs?: number;
    readonly onWarn?: (reason: string) => void;
  }): void;
}

export interface ReplyJournalWriter {
  begin(input: ReplyJournalStartInput): Promise<ReplyProofWriter | undefined>;
}

export interface ReplyJournalSink {
  /** Appends one entry only while the captured session/generation is still the live one. */
  append(entry: AgentEntry, expected: { readonly sessionId: string; readonly generation: number; readonly signal?: AbortSignal }): Promise<void>;
}

export interface ReplyJournalBeginInput extends ReplyJournalStartInput, ReplyProofWriteOptions {
  readonly sink: ReplyJournalSink;
  readonly sessionId: string;
  readonly generation: number;
  readonly invocationId: string;
}

interface ReplyProofWriteOptions {
  readonly writeTimeoutMs?: number;
  /** Observe the bounded local work, not an ignored disk promise or pending remote send. */
  readonly onWrite?: (task: Promise<void>) => void;
}

/**
 * A serialized, generation-bound writer. It never inherits the SDK execution abort signal: effects
 * that already happened locally must remain readable even when cancellation discards the tool result.
 */
export class ConversationReplyProofWriter implements ReplyProofWriter {
  public readonly invocationId: string;
  private sequence = 0;
  private closed = false;
  private lateObserved = false;
  private writing = false;
  private poisoned = false;

  public constructor(
    private readonly options: {
      readonly invocationId: string;
      readonly turnId: string;
      readonly sessionId: string;
      readonly generation: number;
      readonly sink: ReplyJournalSink;
    } & ReplyProofWriteOptions,
  ) {
    this.invocationId = options.invocationId;
  }

  public async checkpoint(input: {
    readonly sequence: number;
    readonly unitIndex: number;
    readonly unitKind: "text" | "sticker";
    readonly segmentIndex: number;
    readonly messageIds: readonly string[];
    readonly unitText?: string;
    readonly stickerId?: string;
    readonly contentHash?: string;
  }): Promise<void> {
    if (this.closed) throw new Error("ReplyJournalClosed");
    if (input.sequence !== this.sequence + 1) throw new Error("ReplyJournalSequenceConflict");
    await this.append(
      createReplyDeliveryCheckpoint({
        invocationId: this.invocationId,
        turnId: this.options.turnId,
        sequence: input.sequence,
        unitIndex: input.unitIndex,
        unitKind: input.unitKind,
        segmentIndex: input.segmentIndex,
        messageIds: [...input.messageIds],
        ...(input.unitText === undefined ? {} : { unitText: input.unitText }),
        ...(input.stickerId === undefined ? {} : { stickerId: input.stickerId }),
        ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
      }),
    );
    this.sequence = input.sequence;
  }

  public async close(input: {
    readonly sequence: number;
    readonly status: "complete" | "failed";
    readonly failureStage?: "preflight" | "delivery";
    readonly failedUnitIndex?: number;
    readonly uncertainTransport?: "text" | "sticker";
  }): Promise<void> {
    if (this.closed) throw new Error("ReplyJournalClosed");
    if (input.sequence !== this.sequence + 1) throw new Error("ReplyJournalSequenceConflict");
    await this.append(
      createReplyDeliveryClose({
        invocationId: this.invocationId,
        turnId: this.options.turnId,
        sequence: input.sequence,
        status: input.status,
        ...(input.failureStage === undefined ? {} : { failureStage: input.failureStage }),
        ...(input.failedUnitIndex === undefined ? {} : { failedUnitIndex: input.failedUnitIndex }),
        ...(input.uncertainTransport === undefined ? {} : { uncertainTransport: input.uncertainTransport }),
      }),
    );
    this.sequence = input.sequence;
    this.closed = true;
  }

  public observeLate(input: {
    readonly unitIndex: number;
    readonly unitKind: "text" | "sticker";
    readonly segmentIndex: number;
    readonly ids: Promise<readonly string[] | undefined>;
    readonly unitText?: string;
    readonly stickerId?: string;
    readonly contentHash?: string;
    readonly onObserved?: (ids: readonly string[]) => void;
    readonly timeoutMs?: number;
    readonly onWarn?: (reason: string) => void;
  }): void {
    if (!this.closed || this.lateObserved || this.poisoned) return;
    this.lateObserved = true;
    const timeoutMs = Math.max(0, input.timeoutMs ?? DEFAULT_LATE_OBSERVATION_MS);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      input.onWarn?.("reply_delivery_late_observation_timeout");
    }, timeoutMs);
    timer.unref?.();
    void input.ids.then(
      async (ids) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ids?.length) return;
        try {
          input.onObserved?.(ids);
        } catch {
          /* A notice cannot revoke actual IDs. */
        }
        const observation: Omit<ReplyDeliveryLateObservation, "version" | "kind" | "timestamp"> = {
          invocationId: this.invocationId,
          turnId: this.options.turnId,
          sequence: this.sequence + 1,
          unitIndex: input.unitIndex,
          unitKind: input.unitKind,
          segmentIndex: input.segmentIndex,
          messageIds: [...ids],
          ...(input.unitText === undefined ? {} : { unitText: input.unitText }),
          ...(input.stickerId === undefined ? {} : { stickerId: input.stickerId }),
          ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
        };
        try {
          await this.append(createReplyDeliveryLateObservation(observation));
          this.sequence += 1;
        } catch {
          input.onWarn?.("reply_delivery_late_observation_failed");
        }
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
      },
    );
  }

  private async append(data: ReplyDeliveryProofData): Promise<void> {
    if (this.poisoned) throw new Error("ReplyJournalWriteUnsettled");
    if (this.writing) throw new Error("ReplyJournalWriteInProgress");
    this.writing = true;
    const id = `reply-proof:${this.invocationId}:${data.kind}:${"sequence" in data ? data.sequence : "start"}`;
    try {
      await appendBoundedProof(
        this.options.sink,
        createMessageEntry(createReplyDeliveryProofMessage(data, { id, timestamp: data.timestamp }), { id, timestamp: data.timestamp }),
        { sessionId: this.options.sessionId, generation: this.options.generation },
        this.options,
      );
    } catch (cause) {
      // A timeout is not a definite disk failure. No close/checkpoint may reuse its sequence,
      // including if the ignored append eventually commits after this tool has returned.
      if (cause instanceof ReplyProofWriteTimeout) this.poisoned = true;
      throw cause;
    } finally {
      this.writing = false;
    }
  }
}

class ReplyProofWriteTimeout extends Error {
  public constructor() {
    super("ReplyProofWriteTimeout");
  }
}

/** Starts one admissible invocation before any transport; failure means no platform output. */
export async function beginReplyJournal(input: ReplyJournalBeginInput): Promise<ReplyProofWriter | undefined> {
  const start = createReplyDeliveryStart({
    invocationId: input.invocationId,
    phaseId: input.phaseId,
    toolCallId: input.toolCallId,
    turnId: input.turnId,
    channelId: input.channelId,
    sessionId: input.sessionId,
    generation: input.generation,
    inputFingerprint: input.inputFingerprint,
    expectedUnits: input.expectedUnits.map((unit) => ({ kind: unit.kind, segments: unit.segments })),
  });
  const writer = new ConversationReplyProofWriter({
    invocationId: input.invocationId,
    turnId: input.turnId,
    sessionId: input.sessionId,
    generation: input.generation,
    sink: input.sink,
    writeTimeoutMs: input.writeTimeoutMs,
    onWrite: input.onWrite,
  });
  const id = `reply-proof:${input.invocationId}:start`;
  try {
    await appendBoundedProof(
      input.sink,
      createMessageEntry(createReplyDeliveryProofMessage(start, { id, timestamp: start.timestamp }), { id, timestamp: start.timestamp }),
      { sessionId: input.sessionId, generation: input.generation },
      input,
    );
  } catch {
    return undefined;
  }
  return writer;
}

/**
 * History projection. Current-turn journal metadata is provider-invisible (live signed SDK pairs stay
 * untouched); a later turn sees only the proven public units through the canonical model-input path.
 */
export function createReplyJournalHistoryPlugin(): AgentPlugin {
  return {
    name: "core.reply-journal-history",
    enforce: "pre",
    transformEntries: (entries, context) => excludeCurrentReplyJournal(entries, context?.turnId),
    toModelMessages: (message) => (isReplyDeliveryProof(message) ? [] : undefined),
  };
}

/** A queued write expires before starting; an already-started append cannot be recalled. */
function appendBoundedProof(
  sink: ReplyJournalSink,
  entry: AgentEntry,
  expected: { sessionId: string; generation: number },
  options: ReplyProofWriteOptions,
): Promise<void> {
  const controller = new AbortController();
  const timeoutMs = Math.min(DEFAULT_REPLY_PROOF_WRITE_MS, Math.max(1, options.writeTimeoutMs ?? DEFAULT_REPLY_PROOF_WRITE_MS));
  const task = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new ReplyProofWriteTimeout());
    }, timeoutMs);
    timer.unref?.();
    // Consume late resolution/rejection. Do not retry; the append may have reached disk already.
    void Promise.resolve()
      .then(() => sink.append(entry, { ...expected, signal: controller.signal }))
      .then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (cause: unknown) => {
          clearTimeout(timer);
          reject(cause);
        },
      );
  });
  try {
    options.onWrite?.(task);
  } catch {
    /* Diagnostics cannot change proof persistence. */
  }
  return task;
}
