import { createHash, randomInt } from "node:crypto";

import type { Element } from "koishi";
import { formatElements } from "koishi-plugin-yesimbot";
import type { ChannelContext } from "koishi-plugin-yesimbot";

export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

export const CONFIRMATION_CODE_LENGTH = 6;

const CONFIRMATION_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** A confirmation is only accepted when this exact message shape arrives in the current turn. */
const CONFIRMATION_PATTERN = /^确认\s+([A-Za-z0-9]{6})$/;
const PENDING_LIMIT_PER_CHANNEL = 32;
const KEY_SEPARATOR = "\u0000";
const TOKEN_SPLITTER = /[^a-z0-9]+/;
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;
const ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/g;

/**
 * Verbs that change remote state. Absence of any signal is treated as a side effect (fail-closed), so
 * this list only needs to catch the tools that could otherwise look read-only.
 */
const SIDE_EFFECT_TOKENS: ReadonlySet<string> = new Set([
  "accept",
  "activate",
  "add",
  "adjust",
  "apply",
  "approve",
  "authorize",
  "bind",
  "buy",
  "cancel",
  "capture",
  "checkout",
  "claim",
  "close",
  "commit",
  "complete",
  "confirm",
  "create",
  "deactivate",
  "decrease",
  "delete",
  "disable",
  "downgrade",
  "edit",
  "enable",
  "exchange",
  "execute",
  "export",
  "finish",
  "import",
  "increase",
  "insert",
  "invoke",
  "merge",
  "modify",
  "notify",
  "pay",
  "payment",
  "place",
  "prepay",
  "purchase",
  "push",
  "recharge",
  "receive",
  "redeem",
  "refund",
  "register",
  "reject",
  "remove",
  "reopen",
  "repay",
  "restart",
  "resume",
  "retry",
  "rollback",
  "save",
  "send",
  "set",
  "settle",
  "start",
  "stop",
  "submit",
  "subscribe",
  "suspend",
  "topup",
  "transfer",
  "unbind",
  "undo",
  "unsubscribe",
  "update",
  "upgrade",
  "upload",
  "withdraw",
  "action",
  "actions",
  "command",
  "manage",
  "management",
  "operation",
  "operations",
  "perform",
  "process",
  "run",
  "task",
]);

/** Explicit read-only vocabulary. A tool must match one of these and no side-effect signal to pass. */
const READ_ONLY_TOKENS: ReadonlySet<string> = new Set([
  "browse",
  "calc",
  "calculate",
  "check",
  "compare",
  "compute",
  "describe",
  "estimate",
  "fetch",
  "find",
  "get",
  "help",
  "inspect",
  "list",
  "lookup",
  "ping",
  "preview",
  "query",
  "read",
  "recommend",
  "retrieve",
  "search",
  "show",
  "suggest",
  "version",
  "view",
]);

const SIDE_EFFECT_PHRASES: readonly string[] = [
  "下单",
  "支付",
  "付款",
  "结账",
  "结算",
  "扣款",
  "退款",
  "退货",
  "提现",
  "转账",
  "充值",
  "购买",
  "下单支付",
  "创建订单",
  "新建订单",
  "生成订单",
  "提交订单",
  "取消订单",
  "完成订单",
  "关闭订单",
  "确认订单",
  "提交",
  "取消",
  "删除",
  "移除",
  "修改",
  "更新",
  "设置",
  "保存",
  "新增",
  "添加",
  "申请",
  "绑定",
  "解绑",
  "领取",
  "兑换",
  "核销",
  "撤销",
  "回滚",
  "发货",
  "收货",
  "预订",
  "预定",
  "预约",
  "接单",
  "拒单",
  "审批",
  "审核",
  "授权",
  "注册",
  "订阅",
  "退订",
  "发送",
  "推送",
  "通知",
  "上报",
  "上传",
  "开票",
  "操作",
];

const READ_ONLY_PHRASES: readonly string[] = ["查询", "检索", "搜索", "获取", "查看", "预览", "检查", "读取", "列出", "推荐", "计算", "估算", "对比", "比较"];

