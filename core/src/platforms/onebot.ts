import type { Context, Element, Session } from "koishi";
import { h, Universal } from "koishi";

import { assembleEvent, type EventRecord, type MessageQuote, type MessageRecord, type RecordBase } from "../messages/index.js";
import type { Translator } from "../messengers/index.js";
import type { ChannelResources } from "../resources/index.js";

const KNOWN_FILE_SOURCE = /^(?:https?|data|base64|file):/i;
const DOWNLOADABLE_FILE_SOURCE = /^(?:https?|data|base64):/i;

type OneBotEventType = "notice.poke";

type OneBotFileInternal = {
  getPrivateFileUrl?: (userId: string, fileId: string, fileHash?: string) => Promise<string>;
  getGroupFileUrl?: (groupId: string, fileId: string, busid: number) => Promise<string>;
};

type OneBotSessionBot = {
  internal?: OneBotFileInternal;
  getMessage?: (channelId: string, messageId: string) => Promise<{ elements?: readonly Element[] }>;
};

declare module "../messages/index.js" {
  interface EventMap {
    "notice.poke": { actorId?: string; targetId: string; action: string };
  }
}

export class OneBotTranslator implements Translator {
  public readonly platform = "onebot";

  public constructor(private readonly ctx: Context) {}

  public async translate(session: Session, resources: ChannelResources): Promise<MessageRecord | EventRecord | null> {
    const base = recordBase(session);
    const event = translateOneBotEvent(base, session);
    if (event) return event;
    return translateOneBotMessage(this.ctx, base, session, resources);
  }
}

export function translateOneBotEvent(base: RecordBase, session: Session): EventRecord<OneBotEventType> | null {
  const { event } = session;
  if (event.type !== "notice" || event.subtype !== "poke") return null;
  const actorId = identifier(event._data.user_id);
  const targetId = identifier(event._data.target_id);
  if (!targetId) return null;
  return assembleEvent(base, {
    eventType: "notice.poke",
    ...(actorId ? { actorId } : {}),
    targetId,
    action: "拍了拍",
    text: `${event._data.user_id} 拍了拍 ${event._data.target_id}`,
  });
}

export async function translateOneBotMessage(ctx: Context, base: RecordBase, session: Session, resources: ChannelResources): Promise<MessageRecord | null> {
  if (session.type !== "message-created" || !Array.isArray(session.elements)) return null;
  if (typeof session.messageId !== "string" || session.messageId.length === 0) return null;

  const elements = await resources.persistElements(ctx, await resolveFileSources(ctx, session, session.elements));
  const quote = await persistQuote(ctx, session, resources);
  return {
    ...base,
    messageId: session.messageId,
    elements,
    ...(quote ? { quote } : {}),
  };
}

async function resolveFileSources(ctx: Context, session: Session, elements: readonly Element[]): Promise<Element[]> {
  return Promise.all(elements.map((element) => resolveFileSource(ctx, session, element)));
}

async function resolveFileSource(ctx: Context, session: Session, element: Element): Promise<Element> {
  if (element.type === "file") {
    const source = attributeText(element, "src");
    if (source && KNOWN_FILE_SOURCE.test(source)) return element;
    const resolved = await resolveOneBotFileUrl(ctx, session, element);
    return resolved ? h("file", { ...element.attrs, src: resolved }) : element;
  }
  if (element.children.length === 0) return element;
  return h(element.type, element.attrs, await Promise.all(element.children.map((child) => resolveFileSource(ctx, session, child))));
}

