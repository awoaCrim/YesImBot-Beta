import { join, resolve } from "node:path";

import type { EmbeddingModelV3, LanguageModelV3 } from "@ai-sdk/provider";
import { wrapEmbeddingModel, wrapLanguageModel } from "ai";
import type { EmbeddingModel, EmbeddingModelMiddleware, LanguageModel, LanguageModelMiddleware, ToolSet } from "ai";
import { Context, Logger, Schema } from "koishi";

import type { ChannelContext } from "../channels/index.js";
import type { ChatModelConfig, EmbeddingModelConfig, ModelServiceConfig } from "./config.js";
import { createEmptyModelsConfig, loadModelsConfig } from "./config.js";

export type ModelId = `${string}:${string}`;

export type ModelUsageEvent =
  | {
      readonly context?: ChannelContext;
      readonly modelId: ModelId;
      readonly providerId: string;
      readonly providerModelId: string;
      readonly kind: "chat";
      readonly usage: unknown;
      readonly timestamp: number;
    }
  | {
      readonly context?: ChannelContext;
      readonly modelId: ModelId;
      readonly providerId: string;
      readonly providerModelId: string;
      readonly kind: "embedding";
      readonly usage: { readonly inputTokens: number; readonly outputTokens: 0 };
      readonly timestamp: number;
    };

export type AuxiliaryPurpose = "memory-summary" | "notification" | "utility";

export type AuxiliaryModelErrorCode = "missing-config" | "invalid-config" | "unresolvable-model" | "provider-unavailable" | "request-failed";

export type ImageToolResultSupport = "native" | "unsupported" | "unknown";

export type HistoryProjectionMode = "default" | "gemini-native";

export interface ChatModelCapabilities {
  readonly imageToolResult: ImageToolResultSupport;
  readonly historyProjection?: HistoryProjectionMode;
}

export interface ChatModelRef {
  fullId: ModelId;
  providerId: string;
  modelId: string;
  entry: ChatModelConfig;
  model: LanguageModel;
  capabilities: ChatModelCapabilities;
  tools?: ToolSet;
}

export interface AuxiliaryModelRef extends ChatModelRef {
  readonly route: "auxiliary";
  readonly purpose: AuxiliaryPurpose;
  readonly source: "config.auxiliaryModel";
}

interface Provider {
  readonly id: string;
  readonly capabilities: { chat: boolean; embedding: boolean };
  chatModels(): ChatModelConfig[];
  embeddingModels(): EmbeddingModelConfig[];
  chat?(modelId: string, config?: ChatModelConfig): LanguageModel;
  embedding?(modelId: string): EmbeddingModel;
  chatCapabilities?(modelId: string): Partial<ChatModelCapabilities> | undefined;
  tools?(modelId: string): ToolSet;
}

interface ChatModelRecord {
  fullId: ModelId;
  providerId: string;
  modelId: string;
  config: ChatModelConfig;
}

interface EmbeddingModelRecord {
  fullId: ModelId;
  providerId: string;
  modelId: string;
  config: EmbeddingModelConfig;
}

declare module "koishi" {
  interface Events {
    "yesimbot/model-usage"(event: ModelUsageEvent): void;
    "yesimbot/model-registry-changed"(revision: number): void;
  }
}

export class AuxiliaryModelError extends Error {
  public readonly route = "auxiliary" as const;

  public constructor(
    public readonly code: AuxiliaryModelErrorCode,
    public readonly purpose: AuxiliaryPurpose,
    public readonly source: "config.auxiliaryModel",
    public readonly modelId?: string,
  ) {
    super(`Auxiliary model unavailable (${code}) for ${purpose}.`);
    this.name = "AuxiliaryModelError";
  }
}

export class ModelService {
  private readonly ctx: Context;
  private readonly config: ModelServiceConfig;

  private providers = new Map<string, Provider>();
  private chatModels = new Map<string, ChatModelRecord>();
  private embeddingModels = new Map<string, EmbeddingModelRecord>();
  private aliases = new Map<string, ModelId>();
  private modelsConfig = createEmptyModelsConfig();
  private defaults: { chat?: ModelId; embedding?: ModelId } = {};
  private readonly logger: Logger;
  private readonly middlewares = new Set<LanguageModelMiddleware>();
  private revisionValue = 0;

