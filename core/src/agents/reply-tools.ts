import { createRandomId, jsonSchema, type AgentMessage, type AgentTool, type AgentToolExecuteContext } from "@yesimbot/agent-runtime";
import type { Bot } from "koishi";

import { withAbortSignal } from "../abort.js";
import type { PacingConfig } from "../config.js";
import type { ReplyJournalWriter } from "../conversations/reply-journal.js";
import type { ChannelResources } from "../resources/index.js";
import { buildPolisherTurnContext } from "./polisher-context.js";
import { MAX_COMPOSE_BYTES } from "./polisher.js";
import {
  layoutAnchorError,
  MAX_PREPARATION_MS,
  normalizeReplyParts,
  ReplyCoordinator,
  replyPreflightFailure,
  validateReplyParts,
  type ReplyDeliveryNotice,
  type ReplyLayoutComposeRequest,
  type ReplyLayoutComposer,
  type ReplyMode,
  type ReplyPart,
  type ReplySendFailureNotice,
  type ReplyStickerCatalogEntry,
  type ReplyStickerProvider,
  type ReplyStickerView,
} from "./reply.js";

const MAX_FACTS = 64;

const MAX_VERBATIM = 12;

const MAX_INTENT_CHARS = 2000;

const convertedViews = new WeakMap<ReplyStickerView, ReplyStickerView>();

export interface ReplyToolsOptions {
  readonly bot: Bot;
  readonly channelId: string;
  readonly resources: ChannelResources;
  readonly pacing: PacingConfig;
  readonly journal: ReplyJournalWriter;
  readonly innerThought: boolean;
  /** Selected by capability declaration, never composer availability. Missing/unsupported B fails closed. */
  readonly delegated: boolean;
  readonly composer?: ReplyLayoutComposer;
  readonly sticker?: ReplyStickerProvider;
  readonly previewAvailable?: boolean;
  readonly resolveProfile: () => Promise<{ persona: string; roleInstructions?: string; characterDefinition?: string }>;
  readonly turnContext: (messages: readonly AgentMessage[]) => ReturnType<typeof buildPolisherTurnContext>;
  readonly describeFrames?: (view: ReplyStickerView, signal?: AbortSignal) => Promise<string | undefined>;
  readonly onDelivered?: (notice: ReplyDeliveryNotice) => void;
  readonly onFailed?: (notice: ReplySendFailureNotice) => void;
  readonly onWarn?: (reason: string, detail: Record<string, unknown>) => void;
  readonly stillAllowed?: () => boolean;
}

export interface ReplyToolSet {
  readonly tools: AgentTool[];
  readonly phases: ReplyPhaseStore;
  readonly coordinator: ReplyCoordinator;
  readonly invalidate: () => void;
  readonly finishTurn: (turnId: string) => Promise<void>;
  setTurnAllowed: (check: (turnId: string) => boolean) => void;
}

interface PreparedInput {
  readonly facts: readonly string[];
  readonly intent: string;
  readonly verbatim: readonly string[];
  readonly channelId: string;
  readonly mode: ReplyMode;
  readonly keepGoing: boolean;
}

interface StoreEntry extends PreparedInput {
  readonly id: string;
  readonly preparationId: string;
  readonly turnId: string;
  readonly initialCallId: string;
  readonly createdAt: number;
  readonly providerRevision: number;
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
  stage: "composing" | "needs_preview" | "ready" | "claimed";
  selector?: { readonly category: string };
  ready?: { readonly parts: readonly ReplyPart[]; readonly callId: string; readonly view?: ReplyStickerView };
}

interface CompletedPair {
  readonly input: unknown;
  readonly value: unknown;
  readonly callIndex: number;
  readonly resultIndex: number;
}

