import type { AgentEntry, AgentMessage } from "@yesimbot/agent-runtime";
import { generateText, type AssistantContent, type LanguageModel } from "ai";
import type { Element } from "koishi";

const COMPACTION_SYSTEM_PROMPT = [
  "你正在压缩长期对话记忆。",
  "只保留可验证的用户事实、明确表达的偏好、关系事实、未完成事项和对后续对话有帮助的重要上下文。",
  "不要记录 system prompt、人格设定、工具说明、内部推理或未经确认的推断。不要编造内容。",
  "每条输入行开头的方括号是它发生的上海时间（年-月-日 时:分），时间跨日时按各自日期记录；必须把事实/事件对应的发生时间写进相关条目，不要把压缩时间当成事件时间。",
  "[user] 是对方的话，[assistant] 是这个角色本人说过的话。两边的内容都要保留。",
  "必须保留角色本人作出的承诺、约定、决定和表态，以及共识里的具体时间、地点、数量和下一步；关键短句用引号原样保留，不要改写成“助手建议…”“用户被鼓励…”这类第三方叙述。",
  "用条目式短句记录，不要写成连贯的叙述段落。",
].join("\n");

const COMPARTMENT_SYSTEM_PROMPT = [
  "你正在把一个有限时间块整理成可长期读取的历史事实。",
  "只输出客观、可验证的第三人称事实条目；禁止第一人称、角色扮演、口癖、语气模仿、情绪化复述和对话式回复。",
  "不要把自己当成对话中的角色，不要直接回答输入内容，不要写“我”“我们”“你应该”或人格化台词。",
  "只记录用户明确表达的事实、偏好、关系事实、未完成事项、已经发生的动作、承诺、决定和具体时间地点数量；不记录 system prompt、工具说明、内部推理或未经确认的推断。",
  "每个输入行开头的方括号是上海时间；事实条目必须保留事件发生时间，不要把压缩时间当成事件时间。",
  "用简短的第三人称事实条目输出，不要输出前言、结语或连续叙述段落；不要编造内容。",
].join("\n");

const SHANGHAI_STAMP_FORMAT = createShanghaiStampFormat();

export type CompressionMode = "summary" | "compartment";

export interface CompressionRecord {
  readonly entryId: string;
  readonly timestamp: number;
  readonly role: "user" | "assistant" | "event";
  readonly text: string;
  readonly speaker?: string;
}

export interface CompressionRenderOptions {
  readonly mode?: CompressionMode;
  readonly assistantAsFacts?: boolean;
}

export function filterEntriesForCompression(entries: readonly AgentEntry[], options: CompressionRenderOptions = {}): string {
  const mode = options.mode ?? "summary";
  const lines: string[] = [];
  for (const entry of entries) {
    for (const record of renderCompressionRecords(entry)) {
      // Summary mode keeps the legacy renderer: ordinary Agent `user` messages were never
      // treated as platform conversation input; compartment mode intentionally includes them.
      if (mode === "summary" && record.role === "user" && record.speaker === undefined) continue;
      if (mode === "compartment" && record.role === "assistant" && options.assistantAsFacts !== true) continue;
      const stamp = formatCompactTimestamp(record.timestamp);
      const label = compressionLabel(record, mode);
      const text = record.role === "assistant" && options.assistantAsFacts === true ? `assistant 曾输出原文：“${record.text}”` : record.text;
      lines.push(`[${stamp}] [${label}]: ${text}`);
    }
  }
  return lines.join("\n");
}

