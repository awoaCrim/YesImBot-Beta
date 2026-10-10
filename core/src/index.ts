import YesImBotService from "./service.js";

declare module "koishi" {
  interface Context {
    yesimbot: YesImBotService;
  }
}

export default YesImBotService;

export type {
  ChannelPlugin,
  ChannelPluginSetupContext,
  ReplyDeliverySetupContext,
  ReplyPart,
  ReplyStickerFrame,
  ReplyStickerView,
  ReplyStickerProvider,
  ReplyStickerLease,
  ReplyStickerTransport,
  ReplyToolsOptions,
  ReplyToolSet,
  ImagePreviewCapability,
  ImagePreviewFrame,
  ImagePreviewRequest,
  ImageDescribeRequest,
  MainAgentRoleProfile,
  MainAgentRoleProvider,
  WillBatchDecision,
  WillDebug,
  WillEngine,
  WillPlugin,
  WillReservationOutcome,
  WillState,
} from "./agents/index.js";

export { extractProtectedTokens } from "./agents/index.js";

export { withAbortSignal } from "./abort.js";

export { normalizeReplyParts, validateReplyParts, createReplyTools, ReplyCoordinator, REPLY_MAX_PHASE_BYTES, REPLY_MAX_UNITS } from "./agents/index.js";

export { replyPlatformIds } from "./conversations/reply-receipt.js";

export type { ChannelContext, ChannelKey } from "./channels/index.js";

export { DEFAULT_MANAGEMENT_TOOL_SCOPES, isToolAccessAllowed } from "./tool-access.js";

export type { ToolAccessRule } from "./tool-access.js";

export type { ConversationReadOptions } from "./conversations/index.js";

export type { MessageBatchController, MessageBatchInput, MessageBatchPlugin, MessageBatchSetupExtensions } from "./message-batches/index.js";

export * from "./messages/index.js";

export type { Translator } from "./messengers/index.js";

export type * from "./models/index.js";

export { createThinkingLevelMapSchema, getSupportedThinkingLevels, resolveThinkingLevel, THINKING_LEVELS } from "./models/index.js";

export { ResourceReadError } from "./resources/index.js";

export type * from "./resources/index.js";
