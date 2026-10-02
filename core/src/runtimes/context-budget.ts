import type { AgentModelRequestContext, AgentRequestOrigin } from "@yesimbot/agent-runtime";
import { asSchema, type ModelMessage, type ToolSet } from "ai";

import type { MagicContextConfig } from "../config.js";

export interface ContextBudget {
  readonly contextWindow: number;
  readonly outputTokens: number;
  readonly marginTokens: number;
  readonly inputTokens: number;
  readonly historyTokens: number;
  readonly recentMessages: number;
  readonly maxLoadedBlocks: number;
  readonly pageTokens: number;
  readonly retainTurns: number;
}

export interface ContextBudgetRemovedUnit {
  readonly indices: readonly number[];
  readonly kind: AgentRequestOrigin["kind"];
  readonly sourceEntryIds: readonly string[];
  readonly blockIds: readonly string[];
}

export interface ContextBudgetPlan {
  readonly messages: readonly ModelMessage[];
  readonly estimatedInputTokens: number;
  readonly optionalTokens: number;
  readonly mandatoryInputTokens: number;
  readonly mandatoryHistoryTokens: number;
  readonly estimatedHistoryTokens: number;
  readonly evictedBlockIds: readonly string[];
  readonly removedSourceEntryIds: readonly string[];
  readonly removedHistorySourceEntryIds: readonly string[];
  readonly removedUnits: readonly ContextBudgetRemovedUnit[];
  readonly removedMessages: number;
}

export interface ContextBudgetPlanOptions {
  /**
   * Enforce the local estimate as a hard pre-provider limit. Core's Magic Context path leaves
   * this disabled because provider-reported usage is authoritative for completed requests.
   */
  readonly enforceBudget?: boolean;
  /** Keep units covering these proven source IDs when constructing a bounded raw fallback. */
  readonly preserveSourceEntryIds?: ReadonlySet<string>;
}

interface RequestUnit {
  readonly indices: number[];
  mandatory: boolean;
  kind: AgentRequestOrigin["kind"];
  timestamp: number;
  readonly blockIds: Set<string>;
  readonly sourceEntryIds: Set<string>;
}

export class ContextBudgetError extends Error {
  public constructor(public readonly code: "InvalidContextBudget" | "ContextBudgetExceeded" | "UnsupportedBudgetMedia") {
    super(code);
    this.name = code;
  }
}

export function resolveContextBudget(
  config: Partial<MagicContextConfig>,
  mode: string | undefined,
  limit?: { context: number; output: number },
): ContextBudget {
  if (mode !== "compartment") throw new ContextBudgetError("InvalidContextBudget");
  const windowOverride = config.contextWindow;
  if (windowOverride !== undefined) positiveInteger(windowOverride);
  if (limit) {
    positiveInteger(limit.context);
    positiveInteger(limit.output);
  }
  const contextWindow = windowOverride === undefined ? limit?.context : limit ? Math.min(windowOverride, limit.context) : windowOverride;
  if (contextWindow === undefined) throw new ContextBudgetError("InvalidContextBudget");
  positiveInteger(contextWindow);
  const reserve = config.outputReserveTokens ?? 8192;
  positiveInteger(reserve);
  const outputTokens = limit ? Math.min(reserve, limit.output) : reserve;
  const marginTokens = Math.max(1024, Math.ceil(contextWindow * 0.1));
  const inputTokens = contextWindow - outputTokens - marginTokens;
  positiveInteger(inputTokens);
  const percentage = config.historyBudgetPercentage ?? 25;
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) throw new ContextBudgetError("InvalidContextBudget");
  const historyTokens = Math.min(20_000, Math.floor((inputTokens * percentage) / 100));
  positiveInteger(historyTokens);
  const pageTokens = config.pageTokenBudget ?? 4096;
  positiveInteger(pageTokens, 4096);
  if (pageTokens < 128 || pageTokens > historyTokens) throw new ContextBudgetError("InvalidContextBudget");
  const recentMessages = config.recentMessages ?? 20;
  const maxLoadedBlocks = config.maxLoadedBlocks ?? 4;
  const retainTurns = config.retainTurns ?? 2;
  positiveInteger(recentMessages, 200);
  positiveInteger(maxLoadedBlocks, 4);
  if (!Number.isSafeInteger(retainTurns) || retainTurns < 0 || retainTurns > 2) throw new ContextBudgetError("InvalidContextBudget");
  return {
    contextWindow,
    outputTokens,
    marginTokens,
    inputTokens,
    historyTokens,
    recentMessages,
    maxLoadedBlocks,
    pageTokens,
    retainTurns,
  };
}

