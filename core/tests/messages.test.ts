import type { AgentMessage } from "@yesimbot/agent-runtime";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

vi.mock("koishi", async () => import("@koishijs/core"));

import { Element, h, Universal } from "koishi";

import {
  assembleEvent,
  createEvent,
  createMessage,
  formatCurrentInput,
  formatCurrentInputWithImages,
  formatInput,
  formatInputWithImages,
  isEvent,
  isMessage,
  isMessageRecord,
  type Event,
  type EventBase,
  type EventMap,
  type EventRecord,
  type Message,
  type MessageRecord,
  type RecordBase,
} from "../src/messages/index.js";
import { parseReply } from "../src/messages/index.js";
import { PNG_BYTES, scope } from "./helpers/index.js";

type Input = Message | Event;

declare module "koishi-plugin-yesimbot" {
  interface EventMap {
    "test.variant": { channel: { id: string }; test: { value: number } };
  }
}

declare module "koishi-plugin-yesimbot" {
  interface EventMap {
    "formatter.variant": { extra: { secret: string } };
  }
}

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

function messageRecord(overrides: { timestamp?: number; quote?: MessageRecord["quote"] } = {}): MessageRecord {
  return {
    platform: "test",
    selfId: "bot-1",
    channel: { id: "channel-1", type: Universal.Channel.Type.TEXT },
    user: { id: "user-1", name: "Alice" },
    messageId: "m1",
    elements: [h.text("hello")],
    timestamp: overrides.timestamp ?? 1234,
    ...(overrides.quote ? { quote: overrides.quote } : {}),
  };
}

function recordBase(): RecordBase {
  return {
    platform: "test",
    selfId: "bot-1",
    channel: { id: "channel-1", type: Universal.Channel.Type.TEXT, name: "Room" },
    user: { id: "user-1", name: "Alice" },
    timestamp: 1234,
  };
}

function deliveryFailureRecord(overrides: { timestamp?: number } = {}): EventRecord<"delivery.failed"> {
  return {
    eventType: "delivery.failed",
    platform: "test",
    selfId: "bot-1",
    channel: { id: "channel-1", type: Universal.Channel.Type.TEXT },
    delivery: { turnId: "turn-1", messageId: "assistant-1", segmentIndex: 1, segmentTotal: 1, error: { name: "Error", message: "offline" } },
    text: "failed",
    timestamp: overrides.timestamp ?? 5678,
  };
}

