import type { CharacterCardV3 } from "@risuai/ccardlib";
import type { MainAgentRoleProfile } from "koishi-plugin-yesimbot";

import type { CBSContext } from "./cbs.js";
import { renderCBS } from "./cbs.js";
import { VISUAL_REFERENCE_INSTRUCTIONS } from "./visual-reference.js";

export interface RoleplayHistoryMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

/** One cached render shared by Core role resolution and standalone/managed request setup. */
export interface RoleplayPromptMaterial {
  readonly roleProfile: MainAgentRoleProfile;
  readonly dialogueHistory: readonly RoleplayHistoryMessage[];
}

export function assembleInstructionExtension(card: CharacterCardV3, context: CBSContext): string {
  const systemPrompt = render(card.data.system_prompt, context);
  const exampleDialogues = formatExampleDialogues(render(card.data.mes_example, context));
  return [systemPrompt, exampleDialogues].filter((section) => section.length > 0).join("\n\n");
}

export function assembleCharacterDefinition(card: CharacterCardV3, context: CBSContext): string {
  const name = render(card.data.nickname ?? card.data.name, context);
  const description = render(card.data.description, context);
  const personality = render(card.data.personality, context);
  const scenario = render(card.data.scenario, context);

  return [
    name.length > 0 ? `Name: ${name}` : "",
    description,
    personality.length > 0 ? `Personality:\n${personality}` : "",
    scenario.length > 0 ? `Scenario:\n${scenario}` : "",
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
}

export function assemblePostHistoryInstructions(card: CharacterCardV3, context: CBSContext): string {
  return render(card.data.post_history_instructions, context);
}

/** Retain the existing default profile API and its CBS rendering order. */
export function assembleRoleProfile(card: CharacterCardV3, context: CBSContext): MainAgentRoleProfile {
  return assembleRoleplayPrompts(card, context).roleProfile;
}

export function assembleRoleplayPrompts(
  card: CharacterCardV3,
  context: CBSContext,
  examplesAsHistory = false,
  visualReference = false,
): RoleplayPromptMaterial {
  const instructionExtension = examplesAsHistory ? render(card.data.system_prompt, context) : assembleInstructionExtension(card, context);
  const dialogueHistory = examplesAsHistory ? parseDialogueHistory(card, context) : [];
  const postHistoryInstructions = assemblePostHistoryInstructions(card, context);
  const roleInstructions = [instructionExtension, postHistoryInstructions, visualReference ? VISUAL_REFERENCE_INSTRUCTIONS : ""]
    .filter((section) => section.length > 0)
    .join("\n\n");
  const characterDefinition = assembleCharacterDefinition(card, context);

  return {
    roleProfile: {
      ...(roleInstructions.length > 0 ? { roleInstructions } : {}),
      ...(characterDefinition.length > 0 ? { characterDefinition } : {}),
    },
    dialogueHistory: Object.freeze(dialogueHistory),
  };
}

function parseDialogueHistory(card: CharacterCardV3, context: CBSContext): RoleplayHistoryMessage[] {
  const aliases = new Map<string, Set<RoleplayHistoryMessage["role"]>>();
  const addAlias = (label: string | undefined, role: RoleplayHistoryMessage["role"]) => {
    if (!label?.trim()) return;
    const name = label.trim();
    const roles = aliases.get(name) ?? new Set<RoleplayHistoryMessage["role"]>();
    roles.add(role);
    aliases.set(name, roles);
  };
  addAlias(context.userName ?? "User", "user");
  for (const name of [context.charName, card.data.name, card.data.nickname]) addAlias(name, "assistant");
  const headers = [...aliases]
    .sort(([first], [second]) => second.length - first.length)
    .map(([label, roles]) => ({ pattern: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：](.*)$`), roles }));
  const blocks = card.data.mes_example
    .split(/<START>/i)
    .map((block) => block.trim())
    .filter(Boolean);
  const messages: RoleplayHistoryMessage[] = [];
  for (const [blockIndex, block] of blocks.entries()) {
    const fail = (line: number, reason: string): never => {
      throw new Error(`Invalid mes_example block ${blockIndex + 1}, line ${line}: ${reason}. Use {{user}}: or {{char}}: speaker headers.`);
    };
    let current: { role: RoleplayHistoryMessage["role"]; lines: string[]; line: number } | undefined;
    const flush = () => {
      if (!current) return;
      const content = render(current.lines.join("\n"), context);
      if (!content) fail(current.line, "empty dialogue turn");
      messages.push(Object.freeze({ role: current.role, content }));
    };
    for (const [lineIndex, line] of block.replace(/\r\n?/g, "\n").split("\n").entries()) {
      const token = line.match(/^\s*\{\{\s*(user|char)\s*\}\}\s*[:：](.*)$/i);
      let role: RoleplayHistoryMessage["role"] | undefined;
      let body = "";
      if (token) {
        role = token[1]?.toLowerCase() === "user" ? "user" : "assistant";
        body = token[2] ?? "";
      } else {
        for (const header of headers) {
          const match = header.pattern.exec(line);
          if (!match) continue;
          if (header.roles.size !== 1) fail(lineIndex + 1, "ambiguous speaker label");
          role = [...header.roles][0];
          body = match[1] ?? "";
          break;
        }
      }
      if (role) {
        flush();
        current = { role, lines: [body], line: lineIndex + 1 };
      } else if (/^\s*\{\{[^\n]+\}\}\s*[:：]/.test(line)) {
        fail(lineIndex + 1, "unsupported speaker token");
      } else if (current) {
        // Ordinary colon-bearing lines are body text, not guessed third-party speakers.
        current.lines.push(line);
      } else if (render(line, context).length > 0) {
        fail(lineIndex + 1, "text before a supported speaker header");
      }
    }
    flush();
  }
  return messages;
}

function render(value: string, context: CBSContext): string {
  return renderCBS(value, context).text.trim();
}

function formatExampleDialogues(example: string): string {
  const dialogues = example
    .split(/<START>/i)
    .map((dialogue) => dialogue.trim())
    .filter((dialogue) => dialogue.length > 0);
  if (dialogues.length === 0) return "";

  return [
    "<example_dialogues>",
    "These are style and behavior examples, not events from the current conversation.",
    ...dialogues.flatMap((dialogue) => ["<example_dialogue>", dialogue, "</example_dialogue>"]),
    "</example_dialogues>",
  ].join("\n");
}