  constructor(ctx: Context, config: ModelServiceConfig) {
    this.ctx = ctx;
    this.config = config;
    this.logger = ctx.logger("yesimbot.model");
    this.logger.level = config.logLevel ?? 2;

    this.ctx.on("ready", this.start.bind(this));
    this.ctx.on("dispose", this.stop.bind(this));
  }

  public get revision(): number {
    return this.revisionValue;
  }

  public register(provider: Provider): () => void {
    const existing = this.providers.get(provider.id);
    if (existing && existing !== provider) {
      throw new Error(`Provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
    this.refreshModels();
    this.logger.info(`Provider registered: ${provider.id}`);

    return () => {
      if (this.providers.get(provider.id) !== provider) {
        return;
      }
      this.providers.delete(provider.id);
      this.refreshModels();
      this.logger.info(`Provider unregistered: ${provider.id}`);
    };
  }

  public middleware(middleware: LanguageModelMiddleware): () => void {
    this.middlewares.add(middleware);
    this.bumpRevision();
    return () => {
      if (this.middlewares.delete(middleware)) this.bumpRevision();
    };
  }

  public resolveChatModel(fullId: string, context?: ChannelContext, options?: Readonly<Pick<ChatModelConfig, "thinkingLevel">>): ChatModelRef {
    const record = this.getChatRecord(fullId);
    const provider = this.providers.get(record.providerId);
    if (!provider) {
      throw new Error(`Provider "${record.providerId}" not found`);
    }

    this.logger.debug("model.resolve_chat", {
      input: fullId,
      fullId: record.fullId,
      provider: record.providerId,
      model: record.modelId,
      modalities: record.config.modalities,
    });
    const entry = cloneChatModelConfig(record.config);
    if (options?.thinkingLevel !== undefined) entry.thinkingLevel = options.thinkingLevel;
    // A per-resolution override must not mutate the registry or another use of the same model.
    const source = provider.chat!(record.modelId, cloneChatModelConfig(entry));
    const model = isModelObject(source)
      ? [...this.middlewares].reduce(
          (current, middleware) => wrapLanguageModel({ model: current, middleware, providerId: record.providerId, modelId: record.modelId }),
          wrapLanguageModel({
            model: source as LanguageModelV3,
            middleware: createLanguageUsageMiddleware((usage) => {
              this.ctx.emit("yesimbot/model-usage", {
                context,
                modelId: record.fullId,
                providerId: record.providerId,
                providerModelId: record.modelId,
                kind: "chat",
                usage,
                timestamp: Date.now(),
              });
            }),
            providerId: record.providerId,
            modelId: record.modelId,
          }),
        )
      : source;
    const tools = provider.tools?.(record.modelId);
    const declaredCapabilities = provider.chatCapabilities?.(record.modelId);
    const capabilities: ChatModelCapabilities = {
      imageToolResult:
        declaredCapabilities?.imageToolResult === "native" || declaredCapabilities?.imageToolResult === "unsupported"
          ? declaredCapabilities.imageToolResult
          : "unknown",
      historyProjection: declaredCapabilities?.historyProjection === "gemini-native" ? "gemini-native" : "default",
    };
    return {
      fullId: record.fullId,
      providerId: record.providerId,
      modelId: record.modelId,
      entry,
      model,
      capabilities,
      tools: tools && { ...tools },
    };
  }

  /** Limits for the actual registry-wrapped model, including a plugin-selected quota route. */
  public contextLimit(model: LanguageModel): ChatModelConfig["limit"] {
    const id = typeof model === "string" ? model : formatModelId(model.provider, model.modelId);
    const limit = this.chatModels.get(id)?.config.limit;
    return limit ? { ...limit } : undefined;
  }

  public resolveAuxiliaryModel(purpose: AuxiliaryPurpose, context?: ChannelContext): AuxiliaryModelRef {
    const source = "config.auxiliaryModel" as const;
    const configured = this.config.auxiliaryModel;
    if (typeof configured !== "string" || configured.trim().length === 0) {
      const error = new AuxiliaryModelError("missing-config", purpose, source);
      this.logAuxiliaryFailure(error);
      throw error;
    }

    const fullId = configured.trim();
    const parsed = parseModelId(fullId);
    if (!parsed || parsed.model.trim().length === 0) {
      const error = new AuxiliaryModelError("invalid-config", purpose, source, fullId);
      this.logAuxiliaryFailure(error);
      throw error;
    }

    if (!this.providers.has(parsed.provider)) {
      const error = new AuxiliaryModelError("provider-unavailable", purpose, source, fullId);
      this.logAuxiliaryFailure(error);
      throw error;
    }

    let resolved: ChatModelRef;
    try {
      resolved = this.resolveChatModel(fullId, context);
    } catch {
      const error = new AuxiliaryModelError("unresolvable-model", purpose, source, fullId);
      this.logAuxiliaryFailure(error);
      throw error;
    }

    this.logger.debug("model.resolve_auxiliary", {
      route: "auxiliary",
      purpose,
      source,
      fullId: resolved.fullId,
      provider: resolved.providerId,
      model: resolved.modelId,
    });
    return { ...resolved, route: "auxiliary", purpose, source };
  }

  public resolveEmbedding(fullId: string, context?: ChannelContext): EmbeddingModel {
    const record = this.getEmbeddingRecord(fullId);
    const provider = this.providers.get(record.providerId);
    if (!provider) throw new Error(`Provider "${record.providerId}" not found`);
    this.logger.debug("model.resolve_embedding", { input: fullId, fullId: record.fullId, provider: record.providerId, model: record.modelId });
    const source = provider.embedding!(record.modelId);
    return isModelObject(source)
      ? wrapEmbeddingModel({
          model: source as EmbeddingModelV3,
          middleware: createEmbeddingUsageMiddleware((usage) => {
            this.ctx.emit("yesimbot/model-usage", {
              context,
              modelId: record.fullId,
              providerId: record.providerId,
              providerModelId: record.modelId,
              kind: "embedding",
              usage,
              timestamp: Date.now(),
            });
          }),
          providerId: record.providerId,
          modelId: record.modelId,
        })
      : source;
  }

  public getProvider(id: string) {
    return this.providers.get(id);
  }

  public listProviders() {
    return [...this.providers.keys()];
  }

  public getDefaultChatModelId(): ModelId | undefined {
    return this.defaults.chat;
  }

  public getDefaultEmbeddingModelId(): ModelId | undefined {
    return this.defaults.embedding;
  }

  public listChatModels(): Array<{ fullId: string; config: ChatModelConfig }> {
    return [...this.chatModels.values()].map((record) => ({ fullId: record.fullId, config: cloneChatModelConfig(record.config) }));
  }

  public listEmbeddingModels(): Array<{ fullId: string; config: EmbeddingModelConfig }> {
    return [...this.embeddingModels.values()].map((record) => ({ fullId: record.fullId, config: cloneEmbeddingModelConfig(record.config) }));
  }

  private logAuxiliaryFailure(error: AuxiliaryModelError): void {
    this.logger.warn("model.auxiliary_unavailable", {
      route: error.route,
      purpose: error.purpose,
      source: error.source,
      code: error.code,
      model: error.modelId,
    });
  }

  private getModelsConfigPath(): string {
    return join(resolve(this.ctx.baseDir, this.config.basePath || this.ctx.baseDir), "models.json");
  }

  private async start(): Promise<void> {
    const { config: modelsConfig, warnings } = await loadModelsConfig(this.getModelsConfigPath());
    this.modelsConfig = modelsConfig;
    for (const warning of warnings) {
      this.logger.warn(warning);
    }
    this.refreshModels();
  }

  private async stop(): Promise<void> {}

  private refreshSchemas(): void {
    const options: Schema<string>[] = [];
    for (const model of this.chatModels.values()) {
      if (model.config.hidden) {
        continue;
      }
      const fullId = model.fullId;
      options.push(Schema.const(fullId).description(fullId) as Schema<string>);
    }
    options.push(Schema.string().description("Custom model (provider:model)"));
    this.ctx.schema.set("registry.chatModels", Schema.union(options).default(""));

    const embeddingOptions: Schema<string>[] = [];
    for (const model of this.embeddingModels.values()) {
      if (model.config.hidden) {
        continue;
      }
      const fullId = model.fullId;
      embeddingOptions.push(Schema.const(fullId).description(fullId) as Schema<string>);
    }
    embeddingOptions.push(Schema.string().description("Custom model (provider:model)"));
    this.ctx.schema.set("registry.embeddingModels", Schema.union(embeddingOptions).default(""));
  }

  private bumpRevision(): void {
    this.revisionValue += 1;
    this.ctx.emit("yesimbot/model-registry-changed", this.revisionValue);
  }

  private refreshModels(): void {
    this.bumpRevision();
    this.chatModels.clear();
    this.embeddingModels.clear();
    this.aliases.clear();
    this.defaults = {};

    for (const provider of this.providers.values()) {
      if (provider.capabilities.chat) {
        for (const config of provider.chatModels()) {
          const fullId = formatModelId(provider.id, config.id);
          const cloned = cloneChatModelConfig(config);
          // Strip provider modalities: only models.json overrides own this field.
          cloned.modalities = undefined;
          this.chatModels.set(fullId, { fullId, providerId: provider.id, modelId: config.id, config: cloned });
        }
      }

      if (provider.capabilities.embedding) {
        for (const config of provider.embeddingModels()) {
          const fullId = formatModelId(provider.id, config.id);
          this.embeddingModels.set(fullId, { fullId, providerId: provider.id, modelId: config.id, config: cloneEmbeddingModelConfig(config) });
        }
      }
    }

    const modelsConfig = this.modelsConfig;

    for (const [fullId, override] of Object.entries(modelsConfig.chat)) {
      const record = this.chatModels.get(fullId);
      if (!record) {
        this.logger.warn(`Ignoring models.json chat override for unknown model "${fullId}".`);
        continue;
      }
      record.config = {
        ...record.config,
        name: override.name ?? record.config.name,
        toolCall: override.toolCall ?? record.config.toolCall,
        reasoning: override.reasoning ?? record.config.reasoning,
        thinkingLevel: override.thinkingLevel ?? record.config.thinkingLevel,
        thinkingLevelMap: override.thinkingLevelMap
          ? { ...(record.config.thinkingLevelMap ?? {}), ...override.thinkingLevelMap }
          : record.config.thinkingLevelMap,
        hidden: override.hidden ?? record.config.hidden,
        modalities: override.modalities
          ? {
              ...(override.modalities.input ? { input: [...override.modalities.input] } : {}),
              ...(override.modalities.output ? { output: [...override.modalities.output] } : {}),
            }
          : record.config.modalities,
        limit: override.limit ?? record.config.limit,
      };
    }

    for (const [fullId, override] of Object.entries(modelsConfig.embedding)) {
      const record = this.embeddingModels.get(fullId);
      if (!record) {
        this.logger.warn(`Ignoring models.json embedding override for unknown model "${fullId}".`);
        continue;
      }
      record.config = { ...record.config, name: override.name ?? record.config.name, hidden: override.hidden ?? record.config.hidden };
    }

    for (const [alias, target] of Object.entries(modelsConfig.aliases)) {
      if (this.chatModels.has(alias) || this.embeddingModels.has(alias)) {
        this.logger.warn(`Ignoring models.json alias "${alias}" because it conflicts with a full model id.`);
        continue;
      }
      const parsedTarget = parseModelId(target);
      if (!parsedTarget) {
        this.logger.warn(`Ignoring models.json alias "${alias}" because target "${target}" is not a valid model id.`);
        continue;
      }
      const targetId = formatModelId(parsedTarget.provider, parsedTarget.model);
      if (!this.chatModels.has(targetId) && !this.embeddingModels.has(targetId)) {
        this.logger.warn(`Ignoring models.json alias "${alias}" because target "${target}" is not registered.`);
        continue;
      }
      this.aliases.set(alias, targetId);
    }

    if (modelsConfig.defaults.chat) {
      if (this.chatModels.has(modelsConfig.defaults.chat)) {
        this.defaults.chat = modelsConfig.defaults.chat as ModelId;
      } else {
        this.logger.warn(`Ignoring models.json chat default "${modelsConfig.defaults.chat}" because it is not a registered chat model.`);
      }
    }

    if (modelsConfig.defaults.embedding) {
      if (this.embeddingModels.has(modelsConfig.defaults.embedding)) {
        this.defaults.embedding = modelsConfig.defaults.embedding as ModelId;
      } else {
        this.logger.warn(`Ignoring models.json embedding default "${modelsConfig.defaults.embedding}" because it is not a registered embedding model.`);
      }
    }

    this.refreshSchemas();
  }

  private resolveInput(input: string): string {
    return this.aliases.get(input) ?? input;
  }

  private getChatRecord(fullId: string): ChatModelRecord {
    fullId = this.resolveInput(fullId);
    const parsed = parseModelId(fullId);
    if (!parsed) throw new Error(`Invalid model ID format: ${fullId}`);

    const provider = this.providers.get(parsed.provider);
    if (!provider) {
      throw new Error(`Provider "${parsed.provider}" not found. Available: [${this.listProviders().join(", ")}]`);
    }

    if (!provider.capabilities.chat) {
      throw new Error(`Provider "${parsed.provider}" does not support chat`);
    }

    const record = this.chatModels.get(fullId);
    if (record) return record;

    const available = [...this.chatModels.values()]
      .filter((item) => item.providerId === parsed.provider)
      .map((item) => item.modelId)
      .join(", ");
    throw new Error(`Model "${parsed.model}" not found in provider "${parsed.provider}". Available: [${available}]`);
  }

  private getEmbeddingRecord(fullId: string): EmbeddingModelRecord {
    fullId = this.resolveInput(fullId);
    const parsed = parseModelId(fullId);
    if (!parsed) throw new Error(`Invalid model ID format: ${fullId}`);

    const provider = this.providers.get(parsed.provider);
    if (!provider) throw new Error(`Provider "${parsed.provider}" not found`);

    if (!provider.capabilities.embedding) {
      throw new Error(`Provider "${parsed.provider}" does not support embedding`);
    }

    const record = this.embeddingModels.get(fullId);
    if (record) return record;

    const available = [...this.embeddingModels.values()]
      .filter((item) => item.providerId === parsed.provider)
      .map((item) => item.modelId)
      .join(", ");
    throw new Error(`Model "${parsed.model}" not found in provider "${parsed.provider}". Available: [${available}]`);
  }
}

function parseModelId(fullId: string): { provider: string; model: string } | null {
  const idx = fullId.indexOf(":");
  return idx <= 0 ? null : { provider: fullId.slice(0, idx), model: fullId.slice(idx + 1) };
}

function formatModelId(providerId: string, modelId: string): ModelId {
  return `${providerId}:${modelId}`;
}

function createLanguageUsageMiddleware(report: (usage: unknown) => void): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      report(result.usage);
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              if (chunk.type === "finish") report(chunk.usage);
              controller.enqueue(chunk);
            },
          }),
        ),
      };
    },
  };
}

function createEmbeddingUsageMiddleware(report: (usage: { inputTokens: number; outputTokens: 0 }) => void): EmbeddingModelMiddleware {
  return {
    specificationVersion: "v3",
    wrapEmbed: async ({ doEmbed }) => {
      const result = await doEmbed();
      const rawUsage: unknown = result;
      const usage = rawUsage && typeof rawUsage === "object" && "usage" in rawUsage ? rawUsage.usage : undefined;
      const tokens = usage && typeof usage === "object" && "tokens" in usage ? usage.tokens : undefined;
      report({ inputTokens: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0, outputTokens: 0 });
      return result;
    },
  };
}

function isModelObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cloneChatModelConfig(config: ChatModelConfig): ChatModelConfig {
  return {
    ...config,
    thinkingLevelMap: config.thinkingLevelMap ? { ...config.thinkingLevelMap } : undefined,
    limit: config.limit ? { ...config.limit } : undefined,
    modalities: config.modalities
      ? {
          ...(config.modalities.input ? { input: [...config.modalities.input] } : {}),
          ...(config.modalities.output ? { output: [...config.modalities.output] } : {}),
        }
      : undefined,
  };
}

function cloneEmbeddingModelConfig(config: EmbeddingModelConfig): EmbeddingModelConfig {
  return { ...config };
}

export type { BaseProviderConfig, CHAT_MODEL_MODALITIES, ChatModelConfig, ChatModelModality, EmbeddingModelConfig, ModelServiceConfig } from "./config.js";

export { createEmptyModelsConfig, isChatModelModality, loadModelsConfig, mutateModelsConfig } from "./config.js";

export type { ResolvedThinkingLevel, ThinkingLevel, ThinkingLevelMap, ThinkingLevelSupport } from "./thinking.js";

export { createThinkingLevelMapSchema, getSupportedThinkingLevels, resolveThinkingLevel, THINKING_LEVELS } from "./thinking.js";