/** One exclusive preparation/ready/claimed phase. Async completions may update only this exact entry. */
class ReplyPhaseStore {
  private entry?: StoreEntry;
  public current(): StoreEntry | undefined {
    if (this.entry && this.entry.stage !== "claimed" && (this.entry.controller.signal.aborted || Date.now() >= this.entry.createdAt + MAX_PREPARATION_MS))
      this.clear();
    return this.entry;
  }
  public begin(input: PreparedInput, turnId: string, callId: string, providerRevision: number): StoreEntry | undefined {
    if (this.current()) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MAX_PREPARATION_MS);
    timer.unref?.();
    this.entry = {
      ...input,
      id: createRandomId(),
      preparationId: createRandomId(),
      turnId,
      initialCallId: callId,
      createdAt: Date.now(),
      providerRevision,
      controller,
      timer,
      stage: "composing",
    };
    return this.entry;
  }
  public owns(entry: StoreEntry): boolean {
    return this.current() === entry;
  }
  public claim(entry: StoreEntry): boolean {
    if (!this.owns(entry) || entry.stage !== "ready" || !entry.ready) return false;
    entry.stage = "claimed";
    clearTimeout(entry.timer);
    return true;
  }
  public clear(entry = this.entry): void {
    if (!entry || this.entry !== entry) return;
    this.entry = undefined;
    clearTimeout(entry.timer);
    entry.controller.abort();
  }
}

export function createReplyTools(options: ReplyToolsOptions): ReplyToolSet {
  const phases = new ReplyPhaseStore();
  const coordinator = new ReplyCoordinator(options);
  let turnAllowed: (turnId: string) => boolean = () => true;
  let retired = false;
  const finishedTurns = new Set<string>();
  const allowed = (turnId: string): boolean => {
    try {
      return !retired && !finishedTurns.has(turnId) && turnAllowed(turnId) && (options.stillAllowed?.() ?? true) && (options.composer?.isCurrent?.() ?? true);
    } catch {
      return false;
    }
  };
  const current = (entry: StoreEntry): boolean => phases.owns(entry) && allowed(entry.turnId) && (options.sticker?.revision ?? 0) === entry.providerRevision;
  const tools = options.delegated
    ? [prepareTool(options, phases, allowed, current), delegatedSendTool(options, phases, coordinator, allowed, current)]
    : [authoredSendTool(options, coordinator, allowed)];
  return {
    tools,
    phases,
    coordinator,
    invalidate: () => {
      retired = true;
      phases.clear();
      coordinator.close();
    },
    finishTurn: async (turnId) => {
      finishedTurns.add(turnId);
      if (finishedTurns.size > 64) finishedTurns.delete(finishedTurns.values().next().value!);
      const entry = phases.current();
      if (entry?.turnId === turnId) phases.clear(entry);
      coordinator.abortTurn(turnId);
      await coordinator.settle();
    },
    setTurnAllowed: (check) => {
      turnAllowed = check;
    },
  };
}

export function authoredDescription(innerThought: boolean, stickerAvailable: boolean): string {
  return `用 parts 提交本次完整的有序回复；普通文本输出不会发送。每个 {kind:"text",text:"..."} 是一个有意义的交流单元。短而完整的回应可以一条，独立回应、转折、补充可以分条。不按字数、句号或空行机械拆分；完整代码、命令与精确引用不拆散。
${stickerAvailable ? '表情包可选，使用 {kind:"sticker",sticker_id:"..."}；必须在本轮更早的已完成步骤用 sticker_preview 看过同一 id 的实际画面。可以纯文字、纯表情、表情在文字前/后或两段文字之间。没有固定数量或搭配；看过并不意味着要发送。' : "当前没有表情发送能力，只提交文字。"}
parts 顺序就是发送顺序；同次调用会发完全部单元，不用为了分条设置 continue。channel 留空发当前频道，OneBot 群使用裸群号；混排表情不支持跨频道。mode=element（默认）解析 <at>/<quote>/<img>/<file>，资源用真实 URI，<text>...</text> 是逐字块；普通尖括号需转义。mode=raw 原样发送纯文本。continue 默认 false 结束本轮；之后还要做工具工作时必须预先设 true。
${innerThought ? "inner_thought 是私有行为判断，不是角色台词，不会发送。" : ""}
返回 replyReceipt 和真实平台 ID。发送遇错立即停止，已发送前缀不会重发；不要通过另一个工具或后续调用重发同一份回复。`;
}

