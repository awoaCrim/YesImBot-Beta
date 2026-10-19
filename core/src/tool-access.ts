import type { AgentMessage, AgentPlugin } from "@yesimbot/agent-runtime";

import type { ChannelContext } from "./channels/context.js";

/** Default OneBot operator identity rule for management tools; execution still requires the tool's own policy. */
export const DEFAULT_MANAGEMENT_TOOL_SCOPES = Object.freeze([{ platform: "onebot", channelId: "*", userId: "1049700117" }] as const);

type ToolAccessScope = Pick<ChannelContext, "platform" | "channelId"> & {
  readonly userId?: string;
  readonly selfId?: string;
};

/** A scope allowlist rule for sensitive Agent tools. Empty rule lists deny access. */
export interface ToolAccessRule {
  readonly platform: string;
  readonly channelId: string;
  /** Optional user identity restriction. Omit to authorize by the other fields only. */
  readonly userId?: string;
  /** Optional bot account restriction. */
  readonly selfId?: string;
}

/**
 * Returns whether a stable channel snapshot may provisionally admit a sensitive tool.
 *
 * Group snapshots do not contain the sender identity. A user rule can therefore
 * admit the tool provisionally when its platform/channel/bot fields match; the
 * per-message check below makes the final decision once the current turn's actor
 * IDs are available. Direct snapshots already carry their user ID and are checked
 * immediately. This is only an admission check, never an execution grant.
 */
export function isToolAccessPotentiallyAllowed(scope: ToolAccessScope, rules: readonly ToolAccessRule[] | undefined): boolean {
  if (!rules || rules.length === 0) return false;
  return rules.some(
    (rule) => matchesScopeFields(scope, rule) && (hasUserRestriction(rule) ? scope.userId === undefined || matches(rule.userId!, scope.userId) : true),
  );
}

/**
 * Matches a Runtime scope against the explicit tool allowlist.
 *
 * Every populated rule field is an allowlist condition; there is no additional
 * private/group chat-type branch. A `userId` rule is checked against every actor
 * in the current turn. Channel-only rules authorize any actor in that channel.
 * When no actor is present, a direct scope's own `userId` is used; a user rule
 * cannot authorize an actor-less group/event turn. `*` is an intentional wildcard
 * for platform, channelId, userId, or selfId.
 */
export function isToolAccessAllowed(scope: ToolAccessScope, rules: readonly ToolAccessRule[] | undefined, actorUserIds?: readonly string[]): boolean {
  if (!rules || rules.length === 0) return false;
  const actors = normalizeActorIds(actorUserIds);
  if (actors.length > 0) return actors.every((actorId) => rules.some((rule) => matchesRule(scope, rule, actorId)));
  return rules.some((rule) => matchesRule(scope, rule, scope.userId));
}

/** Extracts trusted sender IDs from the raw current-turn `yesimbot.message` carriers. */
export function extractToolAccessActorIds(messages: readonly AgentMessage[]): readonly string[] {
  const actorIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "custom" || message.type !== "yesimbot.message") continue;
    const data = message.data as unknown as { readonly user?: { readonly id?: unknown } };
    const userId = typeof data.user?.id === "string" ? data.user.id : undefined;
    if (userId) actorIds.add(userId);
  }
  return [...actorIds];
}

export interface ToolAccessDecision {
  readonly phase: "filter" | "execute";
  readonly turnId: string;
  readonly stepNumber?: number;
  readonly platform: string;
  readonly channelId: string;
  readonly selfId?: string;
  readonly inputIds: readonly string[];
  readonly inputCount: number;
  readonly actorIds: readonly string[];
  readonly actorCount: number;
  readonly toolNames: readonly string[];
  readonly toolCount: number;
  readonly availableToolNames: readonly string[];
  readonly availableToolCount: number;
  readonly allowed: boolean;
  readonly reason: "allowed" | "no-rules" | "scope-mismatch" | "missing-actor" | "actor-denied";
}