describe("Event", () => {
  it("creates yesimbot.message without payload timestamp", () => {
    const message = createMessage(messageRecord({ timestamp: 1234 }));
    expect(message).toMatchObject({ role: "custom", type: "yesimbot.message", timestamp: 1234, data: { messageId: "m1" } });
    expect("timestamp" in message.data).toBe(false);
    expect(message.data).not.toHaveProperty("schemaVersion");
  });

  it("creates eventType-discriminated yesimbot.event", () => {
    const event = createEvent(deliveryFailureRecord({ timestamp: 5678 }));
    expect(event).toMatchObject({ type: "yesimbot.event", timestamp: 5678, data: { eventType: "delivery.failed" } });
    expect("timestamp" in event.data).toBe(false);
    expect(event.data).not.toHaveProperty("schemaVersion");
  });

  it("isMessageRecord distinguishes message from event records", () => {
    expect(isMessageRecord(messageRecord())).toBe(true);
    expect(isMessageRecord(deliveryFailureRecord())).toBe(false);
  });

  it("recognizes yesimbot.message custom messages as Message", () => {
    const message = createMessage(messageRecord());
    const nonMessage: AgentMessage = { id: "x", timestamp: 0, role: "custom", type: "other", data: {} } as AgentMessage;

    expect(isMessage(message)).toBe(true);
    expect(isMessage(nonMessage)).toBe(false);
    expectTypeOf<Message>().toMatchTypeOf<{ role: "custom"; type: "yesimbot.message" }>();
  });

  it("recognizes yesimbot.event custom messages as Event", () => {
    const event = createEvent(deliveryFailureRecord());
    const nonEvent: AgentMessage = { id: "x", timestamp: 0, role: "custom", type: "other", data: {} } as AgentMessage;

    expect(isEvent(event)).toBe(true);
    expect(isEvent(nonEvent)).toBe(false);
    expectTypeOf<Event>().toMatchTypeOf<{ role: "custom"; type: "yesimbot.event" }>();
  });

  it("recognizes custom discriminators without re-validating their payloads", () => {
    const badMessage = { id: "x", timestamp: 0, role: "custom", type: "yesimbot.message", data: { messageId: "m1", text: "hello" } } as AgentMessage;
    const badEvent = { id: "y", timestamp: 0, role: "custom", type: "yesimbot.event", data: { eventType: "delivery.failed", text: "failed" } } as AgentMessage;

    expect(isMessage(badMessage)).toBe(true);
    expect(isEvent(badEvent)).toBe(true);
  });

  it("Message type exposes elements, messageId, and an optional normalized quote", () => {
    expectTypeOf<Message["data"]["elements"]>().toBeArray();
    expectTypeOf<Message["data"]["messageId"]>().toBeString();
    expectTypeOf<Message["data"]["quote"]>().toEqualTypeOf<MessageRecord["quote"]>();
    expectTypeOf<NonNullable<MessageRecord["quote"]>["author"]>().toEqualTypeOf<{ readonly id: string; readonly isBot?: boolean } | undefined>();
  });

  it("Event type exposes eventType and text", () => {
    expectTypeOf<Event["data"]["eventType"]>().toBeString();
    expectTypeOf<Event["data"]["text"]>().toBeString();
  });

  it("Event data excludes timestamp from persisted payload", () => {
    // Prove "timestamp" is not a key of Event["data"].
    type _Assert = "timestamp" extends keyof Event["data"] ? never : true;
    expect(true as _Assert).toBe(true);
  });

  it("delivery.failed variant retains delivery field in persisted data", () => {
    type D = Event<"delivery.failed">["data"];
    expectTypeOf<D["delivery"]["turnId"]>().toBeString();
    expectTypeOf<D["delivery"]["messageId"]>().toBeString();
    expectTypeOf<D["delivery"]["segmentIndex"]>().toBeNumber();
    expectTypeOf<D["delivery"]["segmentTotal"]>().toBeNumber();
    expectTypeOf<D["eventType"]>().toEqualTypeOf<"delivery.failed">();
  });

  it("declaration-merged test.variant retains test.value in persisted data", () => {
    type T = Event<"test.variant">["data"];
    expectTypeOf<T["test"]["value"]>().toBeNumber();
    expectTypeOf<T["channel"]["id"]>().toBeString();
    expectTypeOf<T["eventType"]>().toEqualTypeOf<"test.variant">();
  });

  it("assembles events from RecordBase without copying user", () => {
    const event = assembleEvent(recordBase(), { eventType: "test.variant", text: "variant", test: { value: 42 } });

    expect(event).toMatchObject({
      platform: "test",
      selfId: "bot-1",
      channel: { id: "channel-1", name: "Room" },
      eventType: "test.variant",
      text: "variant",
      test: { value: 42 },
    });
    expect(event).not.toHaveProperty("user");
  });

  it("assembles delivery.failed without payload channel or user residue", () => {
    const event = assembleEvent(recordBase(), {
      eventType: "delivery.failed",
      text: "Delivery failed",
      delivery: { turnId: "turn-1", messageId: "assistant-1", segmentIndex: 1, segmentTotal: 1, error: { name: "Error", message: "offline" } },
    });

    expect(event).toMatchObject({
      eventType: "delivery.failed",
      text: "Delivery failed",
      channel: { id: "channel-1", name: "Room" },
      delivery: { turnId: "turn-1", messageId: "assistant-1" },
    });
    expect(event).not.toHaveProperty("user");
  });

  it("constructs a declaration-merged event from the closed host base", () => {
    const event = createEvent({
      eventType: "test.variant",
      platform: "test",
      selfId: "bot-1",
      channel: { id: "channel-1" },
      timestamp: 5678,
      text: "variant",
      test: { value: 42 },
    });

    expect(event.data).toMatchObject({
      eventType: "test.variant",
      platform: "test",
      selfId: "bot-1",
      channel: { id: "channel-1" },
      text: "variant",
      test: { value: 42 },
    });
    expect(Object.keys(event.data).sort()).toEqual(["channel", "eventType", "platform", "selfId", "test", "text"]);
    expect(event.data).not.toHaveProperty("message");
    expect(event.data).not.toHaveProperty("content");
    expect(event.data).not.toHaveProperty("type");
  });

  it("keeps message and event host records free of Universal.Event residue", () => {
    expectTypeOf<MessageRecord>().toHaveProperty("messageId");
    expectTypeOf<MessageRecord>().toHaveProperty("elements");
    expectTypeOf<MessageRecord>().not.toHaveProperty("guild");
    expectTypeOf<MessageRecord>().not.toHaveProperty("member");
    expectTypeOf<EventBase>().toHaveProperty("eventType");
    expectTypeOf<EventBase>().toHaveProperty("text");
    expectTypeOf<EventBase>().not.toHaveProperty("guild");
    expectTypeOf<EventBase>().not.toHaveProperty("member");
  });

  it("rejects inherited Universal.Event resources from a message record", () => {
    // @ts-expect-error MessageRecord must not admit Universal.Event residue.
    const record: MessageRecord = { ...messageRecord(), guild: { id: "guild-1" } };

    expect(record.messageId).toBe("m1");
  });

  it("createEvent returns variant-specific Event type", () => {
    const event = createEvent(deliveryFailureRecord());
    expectTypeOf(event.data.eventType).toEqualTypeOf<"delivery.failed">();
    expectTypeOf(event.data.delivery.turnId).toBeString();
    expectTypeOf(event.data.text).toBeString();
  });

  it("EventMap no longer contains a message variant", () => {
    type MapKeys = keyof EventMap;
    expectTypeOf<MapKeys>().toEqualTypeOf<"delivery.failed" | "test.variant" | "formatter.variant">();
  });
});