function authoredSendTool(options: ReplyToolsOptions, coordinator: ReplyCoordinator, allowed: (turnId: string) => boolean): AgentTool {
  return {
    name: "send_message",
    terminal: (input: { continue?: boolean }) => input.continue !== true,
    description: authoredDescription(options.innerThought, options.sticker !== undefined),
    inputSchema: jsonSchema<Record<string, unknown>>({
      type: "object",
      properties: {
        parts: {
          type: "array",
          minItems: 1,
          maxItems: 13,
          items: {
            oneOf: [
              {
                type: "object",
                properties: { kind: { const: "text" }, text: { type: "string", minLength: 1 } },
                required: ["kind", "text"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { kind: { const: "sticker" }, sticker_id: { type: "string", minLength: 1 } },
                required: ["kind", "sticker_id"],
                additionalProperties: false,
              },
            ],
          },
        },
        ...controlProperties(options.innerThought),
      },
      required: ["parts"],
      additionalProperties: false,
    }),
    execute: async (input, execution) => {
      const value = record(input);
      if (!value || !keysOnly(value, ["parts", "channel", "mode", "continue", ...(options.innerThought ? ["inner_thought"] : [])]) || !validControls(value))
        return replyPreflightFailure("InvalidInput", "只能提交完整 parts 和有效的发送控制").output;
      return (
        await coordinator.deliver({
          parts: value.parts,
          ...executionInput(execution, allowed),
          channel: value.channel as string | undefined,
          mode: value.mode,
          keepGoing: value.continue === true,
        })
      ).output;
    },
  };
}

function prepareTool(
  options: ReplyToolsOptions,
  phases: ReplyPhaseStore,
  allowed: (turnId: string) => boolean,
  current: (entry: StoreEntry) => boolean,
): AgentTool {
  const properties = {
    facts: {
      type: "array" as const,
      maxItems: MAX_FACTS,
      items: { type: "string" as const, minLength: 1 },
      description: "本次拟对外表达的信息点，不是角色台词",
    },
    intent: { type: "string" as const, minLength: 1, maxLength: MAX_INTENT_CHARS, description: "本次交流动作与必要约束，不是回复草稿" },
    verbatim: {
      type: "array" as const,
      maxItems: MAX_VERBATIM,
      items: { type: "string" as const, minLength: 1 },
      description: "必须逐字交付的完整代码、命令或引用",
    },
    ...controlProperties(options.innerThought),
  };
  return {
    name: "prepare_reply",
    description: prepareDescription(options.innerThought),
    inputSchema: jsonSchema<Record<string, unknown>>({
      oneOf: [
        { type: "object", properties, required: ["facts", "intent"], additionalProperties: false },
        { type: "object", properties: { preparation_id: { type: "string", minLength: 1 } }, required: ["preparation_id"], additionalProperties: false },
      ],
    }),
    execute: async (input, execution) => {
      const value = record(input);
      if (!allowed(execution.turnId) || execution.abortSignal?.aborted) return preparationError("delivery_not_allowed");
      if (!options.composer) return preparationError("ReplyCompositionUnavailable");
      if (!value) return preparationError("invalid_input");
      let entry: StoreEntry;
      let previous: string | undefined;
      let stage: 1 | 2 = 1;
      if ("preparation_id" in value) {
        if (!keysOnly(value, ["preparation_id"]) || typeof value.preparation_id !== "string") return preparationError("invalid_input");
        const pending = phases.current();
        if (!pending || pending.turnId !== execution.turnId || pending.preparationId !== value.preparation_id || pending.stage !== "needs_preview")
          return preparationError("preparation_not_found");
        entry = pending;
        const preview = authorizedPreview(entry, execution.messages);
        if (!preview) {
          phases.clear(entry);
          return preparationError("preview_required");
        }
        previous = preview.error;
        // Reserve resume synchronously: concurrent resumes cannot both compose or overwrite readiness.
        entry.stage = "composing";
        stage = 2;
      } else {
        const prepared = readPreparedInput(value, options);
        if (!prepared) return preparationError("invalid_input");
        const created = phases.begin(prepared, execution.turnId, execution.toolCallId, options.sticker?.revision ?? 0);
        if (!created) return preparationError("preparation_pending");
        entry = created;
      }
      const signal = AbortSignal.any([entry.controller.signal, ...(execution.abortSignal ? [execution.abortSignal] : [])]);
      try {
        // The 60s admission deadline covers profile, catalog, actual view, vision and both passes.
        const request = await withAbortSignal(buildRequest(options, entry, execution.messages, stage, previous, signal), signal);
        if (!current(entry) || signal.aborted) throw new Error("retired");
        const raw = record(await withAbortSignal(options.composer.compose(request, { channelId: entry.channelId }, signal), signal));
        if (!current(entry) || signal.aborted || !raw || Object.keys(raw).length !== 2) throw new Error("invalid_expression");
        if (request.sticker.view && !viewCurrent(options, request.sticker.view, entry.turnId)) throw new Error("stale_view");
        if (raw.kind === "preview") {
          const selector = record(raw.selector);
          if (
            stage !== 1 ||
            request.sticker.view ||
            request.sticker.status !== "eligible" ||
            !request.sticker.previewAvailable ||
            !selector ||
            !keysOnly(selector, ["category"]) ||
            typeof selector.category !== "string" ||
            !request.sticker.catalog.some((item) => item.category === selector.category)
          )
            throw new Error("invalid_preview");
          entry.selector = { category: selector.category };
          entry.stage = "needs_preview";
          return { ok: true, status: "preview_required", preparation_id: entry.preparationId, selector: entry.selector, expires_in_ms: remaining(entry) };
        }
        if (raw.kind !== "layout") throw new Error("invalid_expression");
        const parts = normalizeReplyParts(raw.parts);
        if (!parts || !validateReplyParts(parts, { allowSticker: request.sticker.status === "eligible" && !!request.sticker.view }).ok)
          throw new Error("invalid_layout");
        if (parts.some((part) => part.kind === "sticker" && part.stickerId !== request.sticker.view?.stickerId)) throw new Error("unviewed_sticker");
        if (layoutAnchorError({ facts: entry.facts, verbatim: entry.verbatim, texts: parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])) }))
          throw new Error("anchors");
        entry.ready = { parts, callId: execution.toolCallId, ...(request.sticker.view ? { view: request.sticker.view } : {}) };
        entry.stage = "ready";
        return {
          ok: true,
          status: "ready",
          reply_id: entry.id,
          units: parts.length,
          text_units: parts.filter((part) => part.kind === "text").length,
          stickers: parts.filter((part) => part.kind === "sticker").length,
          expires_in_ms: remaining(entry),
        };
      } catch {
        phases.clear(entry);
        return preparationError("ReplyCompositionUnavailable");
      }
    },
  };
}

