import { createHash } from "node:crypto";

import { createRandomId, type AgentMessage } from "@yesimbot/agent-runtime";
import { h, type Bot, type Element } from "koishi";

import { withAbortSignal } from "../abort.js";
import type { PacingConfig } from "../config.js";
import type { ReplyJournalWriter, ReplyProofWriter } from "../conversations/reply-journal.js";
import {
  createCompleteReceipt,
  createDeliveryFailureReceipt,
  createPreflightFailureReceipt,
  REPLY_MAX_PHASE_BYTES,
  REPLY_MAX_SEGMENT_IDS,
  REPLY_MAX_STICKERS,
  REPLY_MAX_TEXT_UNITS,
  REPLY_MAX_UNIT_TEXT_BYTES,
  REPLY_MAX_UNITS,
  replyPlatformIds,
  replyStickerId,
  type ReplyReceipt,
  type ReplyUncertainTransport,
  type ReplyUnitProof,
} from "../conversations/reply-receipt.js";
import { parseReply } from "../messages/index.js";
import { prepareOutputSegmentsWithProjection, ResourceReadError, type ChannelResources } from "../resources/index.js";
import { extractProtectedTokens, type PolisherTurnContext } from "./polisher.js";
import { pacedDelay, sleep } from "./tools.js";

export const MAX_PREPARATION_MS = 60_000;

export const MAX_EXPRESSION_PASSES = 2;

export const validPlatformIds = replyPlatformIds;

export type ReplyMode = "element" | "raw";

export type ReplyStickerStatus = "eligible" | "reserved" | "consumed" | "unavailable";

export type ReplyPart = { readonly kind: "text"; readonly text: string } | { readonly kind: "sticker"; readonly stickerId: string };

export type ReplyLayoutDraft =
  | { readonly kind: "layout"; readonly parts: readonly ReplyPart[] }
  | { readonly kind: "preview"; readonly selector: { readonly category: string } };

export interface ReplyStickerFrame {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly label: string;
}

/** A private server-owned view, never an input claim from the model. */
export interface ReplyStickerView {
  readonly stickerId: string;
  readonly contentHash: string;
  readonly mediaType: string;
  readonly mode: "native" | "description";
  readonly frames?: readonly ReplyStickerFrame[];
  readonly description?: string;
}

export interface ReplyStickerCatalogEntry {
  readonly category: string;
  readonly count: number;
}

export interface ReplyStickerTransport {
  readonly status: "confirmed" | "uncertain" | "failed";
  readonly messageIds: readonly string[];
  readonly contentHash: string;
  readonly warning?: string;
  readonly error?: string;
}

export interface ReplyStickerLease {
  readonly stickerId: string;
  readonly contentHash: string;
  /** Recheck evidence/content immediately before transport; only one attempt is allowed. */
  send(signal?: AbortSignal): Promise<ReplyStickerTransport>;
  release(): void;
}

export interface ReplyStickerProvider {
  readonly revision: number;
  status(turnId: string): ReplyStickerStatus;
  catalog(): Promise<readonly ReplyStickerCatalogEntry[]>;
  view(turnId: string, messages: readonly AgentMessage[]): Promise<ReplyStickerView | undefined>;
  /** Exact-object generation check after visual/model awaits. */
  isViewCurrent?(view: ReplyStickerView, turnId: string): boolean;
  preflight(input: {
    readonly stickerId: string;
    readonly turnId: string;
    readonly messages: readonly AgentMessage[];
    readonly signal?: AbortSignal;
    /** Server-owned permission recheck after lease awaits and immediately before transport. */
    readonly stillAllowed?: () => boolean;
  }): Promise<{ readonly lease: ReplyStickerLease } | { readonly error: string }>;
}

export interface ReplyLayoutComposeRequest {
  readonly mode: "reply-layout";
  readonly stage: 1 | 2;
  readonly facts: readonly string[];
  readonly intent: string;
  readonly verbatim: readonly string[];
  readonly turnContext: PolisherTurnContext;
  readonly profile: { readonly persona: string; readonly roleInstructions?: string; readonly characterDefinition?: string };
  readonly sticker: {
    readonly status: ReplyStickerStatus;
    readonly catalog: readonly ReplyStickerCatalogEntry[];
    readonly view?: ReplyStickerView;
    readonly consumed?: boolean;
    readonly imageInput?: boolean;
    readonly previewAvailable?: boolean;
  };
  readonly previous?: { readonly error: string };
}

