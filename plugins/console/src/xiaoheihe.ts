import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { DataService } from "@koishijs/console";
import {} from "@koishijs/loader";
import { Context, Universal } from "koishi";

import { buildConversationIndex, type ConversationIndex } from "./conversations.js";

const REFRESH_INTERVAL = 10_000;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVITIES = 300;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,80}$/;
const STATE_DIRECTORY = ["data", "yesimbot", "xiaoheihe"];
const SAFE_CODES = new Set([
  "deployment_pending_activation",
  "connection_failed",
  "browse_failed",
  "read_post_failed",
  "search_failed",
  "visit_failed",
  "send_failed",
  "resume_failed",
  "operator",
  "uncertain_delivery",
  "account_identity_mismatch",
  "activity_failed",
  "upstream_failed",
  "state_write_failed",
  "account_paused",
  "account_closed",
  "account_store_closed",
  "account_state_write_failed",
  "duplicate_action",
  "daily_limit",
  "read_only",
  "read_only_mode",
  "publication_disabled",
  "read_post_first",
  "invalid_target",
  "invalid_keyword",
  "invalid_identifier",
  "unknown_reply_target",
  "ambiguous_reply_target",
  "post_identity_mismatch",
  "visit_limit",
  "watch_limit",
  "reconnect_required",
  "inspect_uncertain_delivery_first",
  "invalid_publication_text",
  "post_requires_title_and_body",
  "invalid_post_title_or_body",
  "invalid_mcp_result",
  "invalid_post_list",
  "invalid_comment_list",
  "invalid_publication_receipt",
  "empty_publication",
  "xiaoheihe_not_connected",
  "xiaoheihe_connection_failed",
  "xiaoheihe_activity_stopped",
  "xiaoheihe_upstream_failed",
  "xiaoheihe_private_messages_unsupported",
  "xiaoheihe_text_only",
  "community_not_allowed",
  "invalid_community",
]);

export interface XiaoheiheActivity {
  id: string;
  at: number;
  kind: string;
  outcome: "ok" | "failed" | "blocked";
  postId?: string;
  title?: string;
  source?: string;
  count?: number;
  errorCode?: string;
}

export interface XiaoheiheConfigView {
  enabled: boolean | null;
  readOnly: boolean | null;
  dailyPostLimit: number | null;
  dailyInteractionLimit: number | null;
  communities: string[] | null;
  browseCommunities: string[] | null;
  candidateTopics: string[] | null;
}

export interface XiaoheiheQuota {
  day: string;
  postsUsed: number;
  interactionsUsed: number;
  postsRemaining: number | null;
  interactionsRemaining: number | null;
  pending: number;
  uncertain: number;
}

export interface XiaoheiheAccountView {
  accountId: string;
  connection: "online" | "connecting" | "offline" | "failed" | "disabled" | "unknown";
  config: XiaoheiheConfigView;
  stateStatus: "ready" | "missing" | "invalid" | "unreadable" | "unsafe" | "too_large";
  errorCode: string | null;
  paused: string | null;
  lastBrowseAt: number | null;
  watchedPosts: number | null;
  pendingVisits: number | null;
  quota: XiaoheiheQuota | null;
  activityStatus: "ready" | "legacy" | "partial" | "unavailable";
}

export interface XiaoheihePayload {
  generatedAt: string;
  status: "ready" | "partial" | "unavailable" | "empty";
  issues: string[];
  accounts: XiaoheiheAccountView[];
  activities: (XiaoheiheActivity & { accountId: string })[];
  conversations: ConversationIndex | null;
}

interface AccountSource {
  config: XiaoheiheConfigView;
  connection: XiaoheiheAccountView["connection"];
}

interface ParsedState {
  paused: string | null;
  lastBrowseAt: number;
  watchedPosts: number;
  pendingVisits: number;
  quota: XiaoheiheQuota;
  activityStatus: XiaoheiheAccountView["activityStatus"];
  activities: XiaoheiheActivity[];
}

declare module "@koishijs/console" {
  namespace Console {
    interface Services {
      yesimbotXiaoheihe: XiaoheiheProvider;
    }
  }
}

export class XiaoheiheProvider extends DataService<XiaoheihePayload> {
  public static readonly inject = ["console", "yesimbot", "loader"];