// ---------------------------------------------------------------------------
// formatInput
// ---------------------------------------------------------------------------

const ASSET_ID = "00000000000000000000000000000000";

function miMessageRecord(overrides: { timestamp?: number; quote?: MessageRecord["quote"]; elements?: readonly Element[] } = {}): MessageRecord {
  return {
    platform: scope.platform,
    selfId: scope.selfId,
    channel: { id: scope.channelId },
    user: { id: "10001", name: "Alice" },
    messageId: "m-1",
    elements: overrides.elements ?? [h.text("hello")],
    timestamp: overrides.timestamp ?? Date.parse("2026-07-18T12:34:00.000Z"),
    ...(overrides.quote ? { quote: overrides.quote } : {}),
  };
}

function miMessageRecordWithText(text: string, overrides: { timestamp?: number } = {}): MessageRecord {
  return { ...miMessageRecord(overrides), elements: h.parse(text) };
}

function miDeliveryFailureRecord(): EventRecord<"delivery.failed"> {
  return {
    eventType: "delivery.failed",
    platform: scope.platform,
    selfId: scope.selfId,
    channel: { id: scope.channelId },
    delivery: { turnId: "turn-1", messageId: "assistant-1", segmentIndex: 1, segmentTotal: 1, error: { name: "Error", message: "offline" } },
    text: "failed",
    timestamp: Date.parse("2026-07-18T12:34:00.000Z"),
  };
}

