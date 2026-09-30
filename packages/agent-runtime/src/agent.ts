import {
  APICallError,
  isLoopFinished,
  stepCountIs,
  streamText,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
  type LanguageModelUsage,
  type ModelMessage,
  type StopCondition,
  type SystemModelMessage,
  type ToolSet,
} from "ai";

import { AgentChannel, createAgentChannel } from "./channel.js";
import type { AgentEntry } from "./entry.js";
import { createEventEntry, createMessageEntry } from "./entry.js";
import { formatErrorCause, ToolConflictError, AgentProtocolError, type AgentProtocolViolation } from "./errors.js";
import type { AgentInternalEvent, AgentInternalEventInit } from "./event.js";
import { createDiagnostic, createInternalEvent } from "./event.js";
import { sanitizeAgentEntriesForPersistence } from "./media.js";
import type { AgentMessage } from "./message.js";
import { buildModelMessages, createAssistantMessage, createToolMessage } from "./message.js";
import type { AgentPlugin, AgentPluginRuntime, SystemPromptAppend, ToolHookContext } from "./plugin.js";
import { createPluginHost, normalizeSystemPromptAppend } from "./plugin.js";
import type { AgentState } from "./state.js";
import { AgentStateManager, createStateManager } from "./state.js";
import type { AgentStorage } from "./storage.js";
import { createMemoryStorage } from "./storage.js";
import type { AgentToolExecuteContext } from "./tools.js";
import { AgentTool, AgentToolSet, toAiToolSet } from "./tools.js";
import { createTurnQueue, TurnResult, type AgentHistoryMode, type AgentWaitOptions, type TurnRequest } from "./turn.js";

const DEFAULT_MAX_STEPS = 20;
const MAX_MODEL_RETRIES = 5;

const RETRYABLE_429_ONLY_MIDDLEWARE: LanguageModelMiddleware = {
  specificationVersion: "v3",
  async wrapGenerate({ doGenerate }) {
    try {
      return await doGenerate();
    } catch (cause) {
      throw markNon429AsNonRetryable(cause);
    }
  },
  async wrapStream({ doStream }) {
    try {
      return await doStream();
    } catch (cause) {
      throw markNon429AsNonRetryable(cause);
    }
  },
};

export type AgentModelRequestGuard = (context: AgentModelRequestContext) => Promise<readonly ModelMessage[] | void>;

export interface AgentSendOptions {
  ifBusy?: "defer" | "join" | "reject";
  /** Event-triggered turns must not reuse an earlier conversation request as current work. */
  historyMode?: AgentHistoryMode;
}

export interface AgentModelRequestContext {
  readonly model: LanguageModel;
  readonly system: string | SystemModelMessage | readonly SystemModelMessage[] | undefined;
  readonly messages: readonly ModelMessage[];
  readonly tools: ToolSet;
  readonly toolChoice?: "required";
  readonly currentMessageIds: readonly string[];
  readonly turnId: string;
  readonly stepNumber: number;
  readonly signal: AbortSignal;
  readonly rebuildMessages: () => Promise<readonly ModelMessage[]>;
}

export interface AgentConfig {
  id?: string;
  model: LanguageModel;
  systemPrompt?: SystemPromptAppend | ((runtime: AgentPluginRuntime) => Promise<SystemPromptAppend | void> | SystemPromptAppend | void);
  tools?: AgentToolSet;
  providerTools?: ToolSet;
  storage?: AgentStorage<AgentEntry>;
  plugins?: AgentPlugin[];
  maxSteps?: number;
  maxRetries?: number;
  /**
   * Provider request hint forwarded to `streamText()`. Callers must gate this on a resolved model
   * capability; the runtime never infers it from the provider name. `"required"` only means the
   * model must call some available tool, so it does not replace the terminal-tool invariant.
   */
  toolChoice?: "required";
  /**
   * Runs after per-step plugin preparation and before the provider request. Returning messages
   * replaces the request for this step; throwing prevents the provider request.
   */
  beforeModelRequest?: AgentModelRequestGuard;
  /**
   * Rejects a turn that never produced a terminal tool call instead of settling it as successful.
   * Defaults to `false` so existing callers keep their current turn semantics.
   */
  requireTerminalTool?: boolean;
  initialState?: AgentState;
  defaultState?: AgentState;
}

