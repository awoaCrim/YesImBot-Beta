import type { AgentMessage } from "@yesimbot/agent-runtime";
import {
  replyPlatformIds,
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
import type { StickerStore } from "./store.js";
import { scopeKeyFor, type StickerConfig } from "./types.js";

export interface StickerProviderLease extends ReplyStickerLease {
  readonly category: string;
  readonly tags: readonly string[];
}

/** Both standalone and modern sends share evidence, exact bytes, one slot, preparation and accounting. */
export class StickerDeliveryService {
  private readonly views = new WeakMap<ReplyStickerView, { evidence: StickerPreviewEvidence; turnId: string }>();
  public constructor(
    private readonly options: {
      readonly store: StickerStore;
      readonly sender: StickerSender;
      readonly scope: ChannelContext;
      readonly config: StickerConfig;
      readonly sendSlot: StickerSendSlot;
      readonly previewGate: StickerPreviewGate;
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
    return owned?.turnId === turnId && this.options.previewGate.resolveRaw(turnId) === owned.evidence && !!this.options.previewGate.snapshotFor(owned.evidence);
  }
  /** Only the exact completed native/vision view, rechecked after byte reads, can cross into B. */
  public async view(turnId: string, messages: readonly AgentMessage[]): Promise<ReplyStickerView | undefined> {
    const evidence = this.evidence(turnId, messages, true);
    if (!evidence) return undefined;
    const sticker = await this.options.store.get(this.scopeKey, evidence.stickerId).catch(() => null);
    if (!sticker) return undefined;
    const bytes = await this.options.store.readBytes(sticker).catch(() => undefined);
    if (
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
    const allowed = () => {
      try {
        return input.stillAllowed?.() !== false;
      } catch {
        return false;
      }
    };
    if (!allowed()) return { error: "StickerCapabilityRetired" };
    const modern = input.proofRequired !== false;
    const messages = input.messages ?? [];
    const evidence = this.evidence(input.turnId, messages, modern);
    if (!evidence) return { error: "sticker_preview_required" };
    if (evidence.stickerId !== input.stickerId) return { error: "sticker_preview_mismatch" };
    const slot = this.options.sendSlot;
    if (slot.tryClaim(input.turnId, input.signal) !== "claimed") return { error: "sticker_send_limit_reached" };
    const token = slot.claimToken(input.turnId)!;
    const valid = (signal?: AbortSignal) =>
      allowed() && !signal?.aborted && slot.isCurrent(input.turnId, token) && this.evidence(input.turnId, messages, modern) === evidence;
    let state: "reserved" | "attempted" | "released" = "reserved";
    const release = () => {
      if (state === "reserved") {
        state = "released";
        slot.release(input.turnId, token);
      }
    };
    const failure = (error: string): ReplyStickerTransport => {
      release();
      return { status: "failed", messageIds: [], contentHash: evidence.contentHash, error };
    };
    try {
      const sticker = await withAbortSignal(this.options.store.get(this.scopeKey, input.stickerId), input.signal);
      if (!sticker) {
        release();
        return { error: "sticker_not_found" };
      }
      const bytes = await withAbortSignal(this.options.store.readBytes(sticker), input.signal);
      if (!valid(input.signal)) {
        release();
        return { error: "resource_read_aborted" };
      }
      if (bytes.byteLength > 5 * 1024 * 1024 || sha256Hex(bytes) !== evidence.contentHash || detectImageMediaType(bytes) !== evidence.mediaType) {
        release();
        return { error: "sticker_preview_stale" };
      }
      let prepared: { bytes: Uint8Array; mediaType: string };
      try {
        prepared = prepareStaticGif(bytes, evidence.mediaType, this.options.config.sendStaticAsGif);
      } catch {
        release();
        return { error: "sticker_prepare_failed" };
      }
      const lease: StickerProviderLease = {
        stickerId: sticker.id,
        contentHash: evidence.contentHash,
        category: sticker.category,
        tags: sticker.tags,
        release,
        send: async (signal = input.signal) => {
          if (state !== "reserved") return failure("sticker_send_limit_reached");
          if (!valid(signal)) return failure("resource_read_aborted");
          // Revalidate bytes and the exact claim after pacing/resource/model awaits; no new selection.
          let latest: Uint8Array;
          try {
            latest = await withAbortSignal(this.options.store.readBytes(sticker), signal);
          } catch {
            return failure(signal?.aborted ? "resource_read_aborted" : "sticker_not_found");
          }
          if (state !== "reserved" || !valid(signal)) return failure("resource_read_aborted");
          if (sha256Hex(latest) !== evidence.contentHash) return failure("sticker_preview_stale");
          if (!slot.beginTransport(input.turnId, token)) return failure("sticker_send_limit_reached");
          state = "attempted"; // Uncertain immediately: release cannot license another transport.
          let ids: readonly string[] = [];
          try {
            if (modern) {
              if (this.options.sender.sendWithProof) ids = await this.options.sender.sendWithProof(prepared);
              else await this.options.sender.send(prepared);
              const actual = replyPlatformIds(ids);
              if (!actual) return { status: "uncertain", messageIds: [], contentHash: evidence.contentHash, error: "sticker_delivery_uncertain" };
              ids = actual;
            } else await this.options.sender.send(prepared);
          } catch {
            return { status: "uncertain", messageIds: [], contentHash: evidence.contentHash, error: "sticker_delivery_uncertain" };
          }
          slot.confirm(input.turnId, token); // Confirm before any fallible accounting await.
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
          return { status: "confirmed", messageIds: ids, contentHash: evidence.contentHash, ...(warning ? { warning } : {}) };
        },
      };
      return { lease };
    } catch {
      release();
      return { error: input.signal?.aborted ? "resource_read_aborted" : "sticker_not_found" };
    }
  }
}