  public constructor(public readonly ctx: Context) {
    super(ctx, "yesimbotXiaoheihe", { authority: 4 });
    ctx.on("ready", () => {
      void this.refresh();
      ctx.setInterval(() => this.refresh(), REFRESH_INTERVAL);
    });
  }

  public async get(): Promise<XiaoheihePayload> {
    return buildXiaoheihePayload(this.ctx);
  }
}

class StateReadError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export async function buildXiaoheihePayload(ctx: Context): Promise<XiaoheihePayload> {
  const now = Date.now();
  const issues = new Set<string>();
  const sources = collectAccountSources(ctx, issues);
  let base: string | undefined;
  try {
    base = await realpath(ctx.baseDir);
    const root = await safeDirectory(base, STATE_DIRECTORY);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (!IDENTIFIER.test(entry.name)) {
        issues.add("invalid_account_id");
        continue;
      }
      if (!sources.has(entry.name)) sources.set(entry.name, { config: readConfig(undefined, null), connection: "unknown" });
    }
  } catch (cause) {
    if (filesystemCode(cause) !== "ENOENT") issues.add(cause instanceof StateReadError ? cause.code : "state_directory_unreadable");
  }

  const accounts: XiaoheiheAccountView[] = [];
  const activities: XiaoheihePayload["activities"] = [];
  for (const [accountId, source] of [...sources].sort(([left], [right]) => left.localeCompare(right))) {
    const account: XiaoheiheAccountView = {
      accountId,
      connection: source.connection,
      config: source.config,
      stateStatus: "unreadable",
      errorCode: null,
      paused: null,
      lastBrowseAt: null,
      watchedPosts: null,
      pendingVisits: null,
      quota: null,
      activityStatus: "unavailable",
    };
    try {
      if (!base) throw new StateReadError("state_unreadable");
      const state = parseState(await readState(base, accountId), accountId, source.config, now);
      const { activities: recent, ...summary } = state;
      Object.assign(account, summary, { stateStatus: "ready" });
      activities.push(...recent.map((activity) => ({ ...activity, accountId })));
      if (state.activityStatus === "partial") account.errorCode = "invalid_activity";
    } catch (cause) {
      const code = cause instanceof StateReadError ? cause.code : filesystemCode(cause) === "ENOENT" ? "state_missing" : "state_unreadable";
      account.errorCode = code;
      account.stateStatus =
        code === "state_missing"
          ? "missing"
          : code === "invalid_state"
            ? "invalid"
            : code === "unsafe_state_path"
              ? "unsafe"
              : code === "state_too_large"
                ? "too_large"
                : "unreadable";
    }
    accounts.push(account);
  }

  let conversations: ConversationIndex | null = null;
  try {
    conversations = await buildConversationIndex(ctx, (manifest) => {
      if (manifest.platform !== "xiaoheihe" || !manifest.selfId || !sources.has(manifest.selfId)) return false;
      if (manifest.channelId === `account:${manifest.selfId}`) return true;
      const prefix = `post:${manifest.selfId}:`;
      return Boolean(manifest.channelId?.startsWith(prefix) && IDENTIFIER.test(manifest.channelId.slice(prefix.length)));
    });
  } catch {
    issues.add("conversation_index_unavailable");
  }

  const readable = accounts.filter((account) => account.stateStatus === "ready").length;
  return {
    generatedAt: new Date(now).toISOString(),
    status:
      issues.size || readable < accounts.length || accounts.some((account) => account.activityStatus === "partial")
        ? readable
          ? "partial"
          : "unavailable"
        : accounts.length
          ? "ready"
          : "empty",
    issues: [...issues],
    accounts,
    activities: activities.sort((left, right) => right.at - left.at).slice(0, MAX_ACTIVITIES),
    conversations,
  };
}

