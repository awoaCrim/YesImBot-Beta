import { describe, expect, it, vi } from "vitest";
vi.mock("koishi", async () => import("@koishijs/core"));
import { h } from "@satorijs/core";

import type { Account } from "../src/account.js";
import { Config, publicationText } from "../src/index.js";
import { createAccountPlugin } from "../src/tools.js";
const scope = { type: "guild" as const, platform: "xiaoheihe", selfId: "bot", guildId: "account:bot", channelId: "account:bot" };
const account = { config: { selfId: "bot" } } as Account;
describe("adapter config and model boundary", () => {
  it("blocks publication in read-only mode while keeping read tools and records finish", async () => {
    const readOnlyAccount = {
      config: { selfId: "bot", browseCommunities: ["AI"], browseTopics: ["deepseek"] },
      readOnly: true,
      browseSource: "community:AI",
      recordActivity: vi.fn(async () => {}),
    } as unknown as Account;
    const plugin = createAccountPlugin(readOnlyAccount, scope)!;
    expect(plugin.tools?.map((tool) => tool.name)).toContain("xiaoheihe_feed");
    expect(
      await plugin.beforeToolCall!({ toolCallId: "send", toolName: "send_message", args: { parts: [{ kind: "text", text: "title\nbody" }] } }, {
        turnId: "t",
      } as never),
    ).toMatchObject({ type: "block" });
    expect(await plugin.beforeToolCall!({ toolCallId: "done", toolName: "finish", args: {} }, { turnId: "t" } as never)).toBeUndefined();
    expect(readOnlyAccount.recordActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: "send", outcome: "blocked", errorCode: "read_only" }));
    expect(readOnlyAccount.recordActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: "finish", outcome: "ok" }));
  });
  it("makes both quotas independently configurable, with zero disabling writes", () => {
    const defaults = Config({ selfId: "bot", mcp: { type: "stdio", command: "stub" } });
    expect(defaults).toMatchObject({ dailyPostLimit: 1, dailyInteractionLimit: 10, pollIntervalMinutes: 30 });
    expect(Config({ ...defaults, dailyPostLimit: 0, dailyInteractionLimit: 5 })).toMatchObject({ dailyPostLimit: 0, dailyInteractionLimit: 5 });
    expect(() => Config({ ...defaults, dailyPostLimit: -1 })).toThrow();
    expect(() => Config({ ...defaults, pollIntervalMinutes: 1 })).toThrow();
  });
  it("does not register on QQ, another account, or an unknown channel", () => {
    expect(createAccountPlugin(account, { ...scope, platform: "onebot" })).toBeNull();
    expect(createAccountPlugin(account, { ...scope, selfId: "other" })).toBeNull();
    expect(createAccountPlugin(account, { ...scope, channelId: "arbitrary" })).toBeNull();
  });
  it("filters unrelated tools and blocks cross-channel/multipart or repeated writes", async () => {
    const plugin = createAccountPlugin(account, scope)!;
    const input = ["send_message", "finish", "brain_read", "host_bash", "luckin-pay", "xiaoheihe_feed", "delete_post"].map((name) => ({ name }));
    expect((await plugin.filterTools!(input as never, {} as never))!.map((t) => t.name)).toEqual(["send_message", "finish", "xiaoheihe_feed"]);
    const context = { turnId: "turn" } as never;
    const check = (args: unknown) => plugin.beforeToolCall!({ toolCallId: "call", toolName: "send_message", args }, context);
    expect(await check({ channel: "other", parts: [{ kind: "text", text: "hi" }] })).toMatchObject({ type: "block" });
    expect(
      await check({
        parts: [
          { kind: "text", text: "hi" },
          { kind: "text", text: "again" },
        ],
      }),
    ).toMatchObject({ type: "block" });
    expect(await check({ parts: [{ kind: "text", text: "<message>First\nBody</message><message>Second\nBody</message>" }] })).toMatchObject({ type: "block" });
    expect(await check({ parts: [{ kind: "text", text: "Title\nBody" }] })).toBeUndefined();
    expect(await check({ parts: [{ kind: "text", text: "Title\nBody" }] })).toMatchObject({ type: "block" });
    expect(await plugin.beforeToolCall!({ toolCallId: "call", toolName: "host_bash", args: {} }, context)).toMatchObject({ type: "block" });
  });
  it("only accepts plain text and a leading exact comment quote", () => {
    expect(publicationText([h.quote("c"), h.text("reply")])).toEqual({ text: "reply", quoteId: "c" });
    expect(() => publicationText([h.image("https://example.invalid/img.png")])).toThrow("xiaoheihe_text_only");
    expect(() => publicationText([h.quote("c"), h.quote("d"), h.text("reply")])).toThrow();
    expect(() => publicationText([h.text("hi"), h.quote("c")])).toThrow();
  });
});
