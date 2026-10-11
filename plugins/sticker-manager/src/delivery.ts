import type { AgentMessage } from "@yesimbot/agent-runtime";
import {
  replyPlatformIds,
  RESOURCE_MAX_BYTES,
  withAbortSignal,
  type ChannelContext,
  type ReplyStickerLease,
  type ReplyStickerTransport,
  type ReplyStickerView,
} from "koishi-plugin-yesimbot";

import { detectImageMediaType, sha256Hex } from "./files.js";
import { prepareStaticGif } from "./frames.js";
import { hasCompletedPreviewResult, type StickerPreviewEvidence, type StickerPreviewGate, type StickerSendSlot } from "./preview-evidence.js";
import type { StickerSender } from "./sender.js";
import type { StickerRecordBinding, StickerStore } from "./store.js";
import { scopeKeyFor, type StickerConfig } from "./types.js";

export interface StickerProviderLease extends ReplyStickerLease {
  readonly category: string;
  readonly tags: readonly string[];
}

/** Standalone and modern sends share exact records/bytes, one slot, preparation and accounting. */
export class StickerDeliveryService {
  private readonly views = new WeakMap<ReplyStickerView, { evidence: StickerPreviewEvidence; turnId: string }>();
  private readonly reservations = new Map<() => void, string>();
  private closedTurn: string | undefined;
  private retired = false;

  public finishTurn(turnId: string): void {
    this.closedTurn = turnId;
    for (const [release, ownedTurn] of this.reservations) if (ownedTurn === turnId) release();
    this.options.sendSlot.clearTurn(turnId);
    this.options.previewGate.clearTurn(turnId);
  }