export type ToolRisk = "read-only" | "side-effect";

export type ConfirmationBlockReason =
  | "args-unhashable"
  | "scope-unavailable"
  | "trusted-actor-unavailable"
  | "awaiting-confirmation"
  | "short-code-mismatch"
  | "stale-pending";

export type ConfirmationCarrier = "raw-yesimbot.message" | "normalized-user";

export type ConfirmationCodeState = "absent" | "valid" | "invalid";

export interface ConfirmationMessageObservation {
  readonly carrier: ConfirmationCarrier;
  /** Platform message id carried by raw yesimbot.message; absent on normalized model messages. */
  readonly platformMessageId?: string;
  /** Agent message id, useful for correlating a normalized carrier without mistaking it for a platform id. */
  readonly agentMessageId?: string;
  readonly actorId?: string;
  readonly codeState: ConfirmationCodeState;
}

export interface ConfirmationInputObservation {
  readonly carriers: readonly ConfirmationMessageObservation[];
  readonly latest?: ConfirmationMessageObservation;
  readonly code?: string;
}

export interface PendingConfirmation {
  readonly channelKey: string;
  readonly serverName: string;
  readonly upstreamToolName: string;
  readonly actorId?: string;
  readonly argsHash: string;
  readonly code: string;
  readonly expiresAt: number;
}

export interface ConfirmationRegistration {
  readonly channelKey: string;
  readonly serverName: string;
  readonly upstreamToolName: string;
  readonly actorId?: string;
  readonly argsHash: string;
}

interface ConfirmationCarrierValue {
  readonly observation: ConfirmationMessageObservation;
  readonly content: unknown;
  readonly code?: string;
}

/** Raised when tool arguments cannot be canonicalized, which makes confirmation binding unverifiable. */
export class UnsupportedConfirmationArgsError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedConfirmationArgsError";
  }
}

/**
 * In-process one-time confirmation registry. State is intentionally not persisted: a service restart or
 * runtime rebuild drops every pending confirmation, which is the fail-closed direction.
 */
export class ConfirmationStore {
  private readonly pending = new Map<string, PendingConfirmation>();

  private readonly now: () => number;

  private readonly limit: number;

  public constructor(now: () => number = () => Date.now(), limit: number = PENDING_LIMIT_PER_CHANNEL) {
    this.now = now;
    this.limit = limit;
  }

  public get size(): number {
    return this.pending.size;
  }

  /** Returns the live pending confirmation for these exact bindings, reusing an unexpired short code. */
  public register(input: ConfirmationRegistration): PendingConfirmation {
    this.prune();
    const key = pendingKey(input.channelKey, input.serverName, input.upstreamToolName, input.actorId);
    const existing = this.pending.get(key);
    if (existing !== undefined && existing.argsHash === input.argsHash) {
      return existing;
    }

    const entry: PendingConfirmation = { ...input, code: createConfirmationCode(), expiresAt: this.now() + CONFIRMATION_TTL_MS };
    this.pending.set(key, entry);
    this.enforceLimit();
    return entry;
  }

  /** Finds live pending entries for the same channel/tool/arguments without weakening actor binding. */
  public findByArgs(input: Pick<ConfirmationRegistration, "channelKey" | "serverName" | "upstreamToolName" | "argsHash">): readonly PendingConfirmation[] {
    this.prune();
    return [...this.pending.values()].filter(
      (entry) =>
        entry.channelKey === input.channelKey &&
        entry.serverName === input.serverName &&
        entry.upstreamToolName === input.upstreamToolName &&
        entry.argsHash === input.argsHash,
    );
  }

  /** Consumes a pending confirmation. The entry is removed even when it is already expired. */
  public consume(key: string): PendingConfirmation | undefined {
    const entry = this.pending.get(key);
    if (entry === undefined) {
      return undefined;
    }

    this.pending.delete(key);
    return entry.expiresAt > this.now() ? entry : undefined;
  }