function delegatedSendTool(
  options: ReplyToolsOptions,
  phases: ReplyPhaseStore,
  coordinator: ReplyCoordinator,
  allowed: (turnId: string) => boolean,
  current: (entry: StoreEntry) => boolean,
): AgentTool {
  return {
    name: "send_message",
    terminal: (input: { continue?: boolean }) => input.continue !== true,
    description:
      "发送 prepare_reply 已准备好的完整回复。只接受 reply_id 与和准备时相同的 continue；必须在准备结果完成后的下一步调用。不能提交、修改或重新发送草稿、parts、事实或意图。失败时检查 replyReceipt，已发送内容不会重发。",
    inputSchema: jsonSchema<Record<string, unknown>>({
      type: "object",
      properties: { reply_id: { type: "string", minLength: 1 }, continue: { type: "boolean" } },
      required: ["reply_id"],
      additionalProperties: false,
    }),
    execute: async (input, execution) => {
      const failure = (name: string) => replyPreflightFailure(name, "准备无效或发送控制不匹配，未发送任何内容").output;
      const value = record(input);
      if (
        !value ||
        !keysOnly(value, ["reply_id", "continue"]) ||
        typeof value.reply_id !== "string" ||
        (value.continue !== undefined && typeof value.continue !== "boolean")
      )
        return failure("InvalidInput");
      if (!allowed(execution.turnId) || execution.abortSignal?.aborted) return failure("DeliveryNotAllowed");
      const entry = phases.current();
      if (!entry || entry.id !== value.reply_id || entry.turnId !== execution.turnId || entry.stage !== "ready" || !entry.ready)
        return failure("ReplyNotReady");
      if (!current(entry)) {
        phases.clear(entry);
        return failure("ReplyNotReady");
      }
      const prepared = completedPair(execution.messages, entry.ready.callId, "prepare_reply");
      const readyReceipt = record(prepared?.value);
      if (!prepared || !readyReceipt || readyReceipt.ok !== true || readyReceipt.status !== "ready" || readyReceipt.reply_id !== entry.id)
        return failure("ReplyNotReady");
      // Admission consumes the ID before any awaited preflight. It stays exclusive until closure.
      if (!phases.claim(entry)) return failure("ReplyNotReady");
      try {
        if ((value.continue === true) !== entry.keepGoing) return failure("ContinueMismatch");
        if (entry.ready.view && !viewCurrent(options, entry.ready.view, entry.turnId)) return failure("ReplyNotReady");
        return (
          await coordinator.deliver({
            parts: entry.ready.parts,
            ...executionInput(execution, allowed),
            channel: entry.channelId,
            mode: entry.mode,
            facts: entry.facts,
            intent: entry.intent,
            verbatim: entry.verbatim,
            keepGoing: entry.keepGoing,
            stillAllowed: () => current(entry) && allowed(execution.turnId),
          })
        ).output;
      } finally {
        phases.clear(entry);
      }
    },
  };
}

