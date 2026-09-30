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

const SHANGHAI_STAMP_FORMAT = createShanghaiStampFormat();

export function filterEntriesForCompression(entries: readonly AgentEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.data as AgentMessage;
    if (message.role === "tool") continue;
    const stamp = formatCompactTimestamp(compactSourceTimestamp(entry));
    if (message.role === "custom") {
      const custom = message as AgentMessage & { type?: string; data?: { user?: { id?: string; name?: string }; elements?: Element[]; text?: string } };
      if (custom.type === "yesimbot.message") {
        const text = elementsText(custom.data?.elements);
        if (text) lines.push(`[${stamp}] [${custom.data?.user?.name ?? custom.data?.user?.id ?? "user"}]: ${text}`);
      } else if (custom.type === "yesimbot.event" && custom.data?.text) lines.push(`[${stamp}] [事件]: ${custom.data.text}`);
    } else if (message.role === "assistant") {
      const text = assistantText(message.content);
      if (text) lines.push(`[${stamp}] [assistant]: ${text}`);
      for (const spoken of assistantUtterances(message.content)) lines.push(`[${stamp}] [assistant]: ${spoken}`);
    }
  }
  return lines.join("\n");
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

export async function executeCompact(input: { readonly model: LanguageModel; readonly conversation: string; readonly signal?: AbortSignal }): Promise<string> {
  const { text } = await generateText({
    model: input.model,
    system: COMPACTION_SYSTEM_PROMPT,
    prompt: `<conversation>\n${input.conversation}\n</conversation>`,
    abortSignal: input.signal,
  });
  const summary = text.trim();
  if (!summary) throw new Error("Compaction produced an empty summary.");
  return summary;
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
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
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