export interface Agent {
  readonly id: string;
  readonly channel: AgentChannel;
  readonly storage: AgentStorage<AgentEntry>;
  readonly state: AgentStateManager;
  init(): Promise<void>;
  stop(): Promise<void>;
  append(message: AgentMessage): Promise<void>;
  send(message: AgentMessage, options?: AgentSendOptions): string;
  run(message: AgentMessage, options?: AgentSendOptions): AsyncIterable<AgentInternalEvent>;
  wait(options?: AgentWaitOptions): Promise<void>;
  interrupt(reason?: unknown): Promise<void>;
  getModel(): LanguageModel;
  setModel(model: LanguageModel): void;
  clear(): Promise<void>;
  getActiveTurnId(): string | null;
  isIdle(): boolean;
}

interface ResolvedSystemPrompt {
  legacy?: string;
  blocks: SystemModelMessage[];
}

export function createAgent(config: AgentConfig): Agent {
  const id = config.id ?? crypto.randomUUID();
  const baseStorage = config.storage ?? createMemoryStorage();
  const channel = createAgentChannel();

  let storageReady = Promise.resolve();
  const mutateStorage = async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = storageReady.then(operation, operation);
    storageReady = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const storage: AgentStorage<AgentEntry> = {
    append: (...entries) => mutateStorage(() => Promise.resolve(baseStorage.append(...entries))),
    read: () => storageReady.then(() => baseStorage.read()),
    clear: () => mutateStorage(() => Promise.resolve(baseStorage.clear())),
  };
  const state = createStateManager({ storage, initialState: config.initialState ?? config.defaultState });

  let model = config.model;
  const baseTools = config.tools ?? [];
  const maxSteps = Math.max(1, config.maxSteps ?? DEFAULT_MAX_STEPS);
  const maxRetries = normalizeMaxRetries(config.maxRetries);
  let frozenSystemPrompt: string | SystemModelMessage[] | undefined;
  let frozenTools: AgentToolSet = [];
  let frozenProviderTools: ToolSet = {};

  const pluginHost = createPluginHost({
    plugins: config.plugins ?? [],
    runtime: { id, channel, state, storage, getModel: () => model, setModel: (next) => (model = next) },
  });

  const runtimeContext = { runtime: { id }, channel, state, storage, getModel: () => model, setModel: (next: LanguageModel) => (model = next) };

  let initialized = false;
  let initPromise: Promise<void> | undefined;
  const turnStreams = new Map<string, Set<(event: AgentInternalEvent) => void>>();
  const turnEventBuffer = new Map<string, AgentInternalEvent[]>();
  let appendPipelineReady = Promise.resolve();
  let activeTurnEntryCollector: ((entries: readonly AgentEntry[]) => void) | undefined;
  const submittedMessageEntries = new WeakMap<object, Array<Extract<AgentEntry, { type: "message" }>>>();

  const runAppendPipeline = async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = appendPipelineReady.then(operation, operation);
    appendPipelineReady = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const emitInternal = <T extends AgentInternalEventInit>(event: T): AgentInternalEvent<T> => {
    const created = createInternalEvent(event);

    if (isTurnScopedEvent(created)) {
      const buffered = turnEventBuffer.get(created.turnId) ?? [];
      buffered.push(created);
      turnEventBuffer.set(created.turnId, buffered);

      for (const listener of turnStreams.get(created.turnId) ?? []) {
        listener(created);
      }
    }

    void Promise.resolve(channel.emit("internal", created)).catch(() => undefined);

    return created;
  };

  const appendEntries = async (entries: AgentEntry[], options: { turnId?: string } = {}): Promise<AgentEntry[]> => {
    if (entries.length === 0) {
      return [];
    }

    return runAppendPipeline(async () => {
      const transformed = await pluginHost.helpers.onAppend(entries, runtimeContext);
      const persisted = sanitizeAgentEntriesForPersistence(transformed);
      await storage.append(...persisted);
      activeTurnEntryCollector?.(transformed);

      for (const entry of transformed) {
        if (entry.type !== "message") continue;

        await emitInternal(
          options.turnId ? { type: "message.appended", message: entry.data, turnId: options.turnId } : { type: "message.appended", message: entry.data },
        );
      }

      return transformed;
    });
  };

  const persistTerminalTurnEvent = async (event: AgentInternalEventInit & { turnId: string }) => {
    const created = await emitInternal(event);
    await storage.append(createEventEntry(created));
  };

  const ensureInit = () => {
    if (initialized) {
      return Promise.resolve();
    }
    if (initPromise) {
      return initPromise;
    }

    initPromise = (async () => {
      const base = await resolveConfiguredSystemPrompt(config.systemPrompt, {
        id,
        channel,
        state,
        storage,
        getModel: () => model,
        setModel: (next) => (model = next),
      });

      await pluginHost.init({ legacySystemPrompt: base.legacy, baseTools });

      const blocks = [...base.blocks, ...pluginHost.stablePromptBlocks];
      frozenSystemPrompt =
        pluginHost.stableLegacySystemPrompt !== undefined
          ? blocks.length === 0
            ? pluginHost.stableLegacySystemPrompt
            : [{ role: "system", content: pluginHost.stableLegacySystemPrompt }, ...blocks]
          : blocks.length > 0
            ? blocks
            : undefined;
      frozenTools = [...pluginHost.stableTools];
      frozenProviderTools = {};
      const toolNames = new Set(frozenTools.map((tool) => tool.name));
      for (const [name, tool] of Object.entries(config.providerTools ?? {})) {
        if (toolNames.has(name)) throw new ToolConflictError(name);
        frozenProviderTools[name] = { ...tool };
      }
      initialized = true;
      await emitInternal({ type: "agent.init" });
    })().finally(() => {
      if (!initialized) {
        initPromise = undefined;
      }
    });

    return initPromise;
  };

  const resolveTools = (turnId: string, currentMessages: () => readonly AgentMessage[], signal?: AbortSignal): AgentToolSet => {
    const merged = frozenTools;

    let serial = Promise.resolve();
    const wrapped: AgentToolSet = [];

    for (const tool of merged) {
      const toolName = tool.name;
      const execute = tool.execute;
      const wrappedTool: AgentTool = {
        ...tool,
        execute: execute
          ? async (input, options) => {
              const run = serial.then(async () => {
                const hookContext: ToolHookContext = { ...runtimeContext, turnId, signal: options.abortSignal ?? signal };
                throwIfAborted(hookContext.signal);

                const originalCall = { toolCallId: options.toolCallId, toolName, args: input };
                const decision = await pluginHost.helpers.beforeToolCall({ type: "allow" }, originalCall, hookContext);
                throwIfAborted(hookContext.signal);

                const nextInput = decision.type === "replace" ? decision.args : input;

                if (decision.type === "block") {
                  await emitInternal({ type: "tool.blocked", turnId, toolName, toolCallId: options.toolCallId, reason: decision.reason });
                  return { blocked: true, reason: decision.reason };
                }

                await emitInternal({ type: "tool.start", turnId, toolName, toolCallId: options.toolCallId, args: nextInput });

                try {
                  const executeContext: AgentToolExecuteContext = {
                    ...options,
                    runtime: { id },
                    channel,
                    state,
                    storage,
                    turnId,
                    abortSignal: hookContext.signal,
                    messages: [...currentMessages()],
                  };
                  const output = await raceAbort(Promise.resolve(execute(nextInput, executeContext)), hookContext.signal);
                  throwIfAborted(hookContext.signal);
                  const result = await pluginHost.helpers.afterToolCall(
                    { toolCallId: options.toolCallId, toolName, args: nextInput, result: output, isError: false },
                    hookContext,
                  );

                  await emitInternal({ type: "tool.done", turnId, toolName, toolCallId: options.toolCallId, result: result.result });
                  return result.result;
                } catch (error) {
                  const diagnostic = createDiagnostic(error);
                  await pluginHost.helpers.afterToolCall(
                    { toolCallId: options.toolCallId, toolName, args: nextInput, result: diagnostic, isError: true },
                    hookContext,
                  );

                  await emitInternal({ type: "tool.failed", turnId, toolName, toolCallId: options.toolCallId, error: diagnostic, args: nextInput });
                  throw error;
                }
              });

              serial = run.then(
                () => undefined,
                () => undefined,
              );
              return run;
            }
          : undefined,
      } as AgentTool;
      wrapped.push(wrappedTool);
    }

    return wrapped;
  };

  const collectPersistedEntries = async (): Promise<readonly AgentEntry[]> => {
    await appendPipelineReady;
    const rawEntries = await storage.read();
    return sanitizeAgentEntriesForPersistence(rawEntries);
  };

  const rememberSubmittedEntries = (messages: AgentMessage[], entries: Array<Extract<AgentEntry, { type: "message" }>>) => {
    if (messages.length !== entries.length) {
      return;
    }

    for (const [index, message] of messages.entries()) {
      submittedMessageEntries.set(message, [entries[index]]);
    }
  };

  const persistCurrentMessages = async (messages: AgentMessage[], turnId: string) => {
    const knownEntries: Array<Extract<AgentEntry, { type: "message" }>> = [];
    const freshMessages: AgentMessage[] = [];

    for (const message of messages) {
      const entries = submittedMessageEntries.get(message);
      if (entries) {
        knownEntries.push(...entries);
      } else {
        freshMessages.push(message);
      }
    }

    if (freshMessages.length === 0) {
      return knownEntries;
    }

    const transformed = await appendEntries(
      freshMessages.map((message) => createMessageEntry(message)),
      { turnId },
    );
    const freshEntries = transformed.filter((entry): entry is Extract<AgentEntry, { type: "message" }> => entry.type === "message");
    rememberSubmittedEntries(freshMessages, freshEntries);
    return [...knownEntries, ...freshEntries];
  };

  const buildBoundaryModelMessages = async (
    turnId: string,
    currentEntries: Array<Extract<AgentEntry, { type: "message" }>>,
    liveEntries: ReadonlyMap<string, Extract<AgentEntry, { type: "message" }>>,
    signal: AbortSignal,
    historyMode: AgentHistoryMode,
  ) => {
    const persisted = await collectPersistedEntries();
    const currentEntryIds = new Set(currentEntries.map((entry) => entry.id));
    // The persisted-history projection may only see messages that predate this turn; current-turn
    // entries keep their raw assistant/tool pairing and must not be dropped as delivered output.
    const historicalEntries = persisted.filter((entry) => entry.type !== "message" || !liveEntries.has(entry.id));
    const projectedHistory = historyMode === "event" ? [] : await pluginHost.helpers.transformEntries(historicalEntries);

    // A projection may deliberately reorder persisted history (for example, moving a compact
    // summary before the retained tail). Keep that projected order intact, then append raw entries
    // captured by this turn's append pipeline. Map insertion order follows durable append order,
    // while id lookup keeps an entry stable and deduplicated across repeated boundary rebuilds.
    const liveHistoryEntries = [...liveEntries.values()].filter((entry) => !currentEntryIds.has(entry.id));
    const history = [...projectedHistory, ...liveHistoryEntries]
      .filter((entry): entry is Extract<AgentEntry, { type: "message" }> => entry.type === "message")
      .map((entry) => entry.data);
    const current = currentEntries.map((entry) => entry.data);

    return buildModelMessages({ history, current, pluginHost, context: { runtime: { id }, channel, state, turnId, signal } });
  };

  const createTurnStream = (turnId: string): AsyncIterable<AgentInternalEvent> => {
    const queue = [...(turnEventBuffer.get(turnId) ?? [])];
    let done = queue.some(isTerminalTurnEvent);
    let resume: (() => void) | undefined;

    const cleanup = (listener: (event: AgentInternalEvent) => void) => {
      const listeners = turnStreams.get(turnId);
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        turnStreams.delete(turnId);
      }
      turnEventBuffer.delete(turnId);
    };

    const push = (event: AgentInternalEvent) => {
      queue.push(event);
      if (isTerminalTurnEvent(event)) {
        done = true;
      }
      const notify = resume;
      resume = undefined;
      notify?.();
    };

    const listeners = turnStreams.get(turnId) ?? new Set<typeof push>();
    listeners.add(push);
    turnStreams.set(turnId, listeners);

    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            while (queue.length === 0) {
              if (done) {
                cleanup(push);
                return { done: true, value: undefined };
              }
              await new Promise<void>((resolve) => {
                resume = resolve;
              });
            }

            const value = queue.shift()!;
            if (done && queue.length === 0 && isTerminalTurnEvent(value)) {
              cleanup(push);
            }
            return { done: false, value };
          },
        };
      },
    };
  };

  const executeTurn = async (request: TurnRequest): Promise<TurnResult> => {
    const allMessages: AgentMessage[] = [];
    const liveTurnEntries = new Map<string, Extract<AgentEntry, { type: "message" }>>();
    const rememberLiveEntries = (entries: readonly AgentEntry[]) => {
      for (const entry of entries) {
        if (entry.type === "message") liveTurnEntries.set(entry.id, entry);
      }
    };
    activeTurnEntryCollector = rememberLiveEntries;
    let turnUsage: Partial<LanguageModelUsage> | undefined;
    let latestStepUsage: Partial<LanguageModelUsage> | undefined;
    let currentBatch = request.messages.splice(0, request.messages.length);
    const abortSignal = request.signal;
    // Resolved after `ensureInit()`: plugin-provided tools only exist once the plugin host is frozen.
    let isTerminalToolCall: (call: { toolName: string; input?: unknown; invalid?: boolean }) => boolean = () => false;
    // Terminal tools are tracked across every step of the turn: a step that only ran intermediate
    // tools keeps the loop going, and a terminal call in any step settles the invariant.
    let sawTerminalToolCall = false;
    let sawIntermediateToolCall = false;
    let sawNonEmptyText = false;

    try {
      await ensureInit();
      isTerminalToolCall = createTerminalToolCallMatcher(frozenTools);
      await emitInternal({ type: "turn.start", turnId: request.turnId });

      while (currentBatch.length > 0) {
        const currentEntries = await persistCurrentMessages(currentBatch, request.turnId);
        rememberLiveEntries(currentEntries);
        allMessages.push(...currentEntries.map((entry) => entry.data));

        const modelMessages = await buildBoundaryModelMessages(request.turnId, currentEntries, liveTurnEntries, abortSignal, request.historyMode);

        let aborted = false;
        let persistedResponseMessageCount = 0;
        const retry = prepareRetryModel(model, maxRetries);
        const effectiveTools = { ...toAiToolSet(resolveTools(request.turnId, () => allMessages, abortSignal)), ...frozenProviderTools };
        const response = streamText({
          model: retry.model,
          system: frozenSystemPrompt,
          messages: modelMessages,
          tools: effectiveTools,
          ...(config.toolChoice ? { toolChoice: config.toolChoice } : {}),
          stopWhen: [isLoopFinished(), stepCountIs(maxSteps), allToolCallsTerminal(frozenTools)],
          abortSignal,
          prepareStep: async ({ stepNumber }) => {
            let messages = modelMessages;
            if (stepNumber > 0) {
              const joined = await request.drainJoined();
              if (joined.length === 0) {
                messages = await buildBoundaryModelMessages(request.turnId, [], liveTurnEntries, abortSignal, request.historyMode);
              } else {
                const joinedEntries = await persistCurrentMessages(joined, request.turnId);
                rememberLiveEntries(joinedEntries);
                allMessages.push(...joinedEntries.map((entry) => entry.data));
                messages = await buildBoundaryModelMessages(request.turnId, joinedEntries, liveTurnEntries, abortSignal, request.historyMode);
              }
            }

            const prepareContext = {
              runtime: { id },
              channel,
              state,
              turnId: request.turnId,
              stepNumber,
              signal: abortSignal,
            };
            const prepared = await pluginHost.helpers.prepareStep(messages, prepareContext);
            const guard = config.beforeModelRequest;
            if (!guard) return { messages: [...prepared] };

            const guarded = await guard({
              model: retry.model,
              system: frozenSystemPrompt,
              messages: prepared,
              tools: effectiveTools,
              ...(config.toolChoice ? { toolChoice: config.toolChoice } : {}),
              currentMessageIds: [...liveTurnEntries.keys()],
              turnId: request.turnId,
              stepNumber,
              signal: abortSignal,
              rebuildMessages: async () => {
                const rebuilt = await buildBoundaryModelMessages(
                  request.turnId,
                  [...liveTurnEntries.values()],
                  liveTurnEntries,
                  abortSignal,
                  request.historyMode,
                );
                return pluginHost.helpers.prepareStep(rebuilt, prepareContext);
              },
            });
            return { messages: [...(guarded ?? prepared)] };
          },
          maxRetries: retry.maxRetries,
          onAbort() {
            aborted = true;
          },
          onStepFinish: async (step) => {
            const responseMessages = step.response.messages.slice(persistedResponseMessageCount);
            persistedResponseMessageCount = step.response.messages.length;
            const stepMessages: AgentMessage[] = responseMessages.map((message) =>
              message.role === "assistant"
                ? createAssistantMessage(message.content, { providerOptions: message.providerOptions, usage: step.usage, finishReason: step.finishReason })
                : createToolMessage(message.content),
            );
            turnUsage = mergeUsage(turnUsage, step.usage);
            latestStepUsage = step.usage;

            for (const call of step.toolCalls ?? []) {
              if (isTerminalToolCall(call)) {
                sawTerminalToolCall = true;
                continue;
              }
              // A malformed call bought the turn nothing: it is neither a terminal action nor a
              // completed intermediate action.
              if (call.invalid) continue;
              sawIntermediateToolCall = true;
            }
            if (typeof step.text === "string" && step.text.trim().length > 0) {
              sawNonEmptyText = true;
            }

            if (stepMessages.length > 0) {
              const stepEntries = await appendEntries(
                stepMessages.map((message) => createMessageEntry(message)),
                { turnId: request.turnId },
              );
              const liveStepEntries = stepEntries.filter((entry): entry is Extract<AgentEntry, { type: "message" }> => entry.type === "message");
              rememberLiveEntries(liveStepEntries);
              allMessages.push(...liveStepEntries.map((entry) => entry.data));
            }

            await emitInternal({
              type: "turn.step",
              turnId: request.turnId,
              step: step.stepNumber,
              usage: step.usage,
              finishReason: step.finishReason,
              reasoningText: step.reasoningText,
            });
          },
        });

        for await (const part of response.fullStream) {
          await channel.emit("stream", part);

          if (part.type === "text-delta") {
            const textPart = part as { text?: unknown; delta?: unknown };
            const delta = String(textPart.text ?? textPart.delta ?? "");
            await emitInternal({ type: "turn.delta", turnId: request.turnId, delta });
            continue;
          }
          if (part.type === "error") {
            throw part.error;
          }
        }

        if (aborted || abortSignal.aborted) {
          throw createAbortError();
        }

        currentBatch = await request.drainJoined();
      }

      if (config.requireTerminalTool && !sawTerminalToolCall) {
        throw new AgentProtocolError(resolveProtocolViolation({ sawNonEmptyText, sawIntermediateToolCall }));
      }

      await emitInternal({ type: "turn.done", turnId: request.turnId });
      const result: TurnResult = {
        turnId: request.turnId,
        status: "done",
        messages: allMessages,
        ...(turnUsage ? { usage: turnUsage } : {}),
        ...(latestStepUsage ? { latestStepUsage } : {}),
      };
      await pluginHost.helpers.onTurnFinish(result, { runtime: { id }, channel, state, turnId: request.turnId });
      return result;
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      const diagnostic = createDiagnostic(error);
      const result: TurnResult = { turnId: request.turnId, status: aborted ? "aborted" : "failed", messages: allMessages, error: diagnostic };
      await persistTerminalTurnEvent(
        aborted
          ? { type: "turn.aborted", turnId: request.turnId, reason: formatAbortReason(error, abortSignal) }
          : { type: "turn.failed", turnId: request.turnId, error: diagnostic },
      );
      await pluginHost.helpers.onTurnFinish(result, { runtime: { id }, channel, state, turnId: request.turnId });
      return result;
    } finally {
      if (activeTurnEntryCollector === rememberLiveEntries) activeTurnEntryCollector = undefined;
    }
  };

  const turnQueue = createTurnQueue({ onRun: executeTurn });

  const agent: Agent = {
    id,
    channel,
    storage,
    state,
    async init() {
      await ensureInit();
    },
    async stop() {
      await initPromise?.catch(() => undefined);
      if (!initialized) return;

      await pluginHost.stop();
      initialized = false;
      initPromise = undefined;
      await emitInternal({ type: "agent.stop" });
    },
    async append(message) {
      await this.init();
      const entries = await appendEntries([createMessageEntry(message)]);
      const messageEntries = entries.filter((entry): entry is Extract<AgentEntry, { type: "message" }> => entry.type === "message");
      rememberSubmittedEntries([message], messageEntries);
    },
    send(message, options = {}) {
      const activeTurnId = turnQueue.activeTurnId;
      let persistence: Promise<void> | undefined;

      if (options.ifBusy === "join" && activeTurnId && !submittedMessageEntries.has(message)) {
        persistence = appendEntries([createMessageEntry(message)], { turnId: activeTurnId }).then((entries) => {
          const messageEntries = entries.filter((entry): entry is Extract<AgentEntry, { type: "message" }> => entry.type === "message");
          rememberSubmittedEntries([message], messageEntries);
        });
      }

      const turnId = turnQueue.enqueue([message], options.ifBusy, persistence, options.historyMode);
      if (turnId !== activeTurnId) {
        void emitInternal({ type: "turn.queued", turnId });
      }
      return turnId;
    },
    run(message, options = {}) {
      const turnId = this.send(message, options);
      return createTurnStream(turnId);
    },
    wait(options = {}) {
      return turnQueue.wait(options);
    },
    interrupt(reason) {
      return turnQueue.interrupt(reason);
    },
    getModel() {
      return model;
    },
    setModel(next) {
      model = next;
    },
    async clear() {
      await storage.clear();
    },
    getActiveTurnId() {
      return turnQueue.activeTurnId ?? null;
    },
    isIdle() {
      return turnQueue.isIdle();
    },
  };

  return agent;
}