async function buildRequest(
  options: ReplyToolsOptions,
  entry: StoreEntry,
  messages: readonly AgentMessage[],
  stage: 1 | 2,
  previous: string | undefined,
  signal: AbortSignal,
): Promise<ReplyLayoutComposeRequest> {
  const status = options.sticker?.status(entry.turnId) ?? "unavailable";
  const catalog = status === "eligible" && options.sticker ? boundedCatalog(await options.sticker.catalog().catch(() => [])) : [];
  const profile = await options.resolveProfile();
  let original: ReplyStickerView | undefined;
  if (!previous && status === "eligible" && options.sticker) original = await options.sticker.view(entry.turnId, messages).catch(() => undefined);
  let view = original && viewCurrent(options, original, entry.turnId) ? original : undefined;
  const imageInput = options.composer?.supportsImages?.({ channelId: entry.channelId }) ?? options.composer?.imageInput === true;
  if (view?.mode === "native" && !imageInput) {
    const description = await options.describeFrames?.(view, signal).catch(() => undefined);
    view =
      description?.trim() && original && viewCurrent(options, original, entry.turnId)
        ? { ...original, mode: "description", frames: undefined, description: description.trim().slice(0, 6000) }
        : undefined;
    // Preserve the provider-owned exact object identity through a converted-description association.
    if (view && original) convertedViews.set(view, original);
  }
  if (signal.aborted) throw new Error("aborted");
  return {
    mode: "reply-layout",
    stage,
    facts: entry.facts,
    intent: entry.intent,
    verbatim: entry.verbatim,
    profile,
    turnContext: options.turnContext(messages),
    sticker: {
      status,
      catalog,
      ...(view ? { view } : {}),
      consumed: status === "consumed",
      imageInput,
      previewAvailable: options.previewAvailable === true && status === "eligible" && catalog.length > 0,
    },
    ...(previous ? { previous: { error: previous } } : {}),
  };
}

