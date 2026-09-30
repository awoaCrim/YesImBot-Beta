import type { AgentInternalEvent } from "./event.js";
import { createRandomId } from "./id.js";
import type { AgentMessage } from "./message.js";
import type { AgentState } from "./state.js";
export type AgentCustomEntryData<T extends keyof AgentCustomEntries = keyof AgentCustomEntries> = AgentCustomEntries[T];

export type AgentEntry<T extends keyof AgentCustomEntries = keyof AgentCustomEntries> = T extends keyof AgentCustomEntries
  ? { data: AgentCustomEntryData<T>; id: string; parentId?: string; timestamp: number; type: T }
  : never;

export interface CompactEntryData {
  summary: string;
  /** Last source entry covered by this fragment; the compact boundary of the next window. */
  lastEntryId: string;
  sourceSession?: string;
  /** First source entry covered by this fragment. */
  firstEntryId?: string;
  /** Previous compact entry in the same lineage; absent for the first fragment. */
  parentCompactId?: string;
  /**
   * Stable identifier shared by every fragment of one continuous conversation lineage, so an
   * archived session keeps recalling its own history and a fresh session does not inherit it.
   */
  lineageId?: string;
  /** Earliest source message timestamp (epoch ms) covered by this fragment. */
  startAt?: number;
  /** Latest source message timestamp (epoch ms) covered by this fragment. */
  endAt?: number;
}

export interface AgentCustomEntries {
  compact: CompactEntryData;
  event: AgentInternalEvent;
  message: AgentMessage;
  state: AgentState;
}

export interface CreateEntryOptions {
  id?: string;
  timestamp?: number;
  parentId?: string;
}

export function createEntry<T extends keyof AgentCustomEntries>(type: T, data: AgentCustomEntryData<T>, options: CreateEntryOptions = {}): AgentEntry<T> {
  return { id: options.id ?? createRandomId(), type, data, timestamp: options.timestamp ?? Date.now(), parentId: options.parentId } as AgentEntry<T>;
}

export function createMessageEntry(message: AgentMessage, options: CreateEntryOptions = {}): AgentEntry<"message"> {
  return createEntry("message", message, options);
}

export function createStateEntry(state: AgentState, options: CreateEntryOptions = {}): AgentEntry<"state"> {
  return createEntry("state", state, options);
}

export function createEventEntry(event: AgentInternalEvent, options: CreateEntryOptions = {}): AgentEntry<"event"> {
  return createEntry("event", event, options);
}