function collectAccountSources(ctx: Context, issues: Set<string>): Map<string, AccountSource> {
  const sources = new Map<string, AccountSource>();
  const visit = (plugins: Record<string, unknown>, disabled = false) => {
    for (const [key, value] of Object.entries(plugins)) {
      const bare = key.replace(/^~/, "");
      const enabled = !disabled && !key.startsWith("~");
      const config = objectValue(value);
      if (bare.startsWith("group:")) {
        if (config) visit(config, !enabled);
        continue;
      }
      if (!["yesimbot-xiaoheihe", "adapter-xiaoheihe"].includes(bare.split(":")[0] ?? "")) continue;
      const accountId = config?.selfId;
      if (typeof accountId !== "string" || !IDENTIFIER.test(accountId)) {
        issues.add("invalid_account_id");
        continue;
      }
      if (sources.has(accountId)) issues.add("duplicate_account_config");
      sources.set(accountId, { config: readConfig(config, enabled), connection: enabled ? "offline" : "disabled" });
    }
  };
  visit(ctx.loader.config.plugins ?? {});
  for (const bot of ctx.bots) {
    if (bot.platform !== "xiaoheihe") continue;
    if (!IDENTIFIER.test(bot.selfId)) {
      issues.add("invalid_account_id");
      continue;
    }
    const connection = bot.error
      ? "failed"
      : bot.status === Universal.Status.ONLINE
        ? "online"
        : bot.status === Universal.Status.CONNECT || bot.status === Universal.Status.RECONNECT
          ? "connecting"
          : "offline";
    sources.set(bot.selfId, { config: readConfig(objectValue(bot.config), true), connection });
  }
  return sources;
}

function readConfig(value: Record<string, unknown> | undefined, enabled: boolean | null): XiaoheiheConfigView {
  const dailyPostLimit = limitValue(value?.dailyPostLimit);
  const dailyInteractionLimit = limitValue(value?.dailyInteractionLimit);
  return {
    enabled,
    readOnly:
      value?.readOnly === true || (dailyPostLimit === 0 && dailyInteractionLimit === 0)
        ? true
        : typeof value?.readOnly === "boolean"
          ? value.readOnly
          : dailyPostLimit !== null && dailyInteractionLimit !== null
            ? false
            : null,
    dailyPostLimit,
    dailyInteractionLimit,
    communities: stringList(value?.communities),
    browseCommunities: stringList(value?.browseCommunities),
    candidateTopics: stringList(value?.browseTopics),
  };
}

async function safeDirectory(base: string, segments: readonly string[]): Promise<string> {
  let directory = base;
  for (const segment of segments) {
    directory = join(directory, segment);
    const info = await lstat(directory);
    if (info.isSymbolicLink() || (await realpath(directory)) !== directory) throw new StateReadError("unsafe_state_path");
    if (!info.isDirectory()) throw new StateReadError("state_unreadable");
  }
  return directory;
}

async function readState(base: string, accountId: string): Promise<unknown> {
  if (!IDENTIFIER.test(accountId)) throw new StateReadError("invalid_state");
  const segments = [...STATE_DIRECTORY, accountId];
  const directory = await safeDirectory(base, segments);
  const path = join(directory, "state.json");
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new StateReadError("unsafe_state_path");
  if (!info.isFile()) throw new StateReadError("invalid_state");
  if (info.size > MAX_STATE_BYTES) throw new StateReadError("state_too_large");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new StateReadError("unsafe_state_path");
    await safeDirectory(base, segments);
    if ((await realpath(path)) !== path) throw new StateReadError("unsafe_state_path");
    if (opened.size > MAX_STATE_BYTES) throw new StateReadError("state_too_large");
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_STATE_BYTES) throw new StateReadError("state_too_large");
    try {
      return JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown;
    } catch {
      throw new StateReadError("invalid_state");
    }
  } finally {
    await file.close();
  }
}

