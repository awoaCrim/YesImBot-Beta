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
  ImagePreviewCapability,
  ImagePreviewFrame,
  ImagePreviewRequest,
  ImageDescribeRequest,
  MainAgentRoleProfile,
  MainAgentRoleProvider,
  MessagePolisherCapability,
  PolisherMode,
  PolisherPromptProfile,
  PolisherRequest,
  PolisherTurnContext,
  PolisherTurnEntry,
  RolePromptProfileProvider,
  WillBatchDecision,
  WillDebug,
  WillEngine,
  WillPlugin,
  WillReservationOutcome,
  WillState,
} from "./agents/index.js";

export {
  createSendMessagePolisher,
  extractProtectedTokens,
  PolisherRegistry,
  validatePolishedMessages,
  validateComposedMessages,
  MAX_COMPOSE_MESSAGES,
  MAX_COMPOSE_BYTES,
} from "./agents/index.js";

export { withAbortSignal } from "./abort.js";

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
