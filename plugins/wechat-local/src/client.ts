import { randomUUID } from "node:crypto";

import type { Context } from "@satorijs/core";

import { decodeFrame, isPrivateId, isText, type Binding, type PrivateTextMessage } from "./protocol";

export type SocketFactory = (endpoint: string, token: string) => Socket;

type Socket = ReturnType<Context["http"]["ws"]>;

export interface ClientConfig {
  endpoint: string;
  token: string;
  expectedSelfId: string;
  peerId: string;
  requestTimeoutMs: number;
}

interface Pending {
  resolve: (ids: string[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PrivateTextClient {
  private socket?: Socket;
  private binding?: Binding;
  private fail?: (code: string) => void;
  private pending = new Map<string, Pending>();
  private seen = new Set<string>();

  constructor(
    readonly config: ClientConfig,
    private open: SocketFactory,
    private onMessage: (message: PrivateTextMessage, binding: Binding) => void,
    private onReady: () => void,
    private onClose: () => void,
  ) {
    const url = new URL(config.endpoint);
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new Error("loopback_endpoint_required");
    if (!/^[A-Fa-f0-9]{64}$/.test(config.token)) throw new Error("token_required");
    if (!isPrivateId(config.expectedSelfId) || !isPrivateId(config.peerId) || config.expectedSelfId === config.peerId)
      throw new Error("private_binding_required");
    if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 100 || config.requestTimeoutMs > 30000)
      throw new Error("invalid_request_timeout");
  }

  get connected() {
    return !!this.binding && this.socket?.readyState === 1;
  }

  connect(): Promise<void> {
    if (this.socket) throw new Error("already_connected");
    const socket = this.open(this.config.endpoint, this.config.token);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => fail("handshake_timeout"), this.config.requestTimeoutMs);
      const fail = (code: string) => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.binding = undefined;
        this.fail = undefined;
        clearTimeout(timeout);
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.resolve([]);
        }
        this.pending.clear();
        reject(new Error(code));
        this.onClose();
        if (socket.readyState < 2) socket.close(code === "stopped" ? 1000 : 1008, code);
      };
      this.fail = fail;
      socket.addEventListener("error", () => fail("transport_unavailable"));
      socket.addEventListener("close", () => fail("transport_closed"));
      socket.addEventListener("message", ({ data }) => {
        if (this.socket !== socket) return;
        const frame = decodeFrame(data);
        if (!frame) {
          fail("invalid_frame");
          return;
        }
        if (!this.binding) {
          if (frame.t !== "hello" || frame.selfId !== this.config.expectedSelfId || frame.peerId !== this.config.peerId) {
            fail("binding_mismatch");
            return;
          }
          this.binding = frame;
          clearTimeout(timeout);
          this.onReady();
          resolve();
          return;
        }
        if (frame.t === "hello") {
          fail("binding_changed");
          return;
        }
        if (frame.t === "reply") {
          const request = this.pending.get(frame.id);
          if (request) {
            clearTimeout(request.timer);
            this.pending.delete(frame.id);
            request.resolve([]);
          }
          return;
        }
        const message = frame.m;
        if (
          message.peerId !== this.config.peerId ||
          message.sender !== this.config.peerId ||
          message.sender === this.config.expectedSelfId ||
          message.isSelf ||
          message.ts < this.binding.boundAt ||
          this.seen.has(message.id)
        )
          return;
        this.seen.add(message.id);
        if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
        this.onMessage(message, this.binding);
      });
    });
  }

  disconnect() {
    this.fail?.("stopped");
  }

  sendText(text: string): Promise<string[]> {
    if (!isText(text)) throw new Error("invalid_text");
    if (!this.connected) throw new Error("not_connected");
    if (this.pending.size) throw new Error("send_in_progress");
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve([]);
      }, this.config.requestTimeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        this.socket!.send(JSON.stringify({ id, op: "sendText", peerId: this.config.peerId, text }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve([]);
      }
    });
  }
}
