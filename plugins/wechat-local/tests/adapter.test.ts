import { Context, HTTP, h } from "@satorijs/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as plugin from "../src";
import { plainText, WechatLocalBot } from "../src";
import { PrivateTextClient, type ClientConfig, type SocketFactory } from "../src/client";
import { decodeFrame, PROTOCOL } from "../src/protocol";

const config: ClientConfig = {
  endpoint: "ws://127.0.0.1:17300/",
  token: "a".repeat(64),
  expectedSelfId: "wxid_fixture_self",
  peerId: "wxid_fixture_peer",
  requestTimeoutMs: 500,
};
const hello = { t: "hello", protocol: PROTOCOL, selfId: config.expectedSelfId, peerId: config.peerId, peerName: "Fixture", boundAt: 1700000000000 };
const message = {
  id: "9223372036854775806",
  sender: config.peerId,
  peerId: config.peerId,
  ts: hello.boundAt + 1000,
  type: "text",
  text: '<image src="untrusted"/> & hello',
  isSelf: false,
};

class FakeSocket extends EventTarget {
  readyState = 1;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  receive(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

function fixture(overrides: Partial<ClientConfig> = {}) {
  const sockets: FakeSocket[] = [];
  const open = vi.fn(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as unknown as ReturnType<SocketFactory>;
  });
  const onMessage = vi.fn();
  const onReady = vi.fn();
  const onClose = vi.fn();
  const client = new PrivateTextClient({ ...config, ...overrides }, open, onMessage, onReady, onClose);
  return { client, sockets, open, onMessage, onReady, onClose };
}

async function connect(f: ReturnType<typeof fixture>) {
  const result = f.client.connect();
  f.sockets.at(-1)!.receive(hello);
  await result;
  return f.sockets.at(-1)!;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("private text protocol", () => {
  it("preserves 64-bit message IDs and treats inbound text literally", () => {
    expect(decodeFrame(JSON.stringify({ t: "msg", m: message }))).toEqual({ t: "msg", m: message });
    expect(decodeFrame(JSON.stringify({ t: "msg", m: { ...message, id: Number(message.id) } }))).toBeUndefined();
  });

  it.each([
    { ...hello, protocol: "unknown" },
    { ...hello, peerId: "room@chatroom" },
    { t: "msg", m: { ...message, type: "image" } },
    { t: "msg", m: { ...message, text: "x".repeat(16385) } },
    { t: "msg", m: { ...message, text: "bad\0text" } },
    { t: "msg", m: { ...message, text: "\ud800" } },
    { t: "reply", id: "request", ok: true, result: { accepted: true, delivery: "confirmed", messageIds: ["invented"] } },
  ])("rejects unsupported or malformed frames %#", (frame) => {
    expect(decodeFrame(JSON.stringify(frame))).toBeUndefined();
  });

  it("rejects non-loopback endpoints and missing scope before opening transport", () => {
    for (const endpoint of ["ws://example.com/", "wss://127.0.0.1/", "ws://127.0.0.1/?token=x", "ws://user@127.0.0.1/"]) {
      expect(() => fixture({ endpoint })).toThrow("loopback_endpoint_required");
    }
    expect(() => fixture({ token: "" })).toThrow("token_required");
    expect(() => fixture({ peerId: config.expectedSelfId })).toThrow("private_binding_required");
  });

  it("allows plain text only without silently dropping media or quotes", () => {
    expect(plainText(h.text("<image/>"))).toBe("<image/>");
    expect(plainText("hello &amp; goodbye")).toBe("hello & goodbye");
    for (const content of [h.image("file:///fixture"), h("quote", { id: "1" }), h("at", { id: "other" }), ""]) {
      expect(() => plainText(content)).toThrow();
    }
  });
});

describe("scoped client lifecycle", () => {
  it("authenticates, validates binding, and drops other contacts, self, history and duplicates", async () => {
    const f = fixture();
    const socket = await connect(f);
    expect(f.open).toHaveBeenCalledWith(config.endpoint, config.token);
    expect(f.onReady).toHaveBeenCalledOnce();
    socket.receive({ t: "msg", m: { ...message, sender: "wxid_other" } });
    socket.receive({ t: "msg", m: { ...message, peerId: "wxid_other" } });
    socket.receive({ t: "msg", m: { ...message, isSelf: true } });
    socket.receive({ t: "msg", m: { ...message, sender: config.expectedSelfId } });
    socket.receive({ t: "msg", m: { ...message, ts: hello.boundAt - 1 } });
    expect(f.onMessage).not.toHaveBeenCalled();
    socket.receive({ t: "msg", m: message });
    socket.receive({ t: "msg", m: message });
    expect(f.onMessage).toHaveBeenCalledExactlyOnceWith(message, hello);
    f.client.disconnect();
    expect(f.client.connected).toBe(false);
  });

  it("fails closed on wrong hello and handshake timeout", async () => {
    const f = fixture();
    const connecting = f.client.connect();
    const rejected = connecting.catch((error: unknown) => error);
    f.sockets[0].receive({ ...hello, selfId: "wxid_other" });
    await expect(rejected).resolves.toMatchObject({ message: "binding_mismatch" });
    expect(f.client.connected).toBe(false);
    expect(f.onMessage).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const idle = fixture();
    const pending = idle.client.connect().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(501);
    await expect(pending).resolves.toMatchObject({ message: "handshake_timeout" });
    expect(idle.onReady).not.toHaveBeenCalled();
  });

  it("sends once and returns no fabricated proof on unconfirmed acceptance", async () => {
    const f = fixture();
    const socket = await connect(f);
    const pending = f.client.sendText("synthetic reply");
    expect(() => f.client.sendText("concurrent")).toThrow("send_in_progress");
    const request = JSON.parse(socket.sent[0]);
    expect(request).toMatchObject({ op: "sendText", peerId: config.peerId, text: "synthetic reply" });
    socket.receive({ t: "reply", id: request.id, ok: true, result: { accepted: true, delivery: "unconfirmed", messageIds: [] } });
    expect(await pending).toEqual([]);
    expect(socket.sent).toHaveLength(1);
    f.client.disconnect();
  });

  it("does not replay after timeout, disconnect or reconnect", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let socket = await connect(f);
    const timedOut = f.client.sendText("timeout fixture");
    await vi.advanceTimersByTimeAsync(501);
    expect(await timedOut).toEqual([]);
    expect(socket.sent).toHaveLength(1);
    const interrupted = f.client.sendText("disconnect fixture");
    socket.close();
    expect(await interrupted).toEqual([]);
    expect(f.open).toHaveBeenCalledTimes(1);
    socket = await connect(f);
    expect(socket.sent).toEqual([]);
    f.client.disconnect();
  });

  it("stops after a changed binding and rejects malformed requests locally", async () => {
    const f = fixture();
    const socket = await connect(f);
    expect(() => f.client.sendText("bad\0text")).toThrow("invalid_text");
    socket.receive({ ...hello, peerId: "wxid_other" });
    expect(() => f.client.sendText("fixture")).toThrow("not_connected");
    expect(socket.sent).toEqual([]);
  });
});

describe("Koishi adapter sessions", () => {
  it("dispatches one direct text session and enforces target/content before send", async () => {
    const ctx = new Context();
    ctx.plugin(HTTP);
    const socket = new FakeSocket();
    const open = vi.spyOn(ctx.http, "ws").mockReturnValue(socket as unknown as ReturnType<SocketFactory>);
    const bot = new WechatLocalBot(ctx, { ...config });
    const sessions: Array<ReturnType<typeof bot.session>> = [];
    ctx.on("internal/session", (session) => {
      if (session.type === "message-created") sessions.push(session);
    });
    const starting = ctx.start();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    socket.receive(hello);
    await starting;
    try {
      socket.receive({ t: "msg", m: message });
      socket.receive({ t: "msg", m: { ...message, id: "2", sender: "wxid_other" } });
      expect(sessions).toHaveLength(1);
      const session = sessions[0];
      expect(session.isDirect).toBe(true);
      expect(session.guildId).toBeUndefined();
      expect(session.messageId).toBe(message.id);
      expect(session.userId).toBe(config.peerId);
      expect(session.elements).toHaveLength(1);
      expect(session.elements![0].type).toBe("text");
      expect(session.elements![0].attrs.content).toBe(message.text);
      await expect(bot.sendMessage("wxid_other", "fixture")).rejects.toThrow("scope_denied");
      await expect(bot.sendPrivateMessage(config.peerId, "fixture", "group")).rejects.toThrow("scope_denied");
      await expect(bot.sendMessage(config.peerId, h.image("file:///fixture"))).rejects.toThrow("text_only");
      expect(socket.sent).toEqual([]);
      const pending = bot.sendPrivateMessage(config.peerId, "synthetic outbound");
      const request = JSON.parse(socket.sent[0]);
      socket.receive({ t: "reply", id: request.id, ok: true, result: { accepted: true, delivery: "unconfirmed", messageIds: [] } });
      expect(await pending).toEqual([]);
    } finally {
      await ctx.stop();
    }
  });

  it("disposes the plugin before its required services", async () => {
    const ctx = new Context();
    ctx.plugin(HTTP);
    const socket = new FakeSocket();
    const open = vi.spyOn(ctx.http, "ws").mockReturnValue(socket as unknown as ReturnType<SocketFactory>);
    const errors: unknown[] = [];
    ctx.on("internal/error", (error) => {
      errors.push(error);
    });
    ctx.plugin(plugin, { ...config });
    const starting = ctx.start();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    socket.receive(hello);
    await starting;
    await ctx.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(errors).toEqual([]);
    expect(socket.readyState).toBe(3);
  });
});