function miFormatterVariantRecord(): EventRecord<"formatter.variant"> {
  return {
    eventType: "formatter.variant",
    platform: scope.platform,
    selfId: scope.selfId,
    channel: { id: scope.channelId },
    extra: { secret: "do-not-project" },
    text: "variant",
    timestamp: Date.parse("2026-07-18T12:34:00.000Z"),
  };
}

function project(input: Input) {
  return formatInput(input);
}

describe("formatInput", () => {
  it("always formats a message with the fixed header including its ID", async () => {
    const input = createMessage(miMessageRecord({ timestamp: new Date("2026-07-25T12:34:00.000Z").valueOf() }));

    expect(project(input)).toEqual({ role: "user", content: '[time="2026/7/25 20:34" sender="Alice (10001)" id="m-1"]\nhello' });
  });

  it("marks the current message body without hiding its observation header", () => {
    const input = createMessage(
      miMessageRecord({
        elements: [h("at", { id: "bot-1" }), h.text(" ?")],
      }),
    );
    const content = String(formatCurrentInput(input).content);
    const markerStart = content.indexOf("[CURRENT_MESSAGE]");
    const markerEnd = content.indexOf("[/CURRENT_MESSAGE]");

    expect(markerStart).toBeGreaterThan(0);
    expect(markerEnd).toBeGreaterThan(markerStart);
    expect(content.slice(0, markerStart)).toContain('sender="Alice (10001)"');
    expect(content.slice(0, markerStart)).toContain('id="m-1"');
    expect(content.slice(markerStart, markerEnd)).toContain('<at id="bot-1"/> ?');
  });

  it("hydrates JSONL-replayed Elements before rendering", async () => {
    const replayed = JSON.parse(JSON.stringify(createMessage(miMessageRecord()))) as Input;

    const first = await project(replayed);
    const second = await project(replayed);

    expect(first).toEqual(second);
    expect(String(first.content)).not.toContain("[object Object]");
    expect(first.content).toContain("\nhello");
  });

  it("renders a normalized quote before the current message", async () => {
    const quotedAsset = "11111111111111111111111111111111";
    const currentAsset = "22222222222222222222222222222222";
    const input = createMessage(
      miMessageRecord({
        quote: { messageId: "quoted-1", elements: [h("img", { id: quotedAsset })] },
        elements: [h("img", { id: currentAsset }), h.text("如何评价")],
      }),
    );

    const result = await project(input);
    const content = String(result.content);
    const quoteStart = content.indexOf('[QUOTED_MESSAGE id="quoted-1"]');
    const quoteEnd = content.indexOf("[/QUOTED_MESSAGE]", quoteStart);

    expect(quoteStart).toBeGreaterThanOrEqual(0);
    expect(quoteEnd).toBeGreaterThan(quoteStart);
    expect(content.slice(quoteStart, quoteEnd)).toContain(`[图片：asset://${quotedAsset}]`);
    expect(content.slice(quoteStart, quoteEnd)).not.toContain(currentAsset);
    expect(content.indexOf("如何评价")).toBeGreaterThan(quoteEnd);
  });

  it("does not duplicate quote content when current elements already contain a quote element", async () => {
    const input = createMessage(
      miMessageRecord({
        quote: { messageId: "quoted-1", elements: [h.text("quoted content")] },
        elements: [h("quote", { id: "quoted-1" }, [h.text("quoted content")]), h.text("继续")],
      }),
    );

    const result = await project(input);

    expect(String(result.content)).toContain('[QUOTED_MESSAGE id="quoted-1"]');
    expect(String(result.content).match(/quoted content/g)).toHaveLength(1);
    expect(String(result.content)).toContain("quoted content");
    expect(String(result.content)).toContain("继续");
  });

  it.each(["10002", "bot-1"])("separates the quoted sender %s from the current sender", (sender) => {
    const record = miMessageRecord({ quote: { messageId: "quoted-1", author: { id: sender }, elements: [h.text("their words")] } });
    const result = String(project(createMessage(record)).content);
    expect(result).toContain('sender="Alice (10001)"');
    expect(result).toContain(`[QUOTED_MESSAGE id="quoted-1" sender="${sender}"]\ntheir words\n[/QUOTED_MESSAGE]\nhello`);
    expect(record.quote?.author?.id).toBe(sender);
  });

  it("does not invent a quoted sender when author metadata is absent or empty", () => {
    for (const author of [undefined, { id: "" }]) {
      const input = createMessage(miMessageRecord({ quote: { messageId: "quoted-1", author, elements: [h.text("their words")] } }));
      expect(String(project(input).content)).toContain('[QUOTED_MESSAGE id="quoted-1"]\ntheir words');
    }
  });

  it("JSON-escapes quote IDs and authors without adding observation lines", () => {
    const input = createMessage(miMessageRecord({ quote: { messageId: 'q"\n1', author: { id: 'u"\n2' }, elements: [h.text("words")] } }));
    expect(String(project(input).content).split("\n")[1]).toBe(String.raw`[QUOTED_MESSAGE id="q\"\n1" sender="u\"\n2"]`);
  });

  it.each(["quote", "reply"])("preserves normalized content and author with an inline %s placeholder", (type) => {
    const input = createMessage(
      miMessageRecord({
        quote: { messageId: "quoted-1", author: { id: "10002" }, elements: [h.text("their words")] },
        elements: [h(type, { id: "quoted-1" }), h("at", { id: "bot-1" }), h.text("what do you think?")],
      }),
    );
    const result = String(project(input).content);
    expect(result).toContain('[QUOTED_MESSAGE id="quoted-1" sender="10002"]\ntheir words');
    expect(result.match(/their words/g)).toHaveLength(1);
    expect(result).not.toContain(`<${type}`);
    expect(result).toContain('<at id="bot-1"/>what do you think?');
  });

  it("deduplicates nested matching quotes without mutating replayed elements", () => {
    const input = JSON.parse(
      JSON.stringify(
        createMessage(
          miMessageRecord({
            quote: { messageId: "quoted-1", author: { id: "10002" }, elements: [h.text("their words")] },
            elements: [h("message", {}, [h("reply", { id: "quoted-1" }, [h.text("their words")]), h.text("current words")])],
          }),
        ),
      ),
    ) as Message;
    const before = JSON.stringify(input);
    const result = String(project(input).content);
    expect(result).toContain('[QUOTED_MESSAGE id="quoted-1" sender="10002"]');
    expect(result.match(/their words/g)).toHaveLength(1);
    expect(result).toContain("current words");
    expect(JSON.stringify(input)).toBe(before);
    expect(String(project(input).content)).toBe(result);
  });

  it.each(["other-quote", undefined])("does not drop or reattribute an inline quote with ID %s", (id) => {
    const input = createMessage(
      miMessageRecord({
        quote: { messageId: "quoted-1", author: { id: "10002" }, elements: [h.text("normalized words")] },
        elements: [h("quote", id ? { id } : {}, [h.text("other words")]), h.text("current words")],
      }),
    );
    const result = String(project(input).content);
    expect(result).toContain('[QUOTED_MESSAGE id="quoted-1" sender="10002"]\nnormalized words\n[/QUOTED_MESSAGE]');
    expect(result).toContain("other words");
    expect(result).toContain("current words");
  });

  it("keeps inline content if the normalized quote has no elements", () => {
    const input = createMessage(
      miMessageRecord({
        quote: { messageId: "quoted-1", author: { id: "10002" }, elements: [] },
        elements: [h("quote", { id: "quoted-1" }, [h.text("only inline words")]), h.text("current words")],
      }),
    );
    const result = String(project(input).content);
    expect(result).toContain('[QUOTED_MESSAGE id="quoted-1" sender="10002"]');
    expect(result).toContain("only inline words");
  });

  it("preserves legacy inline-only quotes without inventing normalized metadata", () => {
    const input = createMessage(miMessageRecord({ elements: [h("quote", { id: "legacy" }, [h.text("legacy words")]), h.text("current words")] }));
    const result = String(project(input).content);
    expect(result).not.toContain("[QUOTED_MESSAGE");
    expect(result).toContain('<quote id="legacy">legacy words</quote>current words');
  });

  it("keeps normalized quote assets after JSONL replay", async () => {
    const quotedAsset = "33333333333333333333333333333333";
    const replayed = JSON.parse(
      JSON.stringify(
        createMessage(
          miMessageRecord({
            quote: { messageId: "quoted-3", elements: [h("img", { id: quotedAsset })] },
            elements: [h.text("评价一下")],
          }),
        ),
      ),
    ) as Input;

    const result = await project(replayed);

    expect(result.content).toContain('[QUOTED_MESSAGE id="quoted-3"]');
    expect(result.content).toContain(`[图片：asset://${quotedAsset}]`);
    expect(result.content).toContain("评价一下");
  });

  it("does not duplicate quote content when current elements contain a reply element", async () => {
    const input = createMessage(
      miMessageRecord({
        quote: { messageId: "quoted-2", elements: [h.text("quoted content")] },
        elements: [h("reply", { id: "quoted-2" }, [h.text("quoted content")]), h.text("继续")],
      }),
    );

    const result = await project(input);

    expect(String(result.content)).toContain('[QUOTED_MESSAGE id="quoted-2"]');
    expect(String(result.content).match(/quoted content/g)).toHaveLength(1);
    expect(String(result.content)).toContain("quoted content");
    expect(String(result.content)).toContain("继续");
  });

  it("formats events from only eventType and text", async () => {
    const event: Event = createEvent(miFormatterVariantRecord());
    const result = await project(event);

    expect(result.content).toContain('"eventType":"formatter.variant"');
    expect(result.content).toContain('"text":"variant"');
    expect(result.content).not.toContain("extra");
  });

  it("marks a runtime event as the current turn instead of a continuation request", async () => {
    const event: Event = createEvent(miFormatterVariantRecord());
    const result = await project(event);
    const content = String(result.content);

    const boundary = content.indexOf("[SYSTEM_NOTIFICATION]");
    expect(content).toContain("current runtime event for this turn");
    expect(content).toContain("not a continuation of the previous user request");
    expect(content).toContain("do not treat an earlier user message as a new request");
    expect(content.indexOf("current runtime event for this turn")).toBeLessThan(boundary);
    expect(content.indexOf("eventType")).toBeGreaterThan(boundary);
  });

  it("renders persisted image references as safe asset text without bytes", async () => {
    const input = createMessage(miMessageRecordWithText(`<img id="${ASSET_ID}"/>`));
    const result = await project(input);

    expect(result.content).toContain(`[图片：asset://${ASSET_ID}]`);
    expect(result.content).not.toContain("<img");
  });

  it("never leaks src, data URIs, or platform URLs for unpersisted images", async () => {
    const input = createMessage(miMessageRecordWithText('<img src="https://example.test/x.png"/><img src="data:image/png;base64,AAAA"/>'));
    const result = await project(input);

    expect(result.content).toContain("[图片：资源不可用]");
    expect(String(result.content)).not.toContain("https://");
    expect(String(result.content)).not.toContain("base64");
  });

  it("keeps nested image elements discoverable in document order", async () => {
    const input = createMessage({ ...miMessageRecord(), elements: [h("p", {}, [h("span", {}, [h("img", { id: "11111111111111111111111111111111" })])])] });
    const result = await project(input);

    expect(result.content).toContain("[图片：asset://11111111111111111111111111111111]");
  });

  it("never reads asset bytes during model projection", async () => {
    const input = createMessage(miMessageRecordWithText(`<img id="${ASSET_ID}"/>`));
    const result = await project(input);

    expect(result.content).toContain(`asset://${ASSET_ID}`);
  });

  it("formats delivery-failed notifications with the generic current-turn boundary", async () => {
    const event: Event = createEvent(miDeliveryFailureRecord());
    const result = await project(event);
    const content = String(result.content);

    expect(content).toContain("[SYSTEM_NOTIFICATION]");
    expect(content).toContain("not a continuation of the previous user request");
    expect(content).toContain('"eventType":"delivery.failed"');
  });
});

