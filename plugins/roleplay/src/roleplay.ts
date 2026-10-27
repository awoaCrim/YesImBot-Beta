import type { CharacterCardV3 } from "@risuai/ccardlib";
import { createAssistantMessage, createMessageEntry, type AgentPlugin } from "@yesimbot/agent-runtime";

import type { CBSContext } from "./cbs.js";
import { renderCBS } from "./cbs.js";
import { assembleRoleplayPrompts, type RoleplayPromptMaterial } from "./prompt.js";

export interface RoleplayAgentPluginOptions {
  readonly card: CharacterCardV3;
  readonly greeting: string;
  readonly random?: () => number;
  readonly userName: string;
  /** Shared per-channel placeholder state used by the role profile and greeting. */
  readonly context?: CBSContext;
  /** Core already placed this card in its unified role section; greeting initialization still runs. */
  readonly managedPrompts?: boolean;
  readonly exampleDialoguesAsHistory?: boolean;
  /** Reuse the channel render already supplied to Core; never rerender random/roll fields. */
  readonly material?: RoleplayPromptMaterial;
}

export function createRoleplayPlugin(options: RoleplayAgentPluginOptions): AgentPlugin {
  const context: CBSContext = options.context ?? {
    charName: options.card.data.nickname ?? options.card.data.name,
    pickCache: new Map<string, string>(),
    random: options.random,
    userName: options.userName,
  };
  const delegate = options.managedPrompts === true;
  // Old managed callers need no card render; resolved channel material carries optional history.
  const material: RoleplayPromptMaterial =
    options.material ??
    (delegate && options.exampleDialoguesAsHistory !== true
      ? { roleProfile: {}, dialogueHistory: [] }
      : assembleRoleplayPrompts(options.card, context, options.exampleDialoguesAsHistory === true));
  const profile = material.roleProfile;
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

  if (material.dialogueHistory.length > 0) {
    const history = material.dialogueHistory;
    const historyObjects = new Set<object>(history);
    plugin.prepareStep = (messages, context) => {
      // Rebuilt steps need the same batch. Remove only our own objects, never identical real speech.
      const retained = messages.filter((message) => !historyObjects.has(message));
      for (const message of history) context.projection?.register(message, { kind: "mandatory", sourceEntryIds: [] });
      const firstDialogue = retained.findIndex((message) => message.role !== "system");
      const insertion = firstDialogue < 0 ? retained.length : firstDialogue;
      return [...retained.slice(0, insertion), ...history, ...retained.slice(insertion)];
    };
  }

  return plugin;
}