function parseState(raw: unknown, accountId: string, config: XiaoheiheConfigView, now: number): ParsedState {
  const value = objectValue(raw);
  if (
    !value ||
    value.version !== 1 ||
    value.accountId !== accountId ||
    (value.paused !== null && typeof value.paused !== "string") ||
    !timestamp(value.lastBrowseAt) ||
    !Array.isArray(value.actions) ||
    !objectValue(value.watched) ||
    !Array.isArray(value.pendingVisits) ||
    !value.pendingVisits.every((id) => typeof id === "string" && IDENTIFIER.test(id))
  )
    throw new StateReadError("invalid_state");

  const day = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let postsUsed = 0;
  let interactionsUsed = 0;
  let pending = 0;
  let uncertain = 0;
  for (const rawAction of value.actions) {
    const action = objectValue(rawAction);
    if (
      !action ||
      typeof action.key !== "string" ||
      typeof action.target !== "string" ||
      !timestamp(action.at) ||
      typeof action.day !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(action.day) ||
      (action.kind !== "post" && action.kind !== "interaction") ||
      (action.status !== "sent" && action.status !== "pending" && action.status !== "uncertain")
    )
      throw new StateReadError("invalid_state");
    if (action.status === "pending") pending += 1;
    if (action.status === "uncertain") uncertain += 1;
    if (action.day !== day) continue;
    if (action.kind === "post") postsUsed += 1;
    else interactionsUsed += 1;
  }
  for (const [key, rawWatch] of Object.entries(value.watched as Record<string, unknown>)) {
    const watch = objectValue(rawWatch);
    if (
      !key.startsWith("post:") ||
      !IDENTIFIER.test(key.slice(5)) ||
      !watch ||
      !Array.isArray(watch.seen) ||
      !Array.isArray(watch.ownCommentIds) ||
      !watch.seen.every((id) => typeof id === "string" && IDENTIFIER.test(id)) ||
      !watch.ownCommentIds.every((id) => typeof id === "string" && IDENTIFIER.test(id)) ||
      typeof watch.ownPost !== "boolean" ||
      !timestamp(watch.touchedAt)
    )
      throw new StateReadError("invalid_state");
  }

  let activityStatus: ParsedState["activityStatus"] = value.activities === undefined ? "legacy" : "ready";
  const activities: XiaoheiheActivity[] = [];
  if (value.activities !== undefined && !Array.isArray(value.activities)) activityStatus = "partial";
  if (Array.isArray(value.activities)) {
    for (const rawActivity of value.activities) {
      const activity = parseActivity(rawActivity);
      if (activity) activities.push(activity);
      else activityStatus = "partial";
    }
  }
  return {
    paused: value.paused === null ? null : safeCode(value.paused),
    lastBrowseAt: value.lastBrowseAt as number,
    watchedPosts: Object.keys(value.watched as Record<string, unknown>).length,
    pendingVisits: value.pendingVisits.length,
    quota: {
      day,
      postsUsed,
      interactionsUsed,
      postsRemaining: config.dailyPostLimit === null ? null : Math.max(0, config.dailyPostLimit - postsUsed),
      interactionsRemaining: config.dailyInteractionLimit === null ? null : Math.max(0, config.dailyInteractionLimit - interactionsUsed),
      pending,
      uncertain,
    },
    activityStatus,
    activities: activities.sort((left, right) => right.at - left.at).slice(0, MAX_ACTIVITIES),
  };
}

function parseActivity(raw: unknown): XiaoheiheActivity | undefined {
  const value = objectValue(raw);
  if (
    !value ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 160 ||
    !timestamp(value.at) ||
    typeof value.kind !== "string" ||
    !value.kind ||
    value.kind.length > 80 ||
    (value.outcome !== "ok" && value.outcome !== "failed" && value.outcome !== "blocked") ||
    (value.postId !== undefined && (typeof value.postId !== "string" || !IDENTIFIER.test(value.postId))) ||
    (value.title !== undefined && typeof value.title !== "string") ||
    (value.source !== undefined && typeof value.source !== "string") ||
    (value.count !== undefined && (typeof value.count !== "number" || !Number.isSafeInteger(value.count) || value.count < 0)) ||
    (value.errorCode !== undefined && typeof value.errorCode !== "string")
  )
    return undefined;
  return {
    id: value.id,
    at: value.at as number,
    kind: value.kind,
    outcome: value.outcome,
    postId: value.postId as string | undefined,
    title: typeof value.title === "string" ? value.title.slice(0, 500) : undefined,
    source: typeof value.source === "string" ? value.source.slice(0, 200) : undefined,
    count: value.count as number | undefined,
    errorCode: typeof value.errorCode === "string" ? safeCode(value.errorCode) : undefined,
  };
}

function filesystemCode(cause: unknown): unknown {
  return objectValue(cause)?.code;
}

function safeCode(value: string): string {
  return SAFE_CODES.has(value) ? value : "unknown_error";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function timestamp(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function limitValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1000 ? value : null;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length <= 200) ? value.slice(0, 100) : null;
}