async function resolveOneBotFileUrl(ctx: Context, session: Session, element: Element): Promise<string | undefined> {
  const bot = (session as unknown as { bot?: OneBotSessionBot }).bot;
  const internal = bot?.internal;
  const fileId = firstAttributeText(element, ["file_id", "fileId", "file", "id"]);
  if (!fileId || KNOWN_FILE_SOURCE.test(fileId)) return undefined;

  const fileHash = firstAttributeText(element, ["file_hash", "fileHash", "hash"]);
  try {
    if (session.isDirect) {
      const userId = session.userId || session.event.user?.id || session.author?.id;
      if (userId && internal?.getPrivateFileUrl) {
        const url = await internal.getPrivateFileUrl(String(userId), fileId, fileHash);
        if (isDownloadableFileSource(url)) return url;
      }
    } else {
      const groupId = session.guildId || session.channelId;
      const busid = attributeNumber(element, ["busid", "bus_id"]);
      if (groupId && busid !== undefined && internal?.getGroupFileUrl) {
        const url = await internal.getGroupFileUrl(String(groupId), fileId, busid);
        if (isDownloadableFileSource(url)) return url;
      }
    }
  } catch {
    // Keep the original element when OneBot cannot resolve the attachment.
  }

  const recovered = await recoverFileUrlFromMessage(bot, session, fileId);
  if (recovered) return recovered;

  ctx.logger("yesimbot.resources").debug("resources.input.file-source-unresolved", {
    direct: Boolean(session.isDirect),
    hasFileId: true,
  });
  return undefined;
}

async function recoverFileUrlFromMessage(bot: OneBotSessionBot | undefined, session: Session, fileId: string): Promise<string | undefined> {
  if (!bot?.getMessage || !session.channelId || !session.messageId) return undefined;
  try {
    const message = await bot.getMessage(String(session.channelId), String(session.messageId));
    const candidates = (message.elements ?? []).filter((candidate) => candidate.type === "file");
    const matching =
      candidates.find((candidate) => firstAttributeText(candidate, ["file_id", "fileId", "file", "id"]) === fileId) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    const source = matching && attributeText(matching, "src");
    return isDownloadableFileSource(source) ? source : undefined;
  } catch {
    return undefined;
  }
}

function attributeText(element: Element, key: string): string | undefined {
  const value = element.attrs[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstAttributeText(element: Element, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = attributeText(element, key);
    if (value) return value;
  }
  return undefined;
}

function attributeNumber(element: Element, keys: readonly string[]): number | undefined {
  const value = firstAttributeText(element, keys);
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function isDownloadableFileSource(value: unknown): value is string {
  return typeof value === "string" && DOWNLOADABLE_FILE_SOURCE.test(value);
}

async function persistQuote(ctx: Context, session: Session, resources: ChannelResources): Promise<MessageQuote | undefined> {
  const source = session.quote;
  if (!source) return undefined;

  const messageId = source.id ?? source.messageId;
  if (typeof messageId !== "string" || messageId.length === 0) return undefined;

  const sourceElements = Array.isArray(source.elements) ? source.elements : typeof source.content === "string" ? h.parse(source.content) : undefined;
  if (!sourceElements) return undefined;

  const sourceUser = (source as { user?: { id?: unknown; isBot?: unknown } }).user;
  const authorId = identifier(sourceUser?.id);
  return {
    messageId,
    elements: await resources.persistElements(ctx, await resolveFileSources(ctx, session, sourceElements)),
    ...(authorId ? { author: { id: authorId, ...(typeof sourceUser?.isBot === "boolean" ? { isBot: sourceUser.isBot } : {}) } } : {}),
  };
}

function identifier(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value);
  return normalized.length > 0 ? normalized : undefined;
}

function recordBase(session: Session): RecordBase {
  return {
    platform: session.platform,
    selfId: session.selfId,
    timestamp: session.timestamp,
    channel: {
      id: session.channelId ?? "",
      type: session.event.channel?.type ?? (session.isDirect ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT),
      ...(session.event.channel?.name === undefined ? {} : { name: session.event.channel.name }),
    },
    user: {
      id: session.userId || session.event.user?.id || session.author?.id || "",
      ...((session.event.user?.name ?? session.author?.name) === undefined ? {} : { name: session.event.user?.name ?? session.author?.name }),
    },
  };
}