/**
 * Shared terminal-tool decision used by both the stop condition and the final protocol check, so a
 * tool can never end the loop without also satisfying the terminal invariant.
 */
function createTerminalToolCallMatcher(tools: AgentToolSet): (call: { toolName: string; input?: unknown; invalid?: boolean }) => boolean {
  const always = new Set<string>();
  const predicates = new Map<string, (input: unknown) => boolean>();
  for (const tool of tools) {
    if (tool.terminal === true) always.add(tool.name);
    else if (typeof tool.terminal === "function") predicates.set(tool.name, tool.terminal as (input: unknown) => boolean);
  }
  return (call) => {
    if (call.invalid) return false;
    if (always.has(call.toolName)) return true;
    const predicate = predicates.get(call.toolName);
    if (!predicate) return false;
    try {
      return predicate(call.input);
    } catch {
      return false;
    }
  };
}

/**
 * Stops the turn when every tool call in the final step is terminal. Tools declaring
 * `terminal: true` always qualify; predicate tools decide from the model-generated input, so a
 * single tool can both end the turn and opt into another step. Invalid calls never qualify.
 */
// eslint-disable-next-line typescript/no-explicit-any
function allToolCallsTerminal(tools: AgentToolSet): StopCondition<any> {
  const isTerminal = createTerminalToolCallMatcher(tools);
  const hasTerminalTools = tools.some((tool) => tool.terminal === true || typeof tool.terminal === "function");
  return ({ steps }: { steps: Array<{ toolCalls: Array<{ toolName: string; input?: unknown; invalid?: boolean }> }> }) => {
    if (!hasTerminalTools) return false;
    const last = steps.at(-1);
    if (!last) return false;
    const calls = last.toolCalls;
    if (calls.length === 0) return false;
    return calls.every(isTerminal);
  };
}