  public clear(): void {
    this.pending.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of [...this.pending]) {
      if (entry.expiresAt <= now) {
        this.pending.delete(key);
      }
    }
  }

  private enforceLimit(): void {
    while (this.pending.size > this.limit) {
      const oldest = this.pending.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.pending.delete(oldest.value);
    }
  }
}

/**
 * Derives the same channel key shape as Core's `deriveChannelKey`. Core does not export that helper as a
 * value, and an undecidable key must fail closed rather than fall back to a shared key.
 */
export function deriveChannelScopeKey(scope: ChannelContext | undefined): string | undefined {
  if (!scope) return undefined;
  const platform = typeof scope.platform === "string" ? scope.platform : "";
  const channelId = typeof scope.channelId === "string" ? scope.channelId : "";
  if (platform.length === 0 || channelId.length === 0) return undefined;

  switch (scope.type) {
    case "channel": {
      return scope.guildId.length === 0 ? undefined : `channel:${platform}:${scope.guildId}:${channelId}`;
    }
    case "guild": {
      return scope.guildId.length === 0 ? undefined : `guild:${platform}:${scope.guildId}`;
    }
    case "direct": {
      return scope.selfId.length === 0 || scope.userId.length === 0 ? undefined : `direct:${platform}:${scope.userId}:${scope.selfId}`;
    }
    default: {
      return undefined;
    }
  }
}

export function classifyToolRisk(toolName: string, description?: string | null): ToolRisk {
  const signal = `${toolName} ${description ?? ""}`;
  const tokens = tokenize(signal);

  if (hasAnyToken(tokens, SIDE_EFFECT_TOKENS) || hasAnyPhrase(signal, SIDE_EFFECT_PHRASES)) {
    return "side-effect";
  }
  if (hasAnyToken(tokens, READ_ONLY_TOKENS) || hasAnyPhrase(signal, READ_ONLY_PHRASES)) {
    return "read-only";
  }

  // Unknown vocabulary is never assumed safe.
  return "side-effect";
}

/** Deterministic JSON with recursively sorted object keys; array order is preserved. */
export function canonicalizeArgs(value: unknown): string {
  return serializeValue(value, new Set<object>());
}

export function hashArgs(args: unknown): string {
  return createHash("sha256").update(canonicalizeArgs(args)).digest("hex");
}

export function createConfirmationCode(): string {
  let code = "";
  for (let index = 0; index < CONFIRMATION_CODE_LENGTH; index += 1) {
    code += CONFIRMATION_ALPHABET.charAt(randomInt(CONFIRMATION_ALPHABET.length));
  }
  return code;
}

export function pendingKey(channelKey: string, serverName: string, upstreamToolName: string, actorId?: string): string {
  return [channelKey, serverName, upstreamToolName, actorId ?? ""].join(KEY_SEPARATOR);
}

export function extractTextFromUserContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      parts.push(candidate.text);
    }
  }
  if (parts.length > 0) {
    return parts.join("\n");
  }

  // Runtime current messages contain raw `yesimbot.message` element arrays rather than AI UserContent.
  try {
    return formatElements(content as readonly Element[]);
  } catch {
    return "";
  }
}

/** Strict parser: the trimmed message must be exactly `确认 <短码>`, nothing else. */
export function parseConfirmationCode(content: unknown): string | undefined {
  const text = extractTextFromUserContent(content).trim();
  if (text.length === 0) {
    return undefined;
  }

  const match = CONFIRMATION_PATTERN.exec(text);
  return match?.[1]?.toUpperCase();
}

export function extractLatestUserContent(messages: readonly unknown[] | undefined): unknown {
  return collectConfirmationCarriers(messages).at(-1)?.content;
}

/** Reads only the newest user message in the current turn; older confirmations cannot authorize a call. */
export function parseConfirmationFromMessages(messages: readonly unknown[] | undefined): string | undefined {
  return inspectLatestConfirmationInput(messages).code;
}

/**
 * Inspects all current-turn user carriers in arrival order, while selecting only the newest one for
 * authorization. The observation is intentionally metadata-only: it never exposes message text.
 */