export interface ReplyLayoutComposer {
  readonly name: string;
  readonly version: 1;
  readonly imageInput?: boolean;
  readonly supportsImages?: (context: unknown) => boolean;
  readonly isCurrent?: () => boolean;
  compose(request: ReplyLayoutComposeRequest, context: unknown, signal?: AbortSignal): Promise<ReplyLayoutDraft | undefined>;
}

export interface PreparedReplyUnit {
  readonly kind: "text" | "sticker";
  readonly partIndex: number;
  readonly segments?: readonly (readonly Element[])[];
  readonly text?: string;
  readonly stickerId?: string;
}

export interface ReplyPreflightResult {
  readonly ok: boolean;
  readonly totalUnits: number;
  readonly failedUnitIndex: number;
  readonly errorName?: string;
  readonly units?: readonly PreparedReplyUnit[];
}

export interface ReplyDeliveryNotice {
  readonly channelId: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly text: string;
}

export interface ReplySendFailureNotice {
  readonly channelId: string;
  readonly turnId: string;
  readonly failedAt: number;
  readonly total: number;
  readonly error: { readonly name: string; readonly message: string };
}

export interface ReplyDeliveryDeps {
  readonly bot: Bot;
  readonly channelId: string;
  readonly resources: ChannelResources;
  readonly pacing: PacingConfig;
  readonly journal: ReplyJournalWriter;
  readonly sticker?: ReplyStickerProvider;
  readonly onDelivered?: (notice: ReplyDeliveryNotice) => void;
  readonly onFailed?: (notice: ReplySendFailureNotice) => void;
  readonly onWarn?: (reason: string, detail: Record<string, unknown>) => void;
}

export interface TryDeliverReplyInput {
  readonly parts: unknown;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly messages: readonly AgentMessage[];
  readonly signal?: AbortSignal;
  readonly channel?: string;
  readonly mode?: unknown;
  readonly allowed: boolean;
  readonly stillAllowed?: () => boolean;
  readonly keepGoing?: boolean;
  readonly facts?: readonly string[];
  readonly intent?: string;
  readonly verbatim?: readonly string[];
}

export interface ReplyDeliveryOutcome {
  readonly output: Record<string, unknown>;
  readonly receipt: ReplyReceipt;
}

interface TransportBoundary {
  readonly unitIndex: number;
  readonly unitKind: "text" | "sticker";
  readonly segmentIndex: number;
  readonly unitText?: string;
  readonly stickerId?: string;
  readonly contentHash?: string;
}

interface TransportResult {
  readonly ids?: readonly string[];
  readonly uncertain?: boolean;
  readonly error?: string;
  readonly warning?: string;
}