function viewCurrent(options: ReplyToolsOptions, view: ReplyStickerView, turnId: string): boolean {
  try {
    return options.sticker?.isViewCurrent?.(convertedViews.get(view) ?? view, turnId) === true;
  } catch {
    return false;
  }
}

function boundedCatalog(catalog: readonly ReplyStickerCatalogEntry[]): ReplyStickerCatalogEntry[] {
  const result: ReplyStickerCatalogEntry[] = [];
  for (const item of catalog) {
    if (
      !item ||
      typeof item.category !== "string" ||
      !item.category.trim() ||
      !Number.isSafeInteger(item.count) ||
      item.count <= 0 ||
      result.some((entry) => entry.category === item.category)
    )
      continue;
    const entry = { category: item.category, count: item.count };
    if (JSON.stringify([...result, entry]).length > 2000) break;
    result.push(entry);
    if (result.length === 20) break;
  }
  return result;
}

/** Actual unique SDK call then later result, never receipt echoes or guessed IDs alone. */
function completedPair(messages: readonly AgentMessage[], callId: string, toolName: string): CompletedPair | undefined {
  const calls: { input: unknown; index: number; name: string }[] = [];
  const results: { value: unknown; index: number; name: string }[] = [];
  for (const [index, message] of messages.entries()) {
    if ((message.role !== "assistant" && message.role !== "tool") || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if ((part.type !== "tool-call" && part.type !== "tool-result") || part.toolCallId !== callId) continue;
      if (message.role === "assistant" && part.type === "tool-call") calls.push({ input: part.input, index, name: part.toolName });
      if (message.role === "tool" && part.type === "tool-result") results.push({ value: outputValue(part.output), index, name: part.toolName });
    }
  }
  if (calls.length !== 1 || results.length !== 1 || calls[0]!.index >= results[0]!.index || calls[0]!.name !== toolName || results[0]!.name !== toolName)
    return undefined;
  return { input: calls[0]!.input, value: results[0]!.value, callIndex: calls[0]!.index, resultIndex: results[0]!.index };
}

function authorizedPreview(entry: StoreEntry, messages: readonly AgentMessage[]): { error?: string } | undefined {
  const initial = completedPair(messages, entry.initialCallId, "prepare_reply");
  const receipt = record(initial?.value);
  if (
    !initial ||
    !receipt ||
    receipt.ok !== true ||
    receipt.status !== "preview_required" ||
    receipt.preparation_id !== entry.preparationId ||
    !entry.selector ||
    JSON.stringify(receipt.selector) !== JSON.stringify(entry.selector)
  )
    return undefined;
  const later: string[] = [];
  for (const [index, message] of messages.entries()) {
    if (index <= initial.resultIndex || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) if (part.type === "tool-call" && part.toolName === "sticker_preview") later.push(part.toolCallId);
  }
  if (later.length !== 1) return undefined;
  const preview = completedPair(messages, later[0]!, "sticker_preview");
  const input = record(preview?.input);
  const output = record(preview?.value);
  if (!preview || preview.callIndex <= initial.resultIndex || !input || !keysOnly(input, ["category"]) || input.category !== entry.selector.category || !output)
    return undefined;
  if (output.ok === true && output.previewed === true) return {};
  return output.ok === false && typeof output.error === "string" && output.error.trim() ? { error: output.error } : undefined;
}

function outputValue(value: unknown): unknown {
  const output = record(value);
  if (!output) return undefined;
  if (output.type === "json") return output.value;
  if (output.type === "text") {
    try {
      return JSON.parse(String(output.value));
    } catch {
      return undefined;
    }
  }
  if (output.type !== "content" || !Array.isArray(output.value)) return undefined;
  const texts = output.value.filter((part) => record(part)?.type === "text");
  if (texts.length !== 1) return undefined;
  try {
    return JSON.parse(String(texts[0].text));
  } catch {
    return undefined;
  }
}

