import { appendFile, mkdir, readFile, rm, truncate } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentEntry } from "./entry.js";

export interface AgentStorage<T = AgentEntry> {
  append: (...items: T[]) => Promise<void> | void;
  clear: () => Promise<void> | void;
  read: () => Promise<Readonly<T[]>> | Readonly<T[]>;
}

export function createMemoryStorage<T extends AgentEntry = AgentEntry>(initialEntries: readonly T[] = []): AgentStorage<T> {
  const entries: T[] = [...initialEntries];

  return {
    async append(...nextEntries) {
      entries.push(...nextEntries);
    },
    async read() {
      return [...entries];
    },
    async clear() {
      entries.length = 0;
    },
  };
}

export function createJsonlStorage(filePath: string): AgentStorage<AgentEntry> {
  // Repair and append share the same writer queue. Conversation also serializes lifecycle
  // changes; this queue does not claim cross-process locking or filesystem crash atomicity.
  let tail = Promise.resolve();
  let appendTailChecked = false;
  const mutate = (operation: () => Promise<void>): Promise<void> => {
    const next = tail.then(operation, operation);
    tail = next.catch(() => undefined);
    return next;
  };
  const content = async (): Promise<string> => {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  };
  return {
    append(...entries) {
      if (!entries.length) return Promise.resolve();
      return mutate(async () => {
        // Serialize before repair: an unserializable candidate must not alter canonical bytes.
        const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");
        try {
          let separator = "";
          // Inspect once per storage instance, not once per message. Successful writes always
          // finish with a newline; only a failed write or clear requires another tail inspection.
          if (!appendTailChecked) {
            const existing = await content();
            const decoded = decodeJsonl(existing);
            if (decoded.tornTailAt !== undefined) await truncate(filePath, Buffer.byteLength(existing.slice(0, decoded.tornTailAt), "utf8"));
            separator = decoded.tornTailAt === undefined && existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
          }
          await mkdir(dirname(filePath), { recursive: true });
          await appendFile(filePath, `${separator}${payload}\n`, "utf8");
          appendTailChecked = true;
        } catch (error) {
          appendTailChecked = false;
          throw error;
        }
      });
    },
    async read() {
      await tail;
      return decodeJsonl(await content()).entries;
    },
    clear() {
      return mutate(async () => {
        appendTailChecked = false;
        await rm(filePath, { force: true });
      });
    },
  };
}

/** Only a malformed, unterminated final line can be an interrupted append. */
function decodeJsonl(content: string): { entries: AgentEntry[]; tornTailAt?: number } {
  const entries: AgentEntry[] = [];
  const lines = content.split("\n");
  let offset = 0;
  for (const [i, line] of lines.entries()) {
    if (line) {
      try {
        entries.push(JSON.parse(line) as AgentEntry);
      } catch (error) {
        if (i === lines.length - 1 && !content.endsWith("\n")) return { entries, tornTailAt: offset };
        throw new SyntaxError(`Invalid JSON at line ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    offset += line.length + 1;
  }
  return { entries };
}
