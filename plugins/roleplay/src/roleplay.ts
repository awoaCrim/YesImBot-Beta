import type { CharacterCardV3 } from "@risuai/ccardlib";
import { createAssistantMessage, createMessageEntry, type AgentPlugin } from "@yesimbot/agent-runtime";

import type { CBSContext } from "./cbs.js";
import { renderCBS } from "./cbs.js";
import { assembleCharacterDefinition, assembleInstructionExtension, assemblePostHistoryInstructions } from "./prompt.js";

export interface RoleplayAgentPluginOptions {
  readonly card: CharacterCardV3;
  readonly greeting: string;
  readonly random?: () => number;
  readonly userName: string;
  /** Shared per-channel placeholder state used by the role profile and greeting. */
  readonly context?: CBSContext;
  /** True when an active polisher owns style, so card prompts must stay out of the main Agent. */
  readonly delegatePrompts?: boolean;
}

export function createRoleplayPlugin(options: RoleplayAgentPluginOptions): AgentPlugin {
  const context: CBSContext = options.context ?? {
    charName: options.card.data.nickname ?? options.card.data.name,
    pickCache: new Map<string, string>(),
    random: options.random,
    userName: options.userName,
  };
  const instructionExtension = assembleInstructionExtension(options.card, context);
  const characterDefinition = assembleCharacterDefinition(options.card, context);
  const postHistoryInstructions = assemblePostHistoryInstructions(options.card, context);
  const stableInstructions = [instructionExtension, postHistoryInstructions].filter((section) => section.length > 0).join("\n\n");
  const greeting = renderCBS(options.greeting, context).text;
  const prefix = characterDefinition.length > 0 ? [{ role: "system" as const, content: characterDefinition }] : [];
  const delegate = options.delegatePrompts === true;
  const plugin: AgentPlugin = {
    name: "roleplay",
    async init(runtime) {
      const entries = await runtime.storage.read();
      if (entries.some((entry) => entry.type === "message") || greeting.length === 0) return;
      await runtime.storage.append(createMessageEntry(createAssistantMessage(greeting)));
    },
  };

  // Google providers reject system messages after conversation history, so card instructions stay in
  // the frozen leading system prompt. A delegated prompt goes to the polisher profile instead, which
  // keeps persona-specific roleplay instructions out of the main Agent.
  if (!delegate) {
    plugin.appendSystemPrompt = () => stableInstructions || undefined;
    plugin.prepareStep = (messages) => [...prefix, ...messages];
  }

  return plugin;
}