function executionInput(execution: AgentToolExecuteContext, allowed: (turnId: string) => boolean) {
  return {
    turnId: execution.turnId,
    toolCallId: execution.toolCallId,
    messages: execution.messages,
    signal: execution.abortSignal,
    allowed: allowed(execution.turnId),
    stillAllowed: () => allowed(execution.turnId),
  };
}

function readPreparedInput(value: Record<string, unknown>, options: ReplyToolsOptions): PreparedInput | undefined {
  if (
    !keysOnly(value, ["facts", "intent", "verbatim", "channel", "mode", "continue", ...(options.innerThought ? ["inner_thought"] : [])]) ||
    !validControls(value)
  )
    return undefined;
  const facts = strings(value.facts, MAX_FACTS);
  const verbatim = value.verbatim === undefined ? [] : strings(value.verbatim, MAX_VERBATIM);
  if (
    !facts ||
    !verbatim ||
    typeof value.intent !== "string" ||
    !value.intent.trim() ||
    value.intent.length > MAX_INTENT_CHARS ||
    Buffer.byteLength(JSON.stringify([facts, value.intent, verbatim])) > MAX_COMPOSE_BYTES
  )
    return undefined;
  return {
    facts,
    verbatim,
    intent: value.intent,
    channelId: typeof value.channel === "string" ? value.channel : options.channelId,
    mode: value.mode === "raw" ? "raw" : "element",
    keepGoing: value.continue === true,
  };
}

function strings(value: unknown, max: number): readonly string[] | undefined {
  return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string" && item.trim()) ? Object.freeze([...value]) : undefined;
}

function validControls(value: Record<string, unknown>): boolean {
  return (
    (value.channel === undefined || (typeof value.channel === "string" && !!value.channel.trim())) &&
    (value.mode === undefined || value.mode === "raw" || value.mode === "element") &&
    (value.continue === undefined || typeof value.continue === "boolean") &&
    (value.inner_thought === undefined || typeof value.inner_thought === "string")
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function keysOnly(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function remaining(entry: StoreEntry): number {
  return Math.max(0, entry.createdAt + MAX_PREPARATION_MS - Date.now());
}

function preparationError(error: string) {
  return { ok: false, error, message: "本次准备未就绪，不发送 facts、intent 或角色草稿，也不改由主模型生成台词。" };
}

function controlProperties(innerThought: boolean) {
  return {
    channel: { type: "string" as const, minLength: 1 },
    mode: { type: "string" as const, enum: ["element", "raw"] },
    continue: { type: "boolean" as const },
    ...(innerThought ? { inner_thought: { type: "string" as const, description: "私有行为判断，不会发送或交给表达模型" } } : {}),
  };
}

function prepareDescription(innerThought: boolean): string {
  return `由携带完整人设的独立表达模型撰写并排版本次回复。你只负责客观 facts、交流 intent、必要 verbatim 和执行工具，不写角色草稿，不决定或修改台词、分条和表情位置。
初次提交 facts（可为空数组）与 intent，可加完整精确 verbatim、channel、mode、continue。返回 ready/reply_id 后，在更后一步用 send_message 发送，并保持 continue 相同。
若返回 preview_required，按原样 selector 在下一步调用 sticker_preview；得到已完成结果后，在更后一步只提交 preparation_id 继续同一份准备。失败的查看也可以继续生成纯文字；不能改 facts、控制或 selector。同份准备最多一次查看、两次表达生成，整体 60 秒内有效，同轮只能一份准备或发送中的回复。
生成失败不发送事实或意图，不由你改写角色台词。表情可省略，查看不意味着发送。${innerThought ? "inner_thought 是私有判断，不交给表达模型。" : ""}`;
}