/** UTF-8/framing estimate, not provider tokenization. Media payload bytes are never counted as text. */
export function estimateContextValue(value: unknown): number {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return 0;
  if (value === null) return 4;
  if (typeof value === "string") return Buffer.byteLength(JSON.stringify(value), "utf8");
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) return 2 + value.reduce((sum, entry) => sum + estimateContextValue(entry) + 1, 0);
  if (typeof value !== "object") throw new ContextBudgetError("UnsupportedBudgetMedia");
  const record = value as Record<string, unknown>;
  const media = typeof record.type === "string" && ["image", "file", "image-data", "image-url", "file-data", "file-url", "media"].includes(record.type);
  if (media) {
    // Media payloads are provider-specific and must not be treated as UTF-8 text or
    // rejected because no local token estimate is available. Count only framing and
    // non-payload metadata; the provider remains authoritative for actual usage.
    return (
      64 +
      Object.entries(record).reduce(
        (sum, [key, entry]) => (["image", "file", "data", "url"].includes(key) ? sum : sum + estimateContextValue(key) + estimateContextValue(entry) + 2),
        0,
      )
    );
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) throw new ContextBudgetError("UnsupportedBudgetMedia");
  if (value instanceof URL) return estimateContextValue(value.href);
  return 2 + Object.entries(record).reduce((sum, [key, entry]) => sum + estimateContextValue(key) + estimateContextValue(entry) + 2, 0);
}

export function estimateContextMessage(message: ModelMessage): number {
  return 32 + estimateContextValue(message);
}

export async function estimateContextBase(context: Pick<AgentModelRequestContext, "system" | "tools" | "toolChoice">): Promise<number> {
  const tools = await contextToolDefinitions(context.tools);
  return 128 + estimateContextValue(context.system) + estimateContextValue(tools) + estimateContextValue(context.toolChoice);
}