/** Shared per-step exposure and execution gates; diagnostics never include bodies or tool arguments. */
export function createToolAccessHooks(options: {
  readonly scope: ToolAccessScope;
  readonly rules: readonly ToolAccessRule[] | undefined;
  readonly toolNames: readonly string[];
  readonly blockReason: string;
  readonly onDecision?: (decision: ToolAccessDecision) => void;
}): Pick<AgentPlugin, "filterTools" | "beforeToolCall"> {
  const names = new Set(options.toolNames);
  if (names.size === 0) return {};
  // One hook instance belongs to one Runtime. Retain only the latest filter coordinate.
  let lastStep: { turnId: string; stepNumber: number } | undefined;
  const check = (phase: ToolAccessDecision["phase"], messages: readonly AgentMessage[], turnId: string, toolNames: readonly string[]): boolean => {
    const actors = extractToolAccessActorIds(messages);
    const allowed = isToolAccessAllowed(options.scope, options.rules, actors);
    if (options.onDecision) {
      const inputIds = messages
        .filter((message) => message.role === "custom" && (message.type === "yesimbot.message" || message.type === "yesimbot.event"))
        .map((message) => message.id);
      const reason: ToolAccessDecision["reason"] = allowed
        ? "allowed"
        : !options.rules?.length
          ? "no-rules"
          : !options.rules.some((rule) => matchesScopeFields(options.scope, rule))
            ? "scope-mismatch"
            : actors.length === 0 && options.scope.userId === undefined
              ? "missing-actor"
              : "actor-denied";
      const available = allowed ? toolNames : [];
      const bounded = (values: readonly string[]) => values.slice(0, 32).map((value) => value.slice(0, 128));
      try {
        options.onDecision({
          phase,
          turnId: turnId?.slice(0, 128),
          ...(lastStep?.turnId === turnId ? { stepNumber: lastStep.stepNumber } : {}),
          platform: options.scope.platform.slice(0, 128),
          channelId: options.scope.channelId.slice(0, 128),
          selfId: options.scope.selfId?.slice(0, 128),
          inputIds: bounded(inputIds),
          inputCount: inputIds.length,
          actorIds: bounded(actors),
          actorCount: actors.length,
          toolNames: bounded(toolNames),
          toolCount: toolNames.length,
          availableToolNames: bounded(available),
          availableToolCount: available.length,
          allowed,
          reason,
        });
      } catch {
        // A broken diagnostic sink must not bypass the authorization gate.
      }
    }
    return allowed;
  };
  return {
    filterTools: (tools, context) => {
      lastStep = { turnId: context.turnId, stepNumber: context.stepNumber };
      const affected = tools.filter((tool) => names.has(tool.name)).map((tool) => tool.name);
      if (affected.length === 0) return tools;
      return check("filter", context.messages, context.turnId, affected) ? tools : tools.filter((tool) => !names.has(tool.name));
    },
    beforeToolCall: (call, context) =>
      names.has(call.toolName) && !check("execute", context.messages, context.turnId, [call.toolName])
        ? { type: "block", reason: options.blockReason }
        : { type: "allow" },
  };
}

function matchesRule(scope: ToolAccessScope, rule: ToolAccessRule, actorUserId: string | undefined): boolean {
  if (!matchesScopeFields(scope, rule)) return false;
  if (!hasUserRestriction(rule)) return true;
  return actorUserId !== undefined && matches(rule.userId!, actorUserId);
}

function matchesScopeFields(scope: ToolAccessScope, rule: ToolAccessRule): boolean {
  if (!matches(rule.platform, scope.platform) || !matches(rule.channelId, scope.channelId)) return false;
  return rule.selfId === undefined || rule.selfId === "" || matches(rule.selfId, scope.selfId);
}

function hasUserRestriction(rule: ToolAccessRule): boolean {
  return rule.userId !== undefined && rule.userId !== "";
}

function normalizeActorIds(actorUserIds: readonly string[] | undefined): string[] {
  return [...new Set((actorUserIds ?? []).filter((actorId) => typeof actorId === "string" && actorId.length > 0))];
}

function matches(pattern: string, value: string | undefined): boolean {
  return pattern === "*" || (value !== undefined && pattern === value);
}