function resolveProtocolViolation(state: { sawNonEmptyText: boolean; sawIntermediateToolCall: boolean }): AgentProtocolViolation {
  if (state.sawNonEmptyText) return "text-only";
  if (state.sawIntermediateToolCall) return "non-terminal-tool";
  return "empty-or-no-terminal-tool";
}

function mergeUsage(current: Partial<LanguageModelUsage> | undefined, next: LanguageModelUsage | undefined): Partial<LanguageModelUsage> | undefined {
  if (!next) return current;
  return {
    ...current,
    inputTokens: (current?.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (current?.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (current?.totalTokens ?? 0) + (next.totalTokens ?? 0),
    ...(next.reasoningTokens !== undefined ? { reasoningTokens: (current?.reasoningTokens ?? 0) + next.reasoningTokens } : {}),
    ...(next.cachedInputTokens !== undefined ? { cachedInputTokens: (current?.cachedInputTokens ?? 0) + next.cachedInputTokens } : {}),
  };
}

function createAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function formatAbortReason(error: unknown, signal: AbortSignal): string {
  const errorCause = formatErrorCause(error);
  if (!signal.aborted || signal.reason === undefined) return errorCause;
  return `${errorCause} (signal: ${formatErrorCause(signal.reason)})`;
}

function normalizeMaxRetries(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(MAX_MODEL_RETRIES, Math.max(0, Math.trunc(value)));
}

function prepareRetryModel(model: LanguageModel, maxRetries: number): { readonly model: LanguageModel; readonly maxRetries: number } {
  if (maxRetries === 0 || !isLanguageModelV3(model)) return { model, maxRetries: 0 };
  return { model: wrapLanguageModel({ model, middleware: RETRYABLE_429_ONLY_MIDDLEWARE }), maxRetries };
}

function isLanguageModelV3(model: LanguageModel): model is Parameters<typeof wrapLanguageModel>[0]["model"] {
  return typeof model === "object" && model !== null && "specificationVersion" in model && model.specificationVersion === "v3";
}

function markNon429AsNonRetryable(cause: unknown): unknown {
  if (!APICallError.isInstance(cause) || !cause.isRetryable || cause.statusCode === 429) return cause;
  return new APICallError({
    message: cause.message,
    url: cause.url,
    requestBodyValues: cause.requestBodyValues,
    statusCode: cause.statusCode,
    responseHeaders: cause.responseHeaders,
    responseBody: cause.responseBody,
    cause: cause.cause,
    isRetryable: false,
    data: cause.data,
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function raceAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return operation;
  }

  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(createAbortError()), { once: true });
    }),
  ]);
}

function isTurnScopedEvent(event: AgentInternalEvent): event is AgentInternalEvent & { turnId: string } {
  return "turnId" in event && typeof (event as { turnId?: unknown }).turnId === "string";
}

function isTerminalTurnEvent(event: AgentInternalEvent) {
  return event.type === "turn.done" || event.type === "turn.failed" || event.type === "turn.aborted";
}

async function resolveConfiguredSystemPrompt(input: AgentConfig["systemPrompt"], runtime: AgentPluginRuntime): Promise<ResolvedSystemPrompt> {
  const value = typeof input === "function" ? await input(runtime) : input;
  if (value === undefined) return { blocks: [] };
  if (typeof value === "string") return { legacy: value, blocks: [] };
  return { blocks: normalizeSystemPromptAppend(value) };
}