/** Whole-phase preflight and a channel-local FIFO. No retries, recomposition, or persistent outbox. */
export class ReplyCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly active = new Map<AbortController, string>();
  public constructor(private readonly deps: ReplyDeliveryDeps) {}
  public deliver(input: TryDeliverReplyInput): Promise<ReplyDeliveryOutcome> {
    const run = this.tail.then(
      () => this.run(input),
      () => this.run(input),
    );
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  /** Only owned work: remote transport is abort-raced; already-started local proof writes settle. */
  public settle(): Promise<void> {
    return this.tail;
  }
  public abortTurn(turnId: string): void {
    for (const [controller, activeTurn] of this.active) if (activeTurn === turnId) controller.abort();
  }
  public close(): void {
    this.closed = true;
    for (const controller of this.active.keys()) controller.abort();
  }
  private allowed(input: TryDeliverReplyInput): boolean {
    try {
      return !this.closed && input.allowed && !input.signal?.aborted && (input.stillAllowed?.() ?? true);
    } catch {
      return false;
    }
  }
  private async run(original: TryDeliverReplyInput): Promise<ReplyDeliveryOutcome> {
    const controller = new AbortController();
    this.active.set(controller, original.turnId);
    const input = { ...original, signal: AbortSignal.any([controller.signal, ...(original.signal ? [original.signal] : [])]) };
    try {
      return await this.execute(input);
    } finally {
      this.active.delete(controller);
    }
  }
  private async execute(input: TryDeliverReplyInput): Promise<ReplyDeliveryOutcome> {
    const phaseId = createRandomId();
    const normalizeTarget = (channel: string) => (this.deps.bot.platform === "onebot" && channel.startsWith("group:") ? channel.slice(6) : channel);
    const target = normalizeTarget(input.channel ?? this.deps.channelId);
    if (!this.allowed(input)) return replyPreflightFailure("DeliveryNotAllowed", "本轮不能发送对外回复", phaseId);
    if (input.mode !== undefined && input.mode !== "element" && input.mode !== "raw") return replyPreflightFailure("InvalidInput", "mode 无效", phaseId);
    const mode: ReplyMode = input.mode === "raw" ? "raw" : "element";
    const parts = normalizeReplyParts(input.parts);
    if (!parts) return replyPreflightFailure("InvalidInput", "parts 必须是有界的完整有序回复", phaseId);
    const stickerIndex = parts.findIndex((part) => part.kind === "sticker");
    if (stickerIndex >= 0 && (!this.deps.sticker || target !== normalizeTarget(this.deps.channelId))) {
      return replyPreflightFailure("StickerUnavailable", "表情包只能使用当前频道的发送能力", phaseId, parts.length, stickerIndex);
    }
    const preflight = await preflightReplyPhase({
      parts,
      mode,
      resources: this.deps.resources,
      signal: input.signal,
      facts: input.facts,
      verbatim: input.verbatim,
    });
    if (!preflight.ok || !preflight.units)
      return replyPreflightFailure(
        preflight.errorName ?? "ReplyPreflightFailed",
        "发送前校验失败，未发送任何内容",
        phaseId,
        parts.length,
        preflight.failedUnitIndex,
      );
    const units = preflight.units;
    let lease: ReplyStickerLease | undefined;
    if (stickerIndex >= 0 && this.deps.sticker) {
      const part = parts[stickerIndex]!;
      if (part.kind !== "sticker") throw new Error("ReplyInvariant");
      try {
        const pending = this.deps.sticker.preflight({
          stickerId: part.stickerId,
          turnId: input.turnId,
          messages: input.messages,
          signal: input.signal,
          stillAllowed: () => this.allowed(input),
        });
        // If an ignored-cancellation preflight returns late, retire its unsent reservation.
        void pending.then(
          (result) => {
            if (input.signal?.aborted && "lease" in result) result.lease.release();
          },
          () => undefined,
        );
        const result = await withAbortSignal(pending, input.signal);
        if ("error" in result) return replyPreflightFailure(result.error, "表情包发送前校验失败", phaseId, units.length, stickerIndex);
        lease = result.lease;
      } catch {
        return replyPreflightFailure("StickerPreflightFailed", "表情包准备失败，未发送任何内容", phaseId, units.length, stickerIndex);
      }
    }
    let writer: ReplyProofWriter | undefined;
    if (this.allowed(input)) {
      try {
        writer = await this.deps.journal.begin({
          phaseId,
          turnId: input.turnId,
          toolCallId: input.toolCallId,
          channelId: target,
          expectedUnits: replyExpectedUnits(units),
          inputFingerprint: fingerprintReplyPhaseInput({
            facts: input.facts ?? [],
            intent: input.intent ?? "",
            verbatim: input.verbatim ?? [],
            target,
            mode,
            keepGoing: input.keepGoing === true,
            parts,
          }),
        });
      } catch {
        /* A missing admission proof never permits transport. */
      }
    }
    if (!writer) {
      lease?.release();
      return replyPreflightFailure("delivery_proof_persist_failed", "本地投递证明无法写入，未发送任何内容", phaseId, units.length);
    }
    const proof = writer;
    let sequence = 0;
    const complete: ReplyUnitProof[] = [];
    const actualIds: string[] = [];
    const seen = new Set<string>();
    let committedPartial: string[][] = [];
    let elapsed = 0;
    let transports = 0;
    let persistFailed = false;
    let pending: { boundary: TransportBoundary; result: Promise<TransportResult> } | undefined;
    const write = async (operation: (next: number) => Promise<void>): Promise<boolean> => {
      try {
        await operation(sequence + 1);
        sequence++;
        return true;
      } catch {
        persistFailed = true;
        return false;
      }
    };
    const stop = async (name: string, message: string, uncertain?: ReplyUncertainTransport): Promise<ReplyDeliveryOutcome> => {
      const closed = await write((next) =>
        proof.close({
          sequence: next,
          status: "failed",
          failureStage: "delivery",
          failedUnitIndex: complete.length,
          ...(uncertain ? { uncertainTransport: uncertain } : {}),
        }),
      );
      if (pending && closed) this.observeLate(proof, pending, input, target, phaseId, seen);
      lease?.release(); // A lease's release is a no-op after any attempted sticker transport.
      // Receipt mirrors only committed journal state. Actual but unpersisted IDs remain in sent;
      // they must not invalidate the durable earlier prefix or license a resend.
      const receipt = createDeliveryFailureReceipt({
        phaseId,
        totalUnits: units.length,
        completeUnits: complete,
        failedUnitIndex: complete.length,
        ...(committedPartial.length ? { incompleteSegmentIds: committedPartial.flat() } : {}),
        ...(closed && uncertain ? { uncertainTransport: uncertain } : {}),
        proof: { invocationId: proof.invocationId, sequence },
      });
      try {
        this.deps.onFailed?.({ channelId: target, turnId: input.turnId, failedAt: complete.length, total: units.length, error: { name, message } });
      } catch {
        /* Observer only. */
      }
      return {
        output: {
          ok: false,
          error: { name, message },
          sent: actualIds,
          failedAt: complete.length,
          replyReceipt: receipt,
          ...(persistFailed ? { warning: "delivery_proof_persist_failed" } : {}),
        },
        receipt,
      };
    };
    for (const [unitIndex, unit] of units.entries()) {
      const segments = unit.kind === "text" ? unit.segments! : [[h.text("")]];
      committedPartial = [];
      for (const [segmentIndex, segment] of segments.entries()) {
        if (transports) {
          const delay = pacedDelay(segment, this.deps.pacing, elapsed);
          const started = Date.now();
          try {
            await sleep(delay, input.signal);
          } catch {
            return stop("AbortError", "send_message aborted");
          }
          elapsed += Math.max(delay, Date.now() - started);
        }
        if (!this.allowed(input)) return stop("DeliveryNotAllowed", "运行环境已变化，发送中止");
        const last = segmentIndex === segments.length - 1;
        const boundary: TransportBoundary = {
          unitIndex,
          unitKind: unit.kind,
          segmentIndex,
          ...(unit.kind === "text" && last ? { unitText: unit.text! } : {}),
          ...(unit.kind === "sticker" && lease ? { stickerId: lease.stickerId, contentHash: lease.contentHash } : {}),
        };
        let result: Promise<TransportResult>;
        if (unit.kind === "sticker") {
          if (!lease) return stop("StickerUnavailable", "表情包凭证已失效");
          const claimed = lease;
          result = claimed.send(input.signal).then(
            (value) => {
              const ids = replyPlatformIds(value.messageIds);
              return value.status === "confirmed" && ids && value.contentHash === claimed.contentHash
                ? { ids, warning: value.warning }
                : { error: value.error ?? "StickerDeliveryUncertain", uncertain: value.status !== "failed" };
            },
            () => ({ error: "StickerDeliveryUncertain", uncertain: true }),
          );
        } else {
          result = Promise.resolve()
            .then(() => this.deps.bot.sendMessage(target, [...segment]))
            .then(
              (value) => {
                const ids = replyPlatformIds(value);
                return ids ? { ids } : { error: "DeliveryUnconfirmed", uncertain: true };
              },
              () => ({ error: "DeliveryFailed", uncertain: true }),
            );
        }
        transports++;
        let settled: TransportResult;
        try {
          settled = await withAbortSignal(result, input.signal);
        } catch {
          pending = { boundary, result };
          return stop("AbortError", "send_message aborted", unit.kind);
        }
        if (!settled.ids || settled.ids.some((id) => seen.has(id)))
          return stop(settled.error ?? "DeliveryUnconfirmed", "平台未返回唯一有效的投递证明", settled.uncertain || settled.ids ? unit.kind : undefined);
        for (const id of settled.ids) {
          seen.add(id);
          actualIds.push(id);
          this.notify(input.turnId, target, id, unit.text ?? "[已发送表情包]");
        }
        if (settled.warning) this.warn(settled.warning, { phaseId, turnId: input.turnId });
        const retained = await write((next) => proof.checkpoint({ sequence: next, ...boundary, messageIds: settled.ids! }));
        if (!retained) return stop("delivery_proof_persist_failed", "实际发送已发生，但证明写入失败；停止后续发送，不会重发");
        committedPartial.push([...settled.ids]);
      }
      complete.push(
        unit.kind === "text"
          ? { index: unitIndex, kind: "text", text: unit.text!, segmentMessageIds: committedPartial }
          : { index: unitIndex, kind: "sticker", stickerId: lease!.stickerId, contentHash: lease!.contentHash, messageIds: committedPartial[0]! },
      );
      committedPartial = [];
    }
    const closed = await write((next) => proof.close({ sequence: next, status: "complete" }));
    lease?.release();
    if (!closed) {
      // The final checkpoint already proves all units, but normal durable closure failed.
      const receipt = createDeliveryFailureReceipt({
        phaseId,
        totalUnits: units.length,
        completeUnits: complete,
        failedUnitIndex: units.length,
        proof: { invocationId: proof.invocationId, sequence },
      });
      return {
        output: {
          ok: false,
          error: { name: "delivery_proof_persist_failed", message: "已发送内容不会重发；本地关闭记录写入失败" },
          sent: actualIds,
          failedAt: units.length,
          replyReceipt: receipt,
          warning: "delivery_proof_persist_failed",
        },
        receipt,
      };
    }
    const receipt = createCompleteReceipt({ phaseId, units: complete, proof: { invocationId: proof.invocationId, sequence } });
    return { output: { ok: true, messageIds: actualIds, count: units.length, replyReceipt: receipt }, receipt };
  }
  private observeLate(
    writer: ReplyProofWriter,
    pending: { boundary: TransportBoundary; result: Promise<TransportResult> },
    input: TryDeliverReplyInput,
    target: string,
    phaseId: string,
    seen: Set<string>,
  ): void {
    writer.observeLate({
      ...pending.boundary,
      ids: pending.result.then((result) => (result.ids && !result.ids.some((id) => seen.has(id)) ? result.ids : undefined)),
      onObserved: (ids) => {
        for (const id of ids)
          this.notify(
            input.turnId,
            target,
            id,
            pending.boundary.unitText ?? (pending.boundary.unitKind === "sticker" ? "[已发送表情包]" : "[已确认部分文本投递]"),
          );
      },
      onWarn: (reason) => this.warn(reason, { phaseId, turnId: input.turnId }),
    });
  }
  private notify(turnId: string, channelId: string, messageId: string, text: string): void {
    try {
      this.deps.onDelivered?.({ channelId, messageId, turnId, text });
    } catch {
      /* Never revoke proof. */
    }
  }
  private warn(reason: string, detail: Record<string, unknown>): void {
    try {
      this.deps.onWarn?.(reason, detail);
    } catch {
      /* Operator observer only. */
    }
  }
}