// ---------------------------------------------------------------------------
// parseReply
// ---------------------------------------------------------------------------

function text(segment: readonly Element[]): string {
  return segment.map((element) => (element.type === "text" ? `${element.attrs["content"] ?? ""}` : element.toString())).join("");
}

describe("parseReply", () => {
  it("produces one fragment for plain text", () => {
    const segments = parseReply("hello world");
    expect(segments).toHaveLength(1);
    expect(text(segments[0])).toBe("hello world");
  });

  it("splits message elements into separate delivery segments", () => {
    const segments = parseReply("one<message>two</message>three");
    expect(segments.map(text)).toEqual(["one", "two", "three"]);
  });

  it("splits nested message elements into separate delivery segments", () => {
    const segments = parseReply("one<message>two<message>three</message></message>four");
    expect(segments.map(text)).toEqual(["one", "two", "three", "four"]);
  });

  it("preserves platform elements at the reply root", () => {
    const segments = parseReply('hello <at id="42"/> there');
    expect(segments).toHaveLength(1);
    expect(segments[0].find((element) => element.type === "at")?.attrs["id"]).toBe("42");
  });

  it("keeps at and quote elements inside the same message segment", () => {
    const segments = parseReply('hello <at id="42"/> <quote>quoted</quote> world');
    expect(segments).toHaveLength(1);
    expect(segments[0].some((element) => element.type === "at")).toBe(true);
    expect(segments[0].some((element) => element.type === "quote")).toBe(true);
  });

  it("preserves unrecognized Koishi elements without a Core allowlist", () => {
    const segments = parseReply('<custom-card state="open"/>');
    expect(segments).toHaveLength(1);
    expect(segments[0][0].type).toBe("custom-card");
    expect(segments[0][0].attrs["state"]).toBe("open");
  });

  it("delivers <text> content literally with no nested elements", () => {
    const segments = parseReply("<text>List<String> generic</text>");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(1);
    expect(segments[0][0].type).toBe("text");
    expect(text(segments[0])).toBe("List<String> generic");
  });

  it("does not parse a message element inside <text>", () => {
    const segments = parseReply("<text>before<message>after</message></text>");
    expect(segments).toHaveLength(1);
    expect(text(segments[0])).toBe("before<message>after</message>");
  });

  it("keeps escaped element syntax as literal text", () => {
    const segments = parseReply("before&lt;message&gt;after&lt;/message&gt;");
    expect(segments).toHaveLength(1);
    expect(text(segments[0])).toBe("before<message>after</message>");
  });

  it("fully removes root inner thought from the output", () => {
    const segments = parseReply("<inner_thought>private plan</inner_thought>visible reply");
    expect(segments).toHaveLength(1);
    expect(text(segments[0])).toBe("visible reply");
  });

  it("fully removes inner thought nested in a message element", () => {
    const segments = parseReply("<message>visible<inner_thought>private</inner_thought></message>");
    expect(segments).toHaveLength(1);
    expect(text(segments[0])).toBe("visible");
  });

  it("fully removes inner thought protected by a text container", () => {
    const segments = parseReply("<text>visible<inner_thought>private</inner_thought> after</text>");
    expect(segments).toHaveLength(1);
    expect(text(segments[0])).toBe("visible after");
  });

  it("keeps a reply tag as an ordinary unknown element now that delivery is explicit", () => {
    const segments = parseReply("思考内容<reply>这是最终回复</reply>尾巴");
    expect(segments).toHaveLength(1);
    expect(text(segments[0])).toBe("思考内容<reply>这是最终回复</reply>尾巴");
  });

  it("does not create empty segments around message boundaries", () => {
    expect(parseReply("one<message/>two")).toEqual([[h.text("one")], [h.text("two")]]);
  });

  it("does not trigger substitution for text resembling the nonce placeholder", () => {
    const segments = parseReply(" r0  not a real capture");
    expect(segments).toHaveLength(1);
    expect(text(segments[0])).toBe("r0 not a real capture");
  });
});

