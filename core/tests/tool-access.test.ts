import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MANAGEMENT_TOOL_SCOPES,
  createToolAccessHooks,
  extractToolAccessActorIds,
  isToolAccessAllowed,
  isToolAccessPotentiallyAllowed,
  type ToolAccessDecision,
  type ToolAccessRule,
} from "../src/tool-access.js";

const direct = (userId: string, selfId = "bot") => ({ type: "direct" as const, platform: "onebot", channelId: `private:${userId}`, userId, selfId });
const guild = (channelId: string, selfId = "bot") => ({ type: "guild" as const, platform: "onebot", channelId, guildId: channelId, selfId });
const sharedWithUser = (channelId: string, userId: string, selfId = "bot") => ({ platform: "onebot", channelId, userId, selfId });

const directUserRule = (userId: string, selfId = "*"): ToolAccessRule => ({ platform: "onebot", channelId: "*", userId, selfId });
const guildRule = (channelId: string, selfId = "*"): ToolAccessRule => ({ platform: "onebot", channelId, selfId });
const raw = (id: string, userId: string) => ({ id, role: "custom", type: "yesimbot.message", data: { user: { id: userId }, elements: "PRIVATE_BODY" } });

describe("shared tool access hooks", () => {
  const tools = [{ name: "hostExec" }, { name: "unrelated" }] as never;
  const call = { toolName: "hostExec", toolCallId: "call", args: { command: "SECRET_COMMAND" } };
  const context = (messages: unknown[], turnId = "turn") => ({ turnId, stepNumber: 2, messages }) as never;
  const hooks = (rules: readonly ToolAccessRule[] | undefined = [directUserRule("100")], scope = guild("group")) => {
    const decisions: ToolAccessDecision[] = [];
    return {
      ...createToolAccessHooks({ scope, rules, toolNames: ["hostExec"], blockReason: "blocked", onDecision: (decision) => decisions.push(decision) }),
      decisions,
    };
  };

  it("uses the same actor policy for exposure and execution and leaves unrelated tools alone", async () => {
    const h = hooks();
    const allowed = context([raw("input", "100")]);
    expect(await h.filterTools?.(tools, allowed)).toBe(tools);
    expect(await h.beforeToolCall?.(call, allowed)).toEqual({ type: "allow" });
    const denied = context([raw("input", "100"), raw("join", "101")]);
    expect(await h.filterTools?.(tools, denied)).toEqual([{ name: "unrelated" }]);
    expect(await h.beforeToolCall?.(call, denied)).toEqual({ type: "block", reason: "blocked" });
    expect(await h.beforeToolCall?.({ ...call, toolName: "unrelated" }, denied)).toEqual({ type: "allow" });
    expect(h.decisions).toHaveLength(4);
    expect(h.decisions[3]).toMatchObject({
      phase: "execute",
      stepNumber: 2,
      inputIds: ["input", "join"],
      actorIds: ["100", "101"],
      allowed: false,
      reason: "actor-denied",
      toolNames: ["hostExec"],
      availableToolNames: [],
    });
  });

  it.each([
    { rules: [], messages: [raw("input", "100")], reason: "no-rules" },
    { rules: [guildRule("elsewhere")], messages: [raw("input", "100")], reason: "scope-mismatch" },
    { rules: [directUserRule("100")], messages: [], reason: "missing-actor" },
    {
      rules: [directUserRule("100")],
      messages: [{ id: "event", role: "custom", type: "yesimbot.event", data: { user: { id: "100" }, actorId: "100" } }],
      reason: "missing-actor",
    },
    { rules: [directUserRule("100")], messages: [raw("input", "101")], reason: "actor-denied" },
  ])("reports $reason without exposing private input", async ({ rules, messages, reason }) => {
    const h = hooks(rules);
    expect(await h.filterTools?.(tools, context(messages))).toEqual([{ name: "unrelated" }]);
    expect(h.decisions[0]).toMatchObject({ allowed: false, reason });
    expect(JSON.stringify(h.decisions)).not.toMatch(/PRIVATE_BODY|SECRET_COMMAND/);
  });

  it("preserves direct fallback and explicitly channel-wide rules", async () => {
    const h = createToolAccessHooks({ scope: direct("100"), rules: [directUserRule("100")], toolNames: ["hostExec"], blockReason: "blocked" });
    expect(await h.filterTools?.(tools, context([]))).toBe(tools);
    const channel = hooks([guildRule("group")]);
    expect(await channel.filterTools?.(tools, context([]))).toBe(tools);
    expect(await channel.beforeToolCall?.(call, context([raw("input", "anyone")]))).toEqual({ type: "allow" });
  });

  it("bounds counts, identifiers and lists and never logs message bodies or call arguments", async () => {
    const decisions: ToolAccessDecision[] = [];
    const names = Array.from({ length: 70 }, (_, index) => `tool-${index}-${"t".repeat(200)}`);
    const h = createToolAccessHooks({
      scope: guild("group"),
      rules: [guildRule("group")],
      toolNames: names,
      blockReason: "blocked",
      onDecision: (decision) => decisions.push(decision),
    });
    const candidates = names.map((name) => ({ name })) as never;
    const messages = Array.from({ length: 70 }, (_, index) => raw(`${index}-${"i".repeat(200)}`, `${index}-${"a".repeat(200)}`));
    await h.filterTools?.(candidates, context(messages));
    await h.beforeToolCall?.({ ...call, toolName: names[0]! }, context(messages));
    expect(decisions[0]).toMatchObject({ inputCount: 70, actorCount: 70, toolCount: 70, availableToolCount: 70 });
    for (const decision of decisions) {
      for (const list of [decision.inputIds, decision.actorIds, decision.toolNames, decision.availableToolNames]) {
        expect(list.length).toBeLessThanOrEqual(32);
        expect(list.every((value) => value.length <= 128)).toBe(true);
      }
    }
    expect(JSON.stringify(decisions)).not.toMatch(/PRIVATE_BODY|SECRET_COMMAND|elements|command/);
  });

  it("does not let a failing diagnostic sink bypass either gate", async () => {
    const h = createToolAccessHooks({
      scope: guild("group"),
      rules: [],
      toolNames: ["hostExec"],
      blockReason: "blocked",
      onDecision: () => {
        throw new Error("logger failed");
      },
    });
    expect(await h.filterTools?.(tools, context([raw("input", "100")]))).toEqual([{ name: "unrelated" }]);
    expect(await h.beforeToolCall?.(call, context([raw("input", "100")]))).toEqual({ type: "block", reason: "blocked" });
  });

  it("registers no hooks for an empty sensitive-tool set and emits nothing for unrelated tools", async () => {
    expect(createToolAccessHooks({ scope: guild("group"), rules: [], toolNames: [], blockReason: "blocked" })).toEqual({});
    const onDecision = vi.fn();
    const h = createToolAccessHooks({ scope: guild("group"), rules: [], toolNames: ["hostExec"], blockReason: "blocked", onDecision });
    const candidates = [{ name: "unrelated" }] as never;
    expect(await h.filterTools?.(candidates, context([]))).toBe(candidates);
    await h.beforeToolCall?.({ ...call, toolName: "unrelated" }, context([]));
    expect(onDecision).not.toHaveBeenCalled();
  });
});

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
