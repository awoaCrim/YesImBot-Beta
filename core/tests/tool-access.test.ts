import { describe, expect, it } from "vitest";

import { DEFAULT_MANAGEMENT_TOOL_SCOPES, isToolAccessAllowed, type ToolAccessRule } from "../src/tool-access.js";

const direct = (userId: string, selfId = "bot") => ({ type: "direct" as const, platform: "onebot", channelId: `private:${userId}`, userId, selfId });
const guild = (channelId: string, selfId = "bot") => ({ type: "guild" as const, platform: "onebot", channelId, guildId: channelId, selfId });

const directUserRule = (userId: string, selfId = "*"): ToolAccessRule => ({ platform: "onebot", channelId: "*", userId, selfId });
const guildRule = (channelId: string, selfId = "*"): ToolAccessRule => ({ platform: "onebot", channelId, selfId });

describe("tool access allowlist", () => {
  it("provides the default OneBot operator scope without changing prompt inputs", () => {
    expect(DEFAULT_MANAGEMENT_TOOL_SCOPES).toEqual([{ platform: "onebot", channelId: "*", userId: "1049700117" }]);
    expect(isToolAccessAllowed(direct("1049700117"), DEFAULT_MANAGEMENT_TOOL_SCOPES)).toBe(true);
    expect(isToolAccessAllowed(direct("1049700118"), DEFAULT_MANAGEMENT_TOOL_SCOPES)).toBe(false);
    expect(isToolAccessAllowed(guild("group-1"), DEFAULT_MANAGEMENT_TOOL_SCOPES)).toBe(false);
  });

  it("denies empty or missing allowlists", () => {
    expect(isToolAccessAllowed(direct("100"), [])).toBe(false);
    expect(isToolAccessAllowed(direct("100"), undefined)).toBe(false);
  });

  it("authorizes a direct scope by QQ user ID and optional bot ID", () => {
    expect(isToolAccessAllowed(direct("100", "bot-a"), [directUserRule("100", "bot-a")])).toBe(true);
    expect(isToolAccessAllowed(direct("101", "bot-a"), [directUserRule("100", "bot-a")])).toBe(false);
    expect(isToolAccessAllowed(direct("100", "bot-b"), [directUserRule("100", "bot-a")])).toBe(false);
  });

  it("authorizes a group or channel by exact channel ID", () => {
    expect(isToolAccessAllowed(guild("group-1"), [guildRule("group-1")])).toBe(true);
    expect(isToolAccessAllowed(guild("group-2"), [guildRule("group-1")])).toBe(false);
  });

  it("does not apply a concrete QQ rule to a group scope", () => {
    expect(isToolAccessAllowed(guild("group-1"), [directUserRule("100")])).toBe(false);
  });
});