  public stop(): void {
    this.retired = true;
    for (const release of this.reservations.keys()) release();
    this.options.sendSlot.clear();
    this.options.previewGate.clear();
  }
  public constructor(
    private readonly options: {
      readonly store: StickerStore;
      readonly sender: StickerSender;
      readonly scope: ChannelContext;
      readonly config: StickerConfig;
      readonly sendSlot: StickerSendSlot;
      readonly previewGate: StickerPreviewGate;
      readonly captureTurn?: (turnId: string) => () => boolean;
      readonly onUsageWarning?: (stickerId: string, cause: unknown) => void;
    },
  ) {}
  public get scopeKey(): string {
    return scopeKeyFor(this.options.scope, this.options.config);
  }
  public status(turnId: string): "eligible" | "reserved" | "consumed" {
    return this.options.sendSlot.status(turnId);
  }
  public async catalog(): Promise<readonly { category: string; count: number }[]> {
    const result: { category: string; count: number }[] = [];
    for (const item of await this.options.store.listCategories(this.scopeKey)) {
      const entry = { category: item.category, count: item.count };
      if (result.length >= 20 || JSON.stringify([...result, entry]).length > 2000) break;
      result.push(entry);
    }
    return result;
  }
  public isViewCurrent(view: ReplyStickerView, turnId: string): boolean {
    const owned = this.views.get(view);
    return (
      !this.retired &&
      this.closedTurn !== turnId &&
      this.options.captureTurn?.(turnId)?.() !== false &&
      owned?.turnId === turnId &&
      this.options.previewGate.resolveRaw(turnId) === owned.evidence &&
      !!this.options.previewGate.snapshotFor(owned.evidence)
    );
  }
  /** Optional view exposes actual completed native/vision content, not a send license. */
  public async view(turnId: string, messages: readonly AgentMessage[]): Promise<ReplyStickerView | undefined> {
    const current = this.options.captureTurn?.(turnId) ?? (() => true);
    if (this.retired || this.closedTurn === turnId || !current()) return undefined;
    const evidence = this.evidence(turnId, messages, true);
    if (!evidence) return undefined;
    const sticker = await this.options.store.get(this.scopeKey, evidence.stickerId).catch(() => null);
    if (!sticker) return undefined;
    const bytes = await this.options.store.readBytes(sticker, RESOURCE_MAX_BYTES).catch(() => undefined);
    if (
      this.retired ||
      this.closedTurn === turnId ||
      !current() ||
      !bytes ||
      sha256Hex(bytes) !== evidence.contentHash ||
      detectImageMediaType(bytes) !== evidence.mediaType ||
      this.evidence(turnId, messages, true) !== evidence
    )
      return undefined;
    const snapshot = this.options.previewGate.snapshotFor(evidence);
    if (!snapshot || (snapshot.mode === "native" ? !snapshot.frames.length : !snapshot.description?.trim())) return undefined;
    const view: ReplyStickerView = Object.freeze({
      stickerId: snapshot.stickerId,
      contentHash: snapshot.contentHash,
      mediaType: snapshot.mediaType,
      mode: snapshot.mode,
      ...(snapshot.mode === "native"
        ? { frames: snapshot.frames.map((frame) => ({ ...frame, bytes: new Uint8Array(frame.bytes) })) }
        : { description: snapshot.description }),
    });
    this.views.set(view, { evidence, turnId });
    return view;
  }
  private evidence(turnId: string, messages: readonly AgentMessage[], modern: boolean): StickerPreviewEvidence | undefined {
    const evidence = this.options.previewGate.resolve(turnId, messages);
    return evidence && (!modern || hasCompletedPreviewResult(messages, evidence, true)) ? evidence : undefined;
  }
  /** Claim synchronously, then prepare every byte before a phase can send its first text unit. */
  public async preflight(input: {
    readonly stickerId: string;
    readonly turnId: string;
    readonly messages?: readonly AgentMessage[];
    readonly signal?: AbortSignal;
    /** Only the explicit standalone compatibility lane accepts a void sender's old success contract. */
    readonly proofRequired?: boolean;
    /** Bound by Core/provider, never a model claim. Recheck after byte reads before transport. */
    readonly stillAllowed?: () => boolean;
  }): Promise<{ readonly lease: StickerProviderLease } | { readonly error: string }> {
    const turnCurrent = this.options.captureTurn?.(input.turnId);
    const allowed = () => {
      try {
        return !this.retired && this.closedTurn !== input.turnId && turnCurrent?.() !== false && input.stillAllowed?.() !== false;
      } catch {
        return false;
      }
    };
    if (!allowed()) return { error: "StickerCapabilityRetired" };
    if (input.signal?.aborted) return { error: "resource_read_aborted" };
    if (typeof input.stickerId !== "string" || !/^[a-f0-9]{64}$/.test(input.stickerId)) return { error: "invalid_sticker_id" };
    const modern = input.proofRequired !== false;
    const evidence = this.evidence(input.turnId, input.messages ?? [], modern);
    const slot = this.options.sendSlot;
    if (slot.tryClaim(input.turnId, input.signal) !== "claimed") return { error: "sticker_send_limit_reached" };
    const token = slot.claimToken(input.turnId)!;
    let binding: StickerRecordBinding | null = null;
    const valid = (signal?: AbortSignal) =>
      allowed() &&
      !input.signal?.aborted &&
      !signal?.aborted &&
      slot.isCurrent(input.turnId, token) &&
      !!binding &&
      this.options.store.isBindingCurrent(binding);
    let state: "reserved" | "attempted" | "released" = "reserved";
    const release = () => {
      binding?.release();
      this.reservations.delete(release);
      if (state === "reserved") {
        state = "released";
        slot.release(input.turnId, token);
      }
    };
    this.reservations.set(release, input.turnId);
    const failure = (error: string): ReplyStickerTransport => {
      release();
      return { status: "failed", messageIds: [], contentHash: input.stickerId, error };
    };
    try {
      binding = await this.options.store.bindForDelivery(this.scopeKey, input.stickerId, input.signal);
      const sticker = binding?.sticker;
      if (!sticker) {
        release();
        return { error: "sticker_not_found" };
      }
      const bytes = await withAbortSignal(this.options.store.readBytes(sticker, RESOURCE_MAX_BYTES, input.signal), input.signal);
      if (state !== "reserved" || !valid(input.signal)) {
        release();
        return { error: "resource_read_aborted" };
      }
      const mediaType = detectImageMediaType(bytes);
      if (
        !mediaType ||
        bytes.byteLength > RESOURCE_MAX_BYTES ||
        sha256Hex(bytes) !== input.stickerId ||
        (evidence?.stickerId === input.stickerId && (evidence.contentHash !== input.stickerId || evidence.mediaType !== mediaType))
      ) {
        release();
        return { error: "sticker_preview_stale" };
      }
      let prepared: { bytes: Uint8Array; mediaType: string };
      try {
        prepared = prepareStaticGif(bytes, mediaType, this.options.config.sendStaticAsGif);
        if (prepared.bytes.byteLength > RESOURCE_MAX_BYTES) throw new RangeError("sticker_prepare_too_large");
      } catch {
        release();
        return { error: "sticker_prepare_failed" };
      }
      const lease: StickerProviderLease = {
        stickerId: sticker.id,
        contentHash: input.stickerId,
        category: sticker.category,
        tags: sticker.tags,
        release,
        send: async (signal = input.signal) => {
          if (state !== "reserved") return failure("sticker_send_limit_reached");
          if (!valid(signal)) return failure("resource_read_aborted");
          const transport = async (): Promise<ReplyStickerTransport> => {
            let ids: readonly string[] = [];
            try {
              if (modern) {
                if (this.options.sender.sendWithProof) ids = await this.options.sender.sendWithProof(prepared);
                else await this.options.sender.send(prepared);
                const actual = replyPlatformIds(ids);
                if (!actual) return { status: "uncertain", messageIds: [], contentHash: input.stickerId, error: "sticker_delivery_uncertain" };
                ids = actual;
              } else await this.options.sender.send(prepared);
            } catch {
              return { status: "uncertain", messageIds: [], contentHash: input.stickerId, error: "sticker_delivery_uncertain" };
            }
            slot.confirm(input.turnId, token);
            let warning: string | undefined;
            try {
              await withAbortSignal(this.options.store.markUsed(this.scopeKey, sticker.id), AbortSignal.timeout(1000));
            } catch (cause) {
              warning = "sticker_usage_update_failed";
              try {
                this.options.onUsageWarning?.(sticker.id, cause);
              } catch {
                /* Observer cannot revoke delivery. */
              }
            }
            return { status: "confirmed", messageIds: ids, contentHash: input.stickerId, ...(warning ? { warning } : {}) };
          };
          try {
            const started = await this.options.store.startDelivery(
              binding!,
              (latest) => {
                if (state !== "reserved" || !valid(signal)) return { value: Promise.resolve(failure("resource_read_aborted")) };
                if (sha256Hex(latest) !== input.stickerId || detectImageMediaType(latest) !== mediaType)
                  return { value: Promise.resolve(failure("sticker_preview_stale")) };
                if (!slot.beginTransport(input.turnId, token)) return { value: Promise.resolve(failure("sticker_send_limit_reached")) };
                state = "attempted";
                // Calling transport starts the sender before its first await, inside the row boundary.
                const value = transport();
                release();
                return { value };
              },
              signal,
            );
            return started ? await started.value : failure("sticker_not_found");
          } catch (cause) {
            return failure(signal?.aborted ? "resource_read_aborted" : cause instanceof RangeError ? "sticker_preview_stale" : "sticker_not_found");
          }
        },
      };
      return { lease };
    } catch (cause) {
      release();
      return { error: input.signal?.aborted ? "resource_read_aborted" : cause instanceof RangeError ? "sticker_preview_stale" : "sticker_not_found" };
    }
  }
}
