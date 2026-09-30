import type { ChannelContext } from "./channels/context.js";

const WILDCARD = "*";

/** Default direct OneBot operator scope for management tools; execution still requires the tool's own policy. */
export const DEFAULT_MANAGEMENT_TOOL_SCOPES = Object.freeze([{ platform: "onebot", channelId: WILDCARD, userId: "1049700117" }] as const);

/** A scope allowlist rule for sensitive Agent tools. Empty rule lists deny access. */
export interface ToolAccessRule {
  readonly platform: string;
  readonly channelId: string;
  /** Direct-message user ID, normally the QQ number. Omit for channel/guild rules. */
  readonly userId?: string;
  /** Optional bot account restriction. */
  readonly selfId?: string;
}

/**
 * Matches a Runtime scope against the explicit tool allowlist.
 *
 * The default operator scope is intentionally data-only: this matcher gates tool
 * exposure and execution admission, but never changes the general prompt/persona
 * or user-message projection.
 *
 * A rule with `userId` set to a concrete value only matches direct messages. A
 * rule without `userId` matches a channel/guild scope (and can also match a
 * direct channel when its channelId is explicit). `*` is an intentional
 * wildcard for platform, channelId, userId, or selfId.
 */
export function isToolAccessAllowed(scope: ChannelContext, rules: readonly ToolAccessRule[] | undefined): boolean {
  if (!rules || rules.length === 0) return false;
  return rules.some((rule) => {
    if (!matches(rule.platform, scope.platform) || !matches(rule.channelId, scope.channelId)) return false;
    if (rule.selfId !== undefined && rule.selfId !== "" && !matches(rule.selfId, scope.selfId)) return false;
    if (rule.userId === undefined || rule.userId === "" || rule.userId === WILDCARD) return true;
    return scope.type === "direct" && matches(rule.userId, scope.userId);
  });
}

function matches(pattern: string, value: string | undefined): boolean {
  return pattern === WILDCARD || (value !== undefined && pattern === value);
}