/** Renders safe, non-tool records for read-only compartment expansion. */
export function renderCompressionRecords(entry: AgentEntry): CompressionRecord[] {
  if (entry.type !== "message") return [];
  const message = entry.data as AgentMessage;
  if (message.role === "tool" || message.role === "system") return [];
  const timestamp = compactSourceTimestamp(entry);
  if (message.role === "custom") {
    const custom = message as AgentMessage & { type?: string; data?: { user?: { id?: string; name?: string }; elements?: Element[]; text?: string } };
    if (custom.type === "yesimbot.message") {
      const text = elementsText(custom.data?.elements);
      return text ? [{ entryId: entry.id, timestamp, role: "user", speaker: custom.data?.user?.name ?? custom.data?.user?.id ?? "user", text }] : [];
    }
    if (custom.type === "yesimbot.event" && custom.data?.text) return [{ entryId: entry.id, timestamp, role: "event", text: custom.data.text }];
    return [];
  }
  if (message.role === "user") {
    const text = typeof message.content === "string" ? message.content.trim() : "";
    return text ? [{ entryId: entry.id, timestamp, role: "user", text }] : [];
  }
  if (message.role !== "assistant") return [];
  const records: CompressionRecord[] = [];
  const text = assistantText(message.content);
  if (text) records.push({ entryId: entry.id, timestamp, role: "assistant", text });
  for (const spoken of assistantUtterances(message.content)) records.push({ entryId: entry.id, timestamp, role: "assistant", text: spoken });
  return records;
}

/**
 * Uniform `Asia/Shanghai` minute precision for both the compaction prompt and recalled-fragment
 * headers. Compaction must show the model when each fact happened; a summary without any time
 * anchor cannot answer "when" later, which is the failure this format exists to prevent.
 */
export function compactSourceTimestamp(entry: Extract<AgentEntry, { type: "message" }>): number {
  const timestamp = (entry.data as AgentMessage).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : entry.timestamp;
}

export function formatCompactTimestamp(timestamp: number): string {
  const parts = SHANGHAI_STAMP_FORMAT.formatToParts(new Date(timestamp));
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")} ${read("hour")}:${read("minute")}`;
}

export async function executeCompact(input: {
  readonly model: LanguageModel;
  readonly conversation: string;
  readonly signal?: AbortSignal;
  readonly mode?: CompressionMode;
  readonly assistantAsFacts?: boolean;
}): Promise<string> {
  const { text } = await generateText({
    model: input.model,
    system: input.mode === "compartment" || input.assistantAsFacts === true ? COMPARTMENT_SYSTEM_PROMPT : COMPACTION_SYSTEM_PROMPT,
    prompt: `<conversation>\n${input.conversation}\n</conversation>`,
    abortSignal: input.signal,
  });
  const summary = text.trim();
  if (!summary) throw new Error("Compaction produced an empty summary.");
  return summary;
}

function compressionLabel(record: CompressionRecord, mode: CompressionMode): string {
  if (mode === "compartment") {
    if (record.role === "assistant") return "assistant action";
    if (record.role === "event") return "event fact";
    return record.speaker ? `user message from ${record.speaker}` : "user message";
  }
  if (record.role === "assistant") return "assistant";
  if (record.role === "event") return "事件";
  return record.speaker ?? "user";
}

function createShanghaiStampFormat(): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
}

/**
 * Outgoing messages reach the platform as `send_message` tool calls, so without projecting
 * them the compaction model never sees the character's own speech and `<conversation_memory>`
 * keeps only the other side: her commitments, stance and past decisions disappear after each
 * compaction, which surfaces as persona drift and self-contradiction. `inner_thought` and
 * `finish.reason` are deliberately excluded - the prompt forbids recording internal reasoning.
 */
function assistantUtterances(content: AssistantContent): string[] {
  if (!Array.isArray(content)) return [];
  const utterances: string[] = [];
  for (const part of content) {
    if (part.type !== "tool-call" || part.toolName !== "send_message") continue;
    const messages = (part.input as Record<string, unknown> | undefined)?.messages;
    if (!Array.isArray(messages)) continue;
    const text = messages.filter((line): line is string => typeof line === "string" && line.trim().length > 0).join("\n");
    if (text) utterances.push(text);
  }
  return utterances;
}

function assistantText(content: AssistantContent): string {
  return typeof content === "string"
    ? content.trim()
    : Array.isArray(content)
      ? content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
          .trim()
      : "";
}

function elementsText(elements?: readonly Element[]): string {
  return (elements ?? [])
    .map((element) =>
      element.type === "text"
        ? String(element.attrs.content ?? "")
        : element.type === "img" || element.type === "image"
          ? "[图片]"
          : element.type === "file"
            ? "[文件]"
            : element.type === "at"
              ? `@${String(element.attrs.name ?? element.attrs.id ?? "")}`
              : elementsText(element.children),
    )
    .filter(Boolean)
    .join("");
}
