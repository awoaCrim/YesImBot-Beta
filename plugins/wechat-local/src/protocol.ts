export const PROTOCOL = "yesimbot-private-text-v1";

export const MAX_TEXT_BYTES = 16384;

export type ServerFrame = ({ t: "hello"; protocol: typeof PROTOCOL } & Binding) | { t: "msg"; m: PrivateTextMessage } | { t: "reply"; id: string; ok: boolean };

export interface Binding {
  selfId: string;
  peerId: string;
  peerName: string;
  boundAt: number;
}

export interface PrivateTextMessage {
  id: string;
  sender: string;
  peerId: string;
  ts: number;
  type: "text";
  text: string;
  isSelf: boolean;
}

export function isPrivateId(value: unknown): value is string {
  return typeof value === "string" && /^wxid_[A-Za-z0-9_-]{1,123}$/.test(value);
}

export function isText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES &&
    !value.includes("\0") &&
    Buffer.from(value, "utf8").toString("utf8") === value
  );
}

export function decodeFrame(data: unknown): ServerFrame | undefined {
  let raw: string;
  if (typeof data === "string") raw = data;
  else if (data instanceof ArrayBuffer) raw = Buffer.from(data).toString("utf8");
  else if (ArrayBuffer.isView(data)) raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  else return;
  if (Buffer.byteLength(raw, "utf8") > 65536) return;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  if (!record(value)) return;
  if (
    value.t === "hello" &&
    value.protocol === PROTOCOL &&
    isPrivateId(value.selfId) &&
    isPrivateId(value.peerId) &&
    value.selfId !== value.peerId &&
    typeof value.peerName === "string" &&
    value.peerName.length > 0 &&
    value.peerName.length <= 128 &&
    typeof value.boundAt === "number" &&
    Number.isSafeInteger(value.boundAt) &&
    value.boundAt > 0
  ) {
    return { t: "hello", protocol: PROTOCOL, selfId: value.selfId, peerId: value.peerId, peerName: value.peerName, boundAt: value.boundAt };
  }
  if (value.t === "msg" && record(value.m)) {
    const m = value.m;
    if (
      typeof m.id === "string" &&
      /^[1-9][0-9]{0,19}$/.test(m.id) &&
      isPrivateId(m.sender) &&
      isPrivateId(m.peerId) &&
      typeof m.ts === "number" &&
      Number.isSafeInteger(m.ts) &&
      m.ts > 0 &&
      m.type === "text" &&
      isText(m.text) &&
      typeof m.isSelf === "boolean"
    ) {
      return { t: "msg", m: { id: m.id, sender: m.sender, peerId: m.peerId, ts: m.ts, type: "text", text: m.text, isSelf: m.isSelf } };
    }
  }
  if (value.t === "reply" && typeof value.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.id)) {
    if (value.ok === false && typeof value.error === "string" && /^[a-z_]{1,64}$/.test(value.error)) {
      return { t: "reply", id: value.id, ok: false };
    }
    if (
      value.ok === true &&
      record(value.result) &&
      value.result.accepted === true &&
      value.result.delivery === "unconfirmed" &&
      Array.isArray(value.result.messageIds) &&
      value.result.messageIds.length === 0
    )
      return { t: "reply", id: value.id, ok: true };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