/** Accept the wire spelling sticker_id and the typed internal spelling, but never extra fields. */
export function normalizeReplyParts(value: unknown): ReplyPart[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > REPLY_MAX_UNITS) return undefined;
  const parts: ReplyPart[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || Object.keys(entry).length !== 2) return undefined;
    if (entry.kind === "text" && typeof entry.text === "string" && entry.text.trim()) {
      parts.push({ kind: "text", text: entry.text });
    } else if (entry.kind === "sticker") {
      const id = replyStickerId(entry.sticker_id ?? entry.stickerId);
      if (!id) return undefined;
      parts.push({ kind: "sticker", stickerId: id });
    } else return undefined;
  }
  return parts;
}

export function validateReplyParts(
  parts: readonly ReplyPart[],
  bounds: { readonly allowSticker: boolean },
): { readonly ok: true } | { readonly ok: false; readonly error: string; readonly index: number } {
  const fail = (error: string, index = 0) => ({ ok: false as const, error, index });
  if (!parts.length || parts.length > REPLY_MAX_UNITS) return fail("回复单元数量超出限制");
  let texts = 0;
  let stickers = 0;
  for (const [index, part] of parts.entries()) {
    if (part.kind === "sticker") {
      if (++stickers > REPLY_MAX_STICKERS || !bounds.allowSticker || !replyStickerId(part.stickerId))
        return fail("表情包身份无效或本轮不能使用更多表情包", index);
    } else if (++texts > REPLY_MAX_TEXT_UNITS || !part.text.trim() || Buffer.byteLength(part.text) > REPLY_MAX_UNIT_TEXT_BYTES) {
      return fail("文本单元为空或超出限制", index);
    }
  }
  if (Buffer.byteLength(JSON.stringify(parts)) > REPLY_MAX_PHASE_BYTES) return fail("回复排版过长");
  return { ok: true };
}

