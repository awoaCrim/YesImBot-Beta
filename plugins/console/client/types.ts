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
  accountId: string;
}

export interface XiaoheiheAccountView {
  accountId: string;
  connection: "online" | "connecting" | "offline" | "failed" | "disabled" | "unknown";
  config: {
    enabled: boolean | null;
    readOnly: boolean | null;
    dailyPostLimit: number | null;
    dailyInteractionLimit: number | null;
    communities: string[] | null;
    browseCommunities: string[] | null;
    candidateTopics: string[] | null;
  };
  stateStatus: "ready" | "missing" | "invalid" | "unreadable" | "unsafe" | "too_large";
  errorCode: string | null;
  paused: string | null;
  lastBrowseAt: number | null;
  watchedPosts: number | null;
  pendingVisits: number | null;
  quota: {
    day: string;
    postsUsed: number;
    interactionsUsed: number;
    postsRemaining: number | null;
    interactionsRemaining: number | null;
    pending: number;
    uncertain: number;
  } | null;
  activityStatus: "ready" | "legacy" | "partial" | "unavailable";
}

export interface XiaoheihePayload {
  generatedAt: string;
  status: "ready" | "partial" | "unavailable" | "empty";
  issues: string[];
  accounts: XiaoheiheAccountView[];
  activities: XiaoheiheActivity[];
  conversations: ConversationIndex | null;
}

export interface ConversationRequest {
  channel: string;
  session: string;
  limit?: number;
  cursor?: string;
}

export interface ConversationSessionSummary {
  filename: string;
  isActive: boolean;
  size: number;
  createdAt: string;
  lastActivityAt: number;
}

export interface ConversationChannelSummary {
  key: string;
  type: "channel" | "guild" | "direct";
  platform: string;
  channelId: string;
  guildId?: string;
  userId?: string;
  selfId?: string;
  createdAt: string;
  activeSession: string | null;
  sessions: ConversationSessionSummary[];
  totalSizeBytes: number;
  lastActivityAt: number | null;
}

export interface ConversationIndex {
  generatedAt: string;
  channels: ConversationChannelSummary[];
  totalChannels: number;
  totalSessions: number;
  totalSizeBytes: number;
}

export interface ConversationEntryView {
  id: string;
  timestamp: number;
  kind: "user" | "assistant" | "thought" | "tool-call" | "tool-result" | "compact" | "event" | "will";
  text?: string;
  sender?: string;
  messageId?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  error?: { name?: string; message?: string };
  assets?: ConversationAssetView[];
  usage?: unknown;
  finishReason?: string;
  turnId?: string;
  eventType?: string;
  decision?: string;
  willDebug?: unknown;
  groupKey?: string;
  sourceSession?: string;
}

export interface ConversationAssetView {
  id: string;
  kind: "image" | "file";
  title?: string;
  size: number;
  dataUrl?: string;
}

export interface ConversationDetail {
  channel: string;
  session: string;
  entries: ConversationEntryView[];
  hasMore: boolean;
  nextCursor?: string;
  summary: {
    messageCount: number;
    thoughtCount: number;
    toolCallCount: number;
    errorCount: number;
    sizeBytes: number;
  };
}