// ---------------------------------------------------------------------------
// Request-only image input
// ---------------------------------------------------------------------------

const TEST_ASSET_ONE = "11111111111111111111111111111111";
const TEST_ASSET_TWO = "22222222222222222222222222222222";

function imageMessage(elements: readonly Element[], quote?: MessageRecord["quote"]): Message {
  return createMessage({
    ...messageRecord(),
    messageId: "image-message",
    elements,
    ...(quote ? { quote } : {}),
  });
}

describe("request-only image input", () => {
  it("renders bounded failure reasons instead of a bare image placeholder", () => {
    const input = imageMessage([h("img", { yesimbotFailure: "timeout" }), h.text("后续")]);
    const content = String(formatInput(input).content);

    expect(content).toContain("[图片：读取超时]");
    expect(content).not.toContain("[图片]");
    expect(String(formatInput(imageMessage([h("img", {})])).content)).toContain("[图片：资源不可用]");
  });

  it("projects image bytes in message and quote order without mutating the message", async () => {
    const input = imageMessage([h.text("当前"), h("img", { id: TEST_ASSET_TWO }), h.text("结束")], {
      messageId: "quoted-1",
      elements: [h.text("引用"), h("img", { id: TEST_ASSET_ONE })],
      author: { id: "quoted-user" },
    });
    const resolver = vi.fn(async (assetId: string) => ({ bytes: assetId === TEST_ASSET_ONE ? PNG_BYTES : new Uint8Array([1, 2, 3]), mediaType: "image/png" }));
    const before = structuredClone(input.data);

    const projected = await formatCurrentInputWithImages(input, resolver);

    expect(projected.content).toEqual([
      { type: "text", text: expect.stringContaining('[QUOTED_MESSAGE id="quoted-1" sender="quoted-user"]') },
      { type: "image", image: PNG_BYTES, mediaType: "image/png" },
      { type: "text", text: expect.stringContaining("当前") },
      { type: "image", image: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
      { type: "text", text: expect.stringContaining("[/CURRENT_MESSAGE]") },
    ]);
    expect(resolver.mock.calls.map(([assetId]) => assetId)).toEqual([TEST_ASSET_ONE, TEST_ASSET_TWO]);
    expect(input.data).toEqual(before);
    expect(JSON.stringify(projected.content)).not.toContain("asset://");
  });

  it("resolves images nested inside message elements in source order", async () => {
    const input = imageMessage([h("paragraph", {}, [h.text("前"), h("img", { id: TEST_ASSET_ONE }), h.text("后")])]);
    const projected = await formatInputWithImages(input, async () => ({ bytes: PNG_BYTES, mediaType: "image/png" }));

    expect(projected.content).toEqual([
      { type: "text", text: expect.stringContaining("前") },
      { type: "image", image: PNG_BYTES, mediaType: "image/png" },
      { type: "text", text: expect.stringContaining("后") },
    ]);
  });

  it("keeps a bounded failure reason when request-only image resolution fails", async () => {
    const input = imageMessage([h.text("前"), h("img", { id: TEST_ASSET_ONE }), h.text("后")]);
    const projected = await formatInputWithImages(input, async () => ({ error: "resource_missing" }));

    expect(String(projected.content)).toContain("[图片：资源不存在]");
  });
});