export function projectDeliveredText(input: { readonly source: string; readonly mode: ReplyMode }): string {
  return input.mode === "raw" ? input.source : projectElements(parseReply(input.source));
}

export function layoutAnchorError(input: {
  readonly facts: readonly string[];
  readonly verbatim: readonly string[];
  readonly texts: readonly string[];
}): string | undefined {
  const required = extractProtectedTokens([...input.facts, ...input.verbatim].join("\n")).sort();
  const produced = extractProtectedTokens(input.texts.join("\n")).sort();
  if (required.length !== produced.length || required.some((token, index) => token !== produced[index])) return "必须保留的精确内容发生了变化";
  if (input.verbatim.some((payload) => !input.texts.some((text) => text.includes(payload)))) return "逐字内容必须完整出现在同一条文本中";
  return undefined;
}

export function fingerprintReplyPhaseInput(input: {
  readonly facts: readonly string[];
  readonly intent: string;
  readonly verbatim: readonly string[];
  readonly target: string;
  readonly mode: ReplyMode;
  readonly keepGoing: boolean;
  readonly parts?: readonly ReplyPart[];
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function preflightReplyPhase(options: {
  readonly parts: readonly ReplyPart[];
  readonly mode: ReplyMode;
  readonly resources: ChannelResources;
  readonly signal?: AbortSignal;
  readonly facts?: readonly string[];
  readonly verbatim?: readonly string[];
}): Promise<ReplyPreflightResult> {
  const fail = (index: number, errorName: string): ReplyPreflightResult => ({ ok: false, totalUnits: options.parts.length, failedUnitIndex: index, errorName });
  const bounds = validateReplyParts(options.parts, { allowSticker: true });
  if (!bounds.ok) return fail(bounds.index, "ReplyLayoutInvalid");
  const units: PreparedReplyUnit[] = [];
  let physical = 0;
  for (const [partIndex, part] of options.parts.entries()) {
    if (options.signal?.aborted) return fail(partIndex, "AbortError");
    if (part.kind === "sticker") {
      units.push({ kind: "sticker", partIndex, stickerId: part.stickerId });
      physical++;
    } else {
      try {
        const prepared =
          options.mode === "raw"
            ? [{ elements: [h.text(part.text)], source: [h.text(part.text)] }]
            : await withAbortSignal(prepareOutputSegmentsWithProjection(parseReply(part.text), options.resources, options.signal), options.signal);
        const body = options.mode === "raw" ? part.text : projectElements(prepared.map((segment) => segment.source));
        if (!prepared.length || !body.trim()) return fail(partIndex, "DeliveryUnconfirmed");
        units.push({ kind: "text", partIndex, segments: prepared.map((segment) => segment.elements), text: body });
        physical += prepared.length;
      } catch (cause) {
        return fail(partIndex, options.signal?.aborted ? "AbortError" : cause instanceof ResourceReadError ? cause.code : "ResourceReadFailed");
      }
    }
    if (physical > REPLY_MAX_SEGMENT_IDS) return fail(partIndex, "ReplyLayoutTooManySegments");
  }
  if (units.reduce((bytes, unit) => bytes + Buffer.byteLength(unit.text ?? ""), 0) > REPLY_MAX_PHASE_BYTES) return fail(0, "ReplyLayoutTooLarge");
  // Check the representation actually surviving parsing/materialization, not the private source.
  for (const payload of options.verbatim ?? []) {
    const represented = projectDeliveredText({ source: payload, mode: options.mode });
    if (!represented.trim() || !units.some((unit) => unit.kind === "text" && (unit.text?.includes(payload) || unit.text?.includes(represented)))) {
      const index = options.parts.findIndex((part) => part.kind === "text" && part.text.includes(payload));
      return fail(Math.max(0, index), "VerbatimErased");
    }
  }
  if (options.facts !== undefined) {
    const required = publicAnchorTokens([...options.facts, ...(options.verbatim ?? [])].join("\n"), options.mode);
    const delivered = publicAnchorTokens(units.flatMap((unit) => (unit.kind === "text" ? [unit.text!] : [])).join("\n"), options.mode);
    if (required.length !== delivered.length || required.some((token, index) => token !== delivered[index])) return fail(0, "ReplyAnchorsErased");
  }
  return { ok: true, totalUnits: units.length, failedUnitIndex: 0, units };
}

export function replyExpectedUnits(units: readonly PreparedReplyUnit[]): { kind: "text" | "sticker"; segments: number }[] {
  return units.map((unit) => ({ kind: unit.kind, segments: unit.segments?.length ?? 1 }));
}

export function replyPreflightFailure(name: string, message: string, phaseId = createRandomId(), totalUnits = 0, failedUnitIndex = 0): ReplyDeliveryOutcome {
  const receipt = createPreflightFailureReceipt({ phaseId, totalUnits, failedUnitIndex });
  return { output: { ok: false, error: { name, message }, sent: [], failedAt: receipt.failedUnitIndex, replyReceipt: receipt }, receipt };
}

export function replyComposerImageInput(
  view: ReplyStickerView | undefined,
): { readonly frames: readonly ReplyStickerFrame[]; readonly labels: readonly string[] } | undefined {
  return view?.mode === "native" && view.frames?.length ? { frames: view.frames, labels: view.frames.map((frame) => frame.label) } : undefined;
}

/** Literal text is kept literal; public element identities/attributes survive without expanded bytes. */
function projectElements(segments: readonly (readonly Element[])[]): string {
  const sanitizeElement = (element: Element): Element => {
    const attrs = { ...element.attrs };
    for (const key of Object.keys(attrs)) {
      if (typeof attrs[key] === "string" && /data:[^;\s]+;base64,/i.test(attrs[key])) attrs[key] = "[media]";
    }
    return h(element.type, attrs, element.children.map(sanitizeElement));
  };
  const elementText = (element: Element): string => (element.type === "text" ? String(element.attrs.content ?? "") : String(sanitizeElement(element)));
  return segments.map((segment) => segment.map(elementText).join("")).join("\n");
}

/** Parsing-only wrappers are not outward anchors; their inner numeric/URI/text anchors still are. */
function publicAnchorTokens(text: string, mode: ReplyMode): string[] {
  return extractProtectedTokens(text)
    .flatMap((token) => {
      if (mode === "raw") return [token];
      if (/^<\/?(?:text|message|inner_thought)\b[^<>]*>$/i.test(token)) return [];
      return extractProtectedTokens(projectDeliveredText({ source: token, mode }));
    })
    .sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { REPLY_MAX_PHASE_BYTES, REPLY_MAX_UNITS };

export type { ReplyJournalWriter, ReplyProofWriter };
