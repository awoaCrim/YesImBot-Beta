import type { CharacterCardV3 } from "@risuai/ccardlib";
import { createAssistantMessage, createMessageEntry, type AgentPlugin } from "@yesimbot/agent-runtime";

import type { CBSContext } from "./cbs.js";
import { renderCBS } from "./cbs.js";
import { assembleRoleProfile } from "./prompt.js";

export interface RoleplayAgentPluginOptions {
  readonly card: CharacterCardV3;
  readonly greeting: string;
  readonly random?: () => number;
  readonly userName: string;
  /** Shared per-channel placeholder state used by the role profile and greeting. */
  readonly context?: CBSContext;
  /** Core already placed this card in its unified role section; greeting initialization still runs. */
  readonly managedPrompts?: boolean;
}

export function createRoleplayPlugin(options: RoleplayAgentPluginOptions): AgentPlugin {
  const context: CBSContext = options.context ?? {
    charName: options.card.data.nickname ?? options.card.data.name,
    pickCache: new Map<string, string>(),
    random: options.random,
    userName: options.userName,
  };
  const delegate = options.managedPrompts === true;
  // Managed material was already rendered before setup. Do not consume random/roll placeholders again.
  const profile = delegate ? {} : assembleRoleProfile(options.card, context);
  const cardSection = [profile.characterDefinition, profile.roleInstructions].filter(Boolean).join("\n\n");
  const greeting = renderCBS(options.greeting, context).text;
  const plugin: AgentPlugin = {
    name: "roleplay",
    async init(runtime) {
      const entries = await runtime.storage.read();
      if (entries.some((entry) => entry.type === "message") || greeting.length === 0) return;
      await runtime.storage.append(createMessageEntry(createAssistantMessage(greeting)));
    },
  };

  // Google providers reject system messages after conversation history, so card instructions stay in
  // one complete frozen leading system block. Core-placed material does not add another card prefix.
  if (!delegate) {
    plugin.appendSystemPrompt = () => cardSection || undefined;
  }

  return plugin;
}