/** Operates only on proven optional history. Protocol-linked messages form one removal unit. */
export function planContextRequest(
  context: Pick<AgentModelRequestContext, "messages" | "projection">,
  budget: ContextBudget,
  baseTokens: number,
  multiplier = 1,
  options: ContextBudgetPlanOptions = {},
): ContextBudgetPlan {
  const messages = context.messages;
  const enforceBudget = options.enforceBudget ?? true;
  const units = requestUnits(messages, context.projection?.describe(messages) ?? messages.map(() => undefined));
  const costs = messages.map((message) => estimateContextMessage(message));
  const removed = new Set<number>();
  const evicted = new Set<string>();
  const removedUnits: RequestUnit[] = [];
  const cost = (unit: RequestUnit) => unit.indices.reduce((sum, index) => sum + costs[index]!, 0);
  const drop = (unit: RequestUnit) => {
    for (const index of unit.indices) removed.add(index);
    for (const id of unit.blockIds) evicted.add(id);
    if (!removedUnits.includes(unit)) removedUnits.push(unit);
  };
  const preserved = (unit: RequestUnit) =>
    options.preserveSourceEntryIds !== undefined && [...unit.sourceEntryIds].some((id) => options.preserveSourceEntryIds!.has(id));
  const history = units.filter((unit) => !unit.mandatory && unit.kind === "history").sort((a, b) => b.timestamp - a.timestamp);
  // Current context-tool receipts are protected, but their historical material
  // still shares H with summaries/pages (and already counts once in mandatory I).
  const mandatoryHistoryCost = units
    .filter((unit) => unit.mandatory)
    .reduce((sum, unit) => sum + unit.indices.reduce((total, index) => total + contextToolHistoryCost(messages[index]!), 0), 0);
  const measuredMandatoryHistory = Math.ceil(mandatoryHistoryCost * multiplier);
  if (enforceBudget && measuredMandatoryHistory > budget.historyTokens) throw new ContextBudgetError("ContextBudgetExceeded");
  const optionalHistoryBudget = Math.max(0, budget.historyTokens - measuredMandatoryHistory);
  // The recent-history ring is a soft working set, not an unbounded claimant on H.
  // Reserve space for explicitly loaded pages/summaries before selecting the ring;
  // otherwise a large ring would immediately evict every successful ctx_load.
  const nonHistoryCost = units
    .filter((unit) => !unit.mandatory && unit.kind !== "history" && unit.kind !== "recall")
    .reduce((sum, unit) => sum + cost(unit), 0);
  const ringAllowance = Math.max(0, Math.floor(optionalHistoryBudget / multiplier) - nonHistoryCost);
  let kept = 0;
  let ringCost = 0;
  for (const unit of history) {
    const unitCost = cost(unit);
    if (!preserved(unit) && (kept >= budget.recentMessages || ringCost + unitCost > ringAllowance)) drop(unit);
    else {
      kept += unit.indices.length;
      ringCost += unitCost;
    }
  }
  const mandatoryCost = units.filter((unit) => unit.mandatory).reduce((sum, unit) => sum + cost(unit), 0);
  const measuredMandatoryInput = Math.ceil((baseTokens + mandatoryCost) * multiplier);
  if (enforceBudget && measuredMandatoryInput > budget.inputTokens) throw new ContextBudgetError("ContextBudgetExceeded");
  const optional = units.filter((unit) => !unit.mandatory).sort((a, b) => rank(a.kind) - rank(b.kind) || a.timestamp - b.timestamp);
  let optionalCost = optional.filter((unit) => !removed.has(unit.indices[0]!)).reduce((sum, unit) => sum + cost(unit), 0);
  for (const unit of optional) {
    if (
      Math.ceil(optionalCost * multiplier) <= optionalHistoryBudget &&
      Math.ceil((baseTokens + mandatoryCost + optionalCost) * multiplier) <= budget.inputTokens
    )
      break;
    if (removed.has(unit.indices[0]!) || preserved(unit)) continue;
    drop(unit);
    optionalCost -= cost(unit);
  }
  const estimatedInputTokens = Math.ceil((baseTokens + mandatoryCost + optionalCost) * multiplier);
  if (enforceBudget && (estimatedInputTokens > budget.inputTokens || Math.ceil(optionalCost * multiplier) > optionalHistoryBudget))
    throw new ContextBudgetError("ContextBudgetExceeded");
  const removedSourceEntryIds = new Set<string>();
  const removedHistorySourceEntryIds = new Set<string>();
  for (const unit of removedUnits) {
    for (const id of unit.sourceEntryIds) {
      removedSourceEntryIds.add(id);
      if (unit.kind === "history") removedHistorySourceEntryIds.add(id);
    }
  }
  return {
    messages: messages.filter((_, index) => !removed.has(index)),
    estimatedInputTokens,
    optionalTokens: Math.ceil(optionalCost * multiplier),
    mandatoryInputTokens: Math.ceil((baseTokens + mandatoryCost) * multiplier),
    mandatoryHistoryTokens: Math.ceil(mandatoryHistoryCost * multiplier),
    estimatedHistoryTokens: Math.ceil(mandatoryHistoryCost * multiplier) + Math.ceil(optionalCost * multiplier),
    evictedBlockIds: [...evicted],
    removedSourceEntryIds: [...removedSourceEntryIds],
    removedHistorySourceEntryIds: [...removedHistorySourceEntryIds],
    removedUnits: removedUnits.map((unit) => ({
      indices: [...unit.indices],
      kind: unit.kind,
      sourceEntryIds: [...unit.sourceEntryIds],
      blockIds: [...unit.blockIds],
    })),
    removedMessages: removed.size,
  };
}