export function inspectLatestConfirmationInput(messages: readonly unknown[] | undefined): ConfirmationInputObservation {
  const carriers = collectConfirmationCarriers(messages);
  const observations = carriers.map(({ observation }) => observation);
  const latest = observations.at(-1);
  const latestValue = carriers.at(-1);
  return {
    carriers: observations,
    ...(latest ? { latest } : {}),
    ...(latestValue?.code ? { code: latestValue.code } : {}),
  };
}

/** Returns the trusted sender id carried by the newest raw yesimbot.message, when the current turn has one. */
export function extractLatestUserActorId(messages: readonly unknown[] | undefined): string | undefined {
  return inspectLatestConfirmationInput(messages).latest?.actorId;
}

function collectConfirmationCarriers(messages: readonly unknown[] | undefined): ConfirmationCarrierValue[] {
  if (!Array.isArray(messages)) return [];

  const carriers: ConfirmationCarrierValue[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role === "user") {
      carriers.push(inspectConfirmationCarrier("normalized-user", message.content, undefined, nonEmptyString(message.id)));
      continue;
    }
    if (message.role !== "custom" || message.type !== "yesimbot.message") continue;

    const data = isRecord(message.data) ? message.data : undefined;
    const user = data && isRecord(data.user) ? data.user : undefined;
    carriers.push(
      inspectConfirmationCarrier("raw-yesimbot.message", data?.elements, nonEmptyString(data?.messageId), nonEmptyString(message.id), nonEmptyString(user?.id)),
    );
  }
  return carriers;
}

function inspectConfirmationCarrier(
  carrier: ConfirmationCarrier,
  content: unknown,
  platformMessageId?: string,
  agentMessageId?: string,
  actorId?: string,
): ConfirmationCarrierValue {
  const text = extractTextFromUserContent(content).trim();
  const match = text.length > 0 ? CONFIRMATION_PATTERN.exec(text) : undefined;
  return {
    content,
    observation: {
      carrier,
      ...(platformMessageId ? { platformMessageId } : {}),
      ...(agentMessageId ? { agentMessageId } : {}),
      ...(actorId ? { actorId } : {}),
      codeState: text.length === 0 ? "absent" : match ? "valid" : "invalid",
    },
    ...(match?.[1] ? { code: match[1].toUpperCase() } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function tokenize(input: string): Set<string> {
  const spaced = input.replace(ACRONYM_BOUNDARY, "$1 $2").replace(CAMEL_BOUNDARY, "$1 $2").toLowerCase();
  const tokens = new Set<string>();
  for (const token of spaced.split(TOKEN_SPLITTER)) {
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  return tokens;
}

function hasAnyToken(tokens: ReadonlySet<string>, vocabulary: ReadonlySet<string>): boolean {
  for (const token of tokens) {
    if (vocabulary.has(token)) {
      return true;
    }
  }
  return false;
}

function hasAnyPhrase(signal: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => signal.includes(phrase));
}

function serializeValue(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean": {
      return value ? "true" : "false";
    }
    case "number": {
      if (!Number.isFinite(value)) {
        throw new UnsupportedConfirmationArgsError("参数包含非有限数值");
      }
      return JSON.stringify(value);
    }
    case "string": {
      return JSON.stringify(value);
    }
    case "object": {
      if (seen.has(value)) {
        throw new UnsupportedConfirmationArgsError("参数包含循环引用");
      }
      seen.add(value);
      try {
        return Array.isArray(value) ? serializeArray(value, seen) : serializeObject(value as Record<string, unknown>, seen);
      } finally {
        seen.delete(value);
      }
    }
    default: {
      throw new UnsupportedConfirmationArgsError(`参数包含不支持的类型：${typeof value}`);
    }
  }
}

function serializeArray(value: readonly unknown[], seen: Set<object>): string {
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    // JSON.stringify renders array holes and undefined as null.
    parts.push(item === undefined ? "null" : serializeValue(item, seen));
  }
  return `[${parts.join(",")}]`;
}

function serializeObject(value: Record<string, unknown>, seen: Set<object>): string {
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${serializeValue(value[key], seen)}`);
  return `{${parts.join(",")}}`;
}
