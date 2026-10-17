import { describe, expect, it } from "vitest";

import {
  DEFAULT_MANAGEMENT_TOOL_SCOPES,
  extractToolAccessActorIds,
  isToolAccessAllowed,
  isToolAccessPotentiallyAllowed,
  type ToolAccessRule,
} from "../src/tool-access.js";

const direct = (userId: string, selfId = "bot") => ({ type: "direct" as const, platform: "onebot", channelId: `private:${userId}`, userId, selfId });
const guild = (channelId: string, selfId = "bot") => ({ type: "guild" as const, platform: "onebot", channelId, guildId: channelId, selfId });
const sharedWithUser = (channelId: string, userId: string, selfId = "bot") => ({ platform: "onebot", channelId, userId, selfId });

const directUserRule = (userId: string, selfId = "*"): ToolAccessRule => ({ platform: "onebot", channelId: "*", userId, selfId });
const guildRule = (channelId: string, selfId = "*"): ToolAccessRule => ({ platform: "onebot", channelId, selfId });

describe("tool access allowlist", () => {
  it("provides the default OneBot operator allowlist without changing prompt inputs", () => {
    expect(DEFAULT_MANAGEMENT_TOOL_SCOPES).toEqual([{ platform: "onebot", channelId: "*", userId: "1049700117" }]);
    expect(isToolAccessAllowed(direct("1049700117"), DEFAULT_MANAGEMENT_TOOL_SCOPES)).toBe(true);
    expect(isToolAccessAllowed(direct("1049700118"), DEFAULT_MANAGEMENT_TOOL_SCOPES)).toBe(false);
    expect(isToolAccessPotentiallyAllowed(guild("group-1"), DEFAULT_MANAGEMENT_TOOL_SCOPES)).toBe(true);
    expect(isToolAccessAllowed(guild("group-1"), DEFAULT_MANAGEMENT_TOOL_SCOPES, ["1049700117"])).toBe(true);
    expect(isToolAccessAllowed(guild("group-1"), DEFAULT_MANAGEMENT_TOOL_SCOPES, ["1049700118"])).toBe(false);
  });

  it("denies empty or missing allowlists", () => {
    expect(isToolAccessAllowed(direct("100"), [])).toBe(false);
    expect(isToolAccessAllowed(direct("100"), undefined)).toBe(false);
  });

  it("authorizes a scope by user ID and optional bot ID", () => {
    expect(isToolAccessAllowed(direct("100", "bot-a"), [directUserRule("100", "bot-a")])).toBe(true);
    expect(isToolAccessAllowed(direct("101", "bot-a"), [directUserRule("100", "bot-a")])).toBe(false);
    expect(isToolAccessAllowed(direct("100", "bot-b"), [directUserRule("100", "bot-a")])).toBe(false);
  });

  it("authorizes a group or channel by exact channel ID", () => {
    expect(isToolAccessAllowed(guild("group-1"), [guildRule("group-1")])).toBe(true);
    expect(isToolAccessAllowed(guild("group-2"), [guildRule("group-1")])).toBe(false);
  });

  it("matches populated allowlist fields without checking chat type", () => {
    expect(isToolAccessAllowed(sharedWithUser("group-1", "100"), [directUserRule("100")])).toBe(true);
    expect(isToolAccessAllowed(sharedWithUser("group-1", "101"), [directUserRule("100")])).toBe(false);
  });

  it("admits a group runtime provisionally for a matching user rule", () => {
    expect(isToolAccessPotentiallyAllowed(guild("group-1"), [directUserRule("100")])).toBe(true);
    expect(isToolAccessPotentiallyAllowed(guild("group-2"), [{ platform: "onebot", channelId: "group-1", userId: "100" }])).toBe(false);
    expect(isToolAccessPotentiallyAllowed(guild("group-1"), [guildRule("group-1")])).toBe(true);
  });

  it("checks every current group actor and lets channel rules cover any actor", () => {
    const rules = [directUserRule("100")];
    expect(isToolAccessAllowed(guild("group-1"), rules, ["100"])).toBe(true);
    expect(isToolAccessAllowed(guild("group-1"), rules, ["100", "100"])).toBe(true);
    expect(isToolAccessAllowed(guild("group-1"), rules, ["100", "101"])).toBe(false);
    expect(isToolAccessAllowed(guild("group-1"), [guildRule("group-1")], ["101", "102"])).toBe(true);
  });

  it("does not grant a user-only group rule to an actor-less turn", () => {
    expect(isToolAccessAllowed(guild("group-1"), [directUserRule("100")])).toBe(false);
    expect(isToolAccessAllowed(guild("group-1"), [guildRule("group-1")])).toBe(true);
    expect(isToolAccessAllowed(direct("100"), [directUserRule("100")])).toBe(true);
  });

  it("extracts unique sender IDs only from raw message carriers", () => {
    const messages = [
      { role: "custom", type: "yesimbot.message", data: { user: { id: "100" } } },
      { role: "custom", type: "yesimbot.message", data: { user: { id: "100" } } },
      { role: "custom", type: "yesimbot.event", data: { user: { id: "101" } } },
      { role: "user", content: "sender=102" },
    ] as never;
    expect(extractToolAccessActorIds(messages)).toEqual(["100"]);
  });
});