function contextToolHistoryCost(message: ModelMessage): number {
  if (message.role !== "tool") return 0;
  return message.content.reduce(
    (sum, part) =>
      sum +
      (part.type === "tool-result" && ["ctx_blocks", "ctx_load", "ctx_release", "ctx_expand"].includes(part.toolName) ? 32 + estimateContextValue(part) : 0),
    0,
  );
}

function requestUnits(messages: readonly ModelMessage[], origins: readonly (AgentRequestOrigin | undefined)[]): RequestUnit[] {
  const parents = messages.map((_, index) => index);
  const find = (index: number): number => {
    while (parents[index] !== index) index = parents[index]!;
    return index;
  };
  const union = (a: number, b: number) => {
    parents[find(b)] = find(a);
  };
  const sourceGroups = new Map<string, number>();
  origins.forEach((origin, index) => {
    if (!origin || origin.kind === "loaded" || origin.kind === "recall") return;
    for (const id of origin.sourceEntryIds) {
      const previous = sourceGroups.get(id);
      if (previous === undefined) sourceGroups.set(id, index);
      else union(previous, index);
    }
  });
  const calls = new Map<string, number[]>();
  const results = new Map<string, number[]>();
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    for (const part of message.content) {
      if (part.type !== "tool-call" && part.type !== "tool-result") continue;
      const map = part.type === "tool-call" ? calls : results;
      const indices = map.get(part.toolCallId) ?? [];
      indices.push(index);
      map.set(part.toolCallId, indices);
    }
  });
  const unresolved = new Set<number>();
  for (const id of new Set([...calls.keys(), ...results.keys()])) {
    const call = calls.get(id) ?? [];
    const result = results.get(id) ?? [];
    const all = [...call, ...result];
    if (call.length !== 1 || result.length !== 1) for (const index of all) unresolved.add(index);
    for (const index of all.slice(1)) union(all[0]!, index);
  }
  const byRoot = new Map<number, RequestUnit>();
  messages.forEach((_, index) => {
    const origin = origins[index];
    const mandatory = !origin || !["history", "summary", "continuity", "recall", "loaded"].includes(origin.kind) || unresolved.has(index);
    const root = find(index);
    const unit = byRoot.get(root) ?? {
      indices: [],
      mandatory: false,
      kind: origin?.kind ?? "mandatory",
      timestamp: origin?.timestamp ?? 0,
      blockIds: new Set<string>(),
      sourceEntryIds: new Set<string>(),
    };
    unit.indices.push(index);
    unit.mandatory ||= mandatory;
    if (origin && rank(origin.kind) > rank(unit.kind)) unit.kind = origin.kind;
    unit.timestamp = Math.min(unit.timestamp, origin?.timestamp ?? unit.timestamp);
    if (origin?.blockId) unit.blockIds.add(origin.blockId);
    for (const id of origin?.sourceEntryIds ?? []) unit.sourceEntryIds.add(id);
    byRoot.set(root, unit);
  });
  return [...byRoot.values()];
}

async function contextToolDefinitions(tools: ToolSet): Promise<unknown[]> {
  return Promise.all(
    Object.entries(tools).map(async ([name, tool]) => ({
      name,
      description: tool.description,
      type: tool.type,
      ...("id" in tool ? { id: tool.id } : {}),
      ...("args" in tool ? { args: tool.args } : {}),
      parameters: await asSchema(tool.inputSchema).jsonSchema,
    })),
  );
}

function rank(kind: AgentRequestOrigin["kind"]): number {
  switch (kind) {
    case "recall":
      return 0;
    case "loaded":
      return 1;
    case "history":
      return 2;
    case "continuity":
      return 3;
    case "summary":
      return 4;
    default:
      return 5;
  }
}

function positiveInteger(value: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ContextBudgetError("InvalidContextBudget");
}
