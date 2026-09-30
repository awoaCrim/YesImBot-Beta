import { describe, expect, it, vi } from "vitest";

import { createChannelTools } from "../src/plugin.js";
import type { MemoryStore } from "../src/store/memory.js";
import type { PendingStore } from "../src/store/pending.js";
import type { MemoryQuery, MemoryScope } from "../src/types.js";

const channel = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;

function store(rows: Array<Record<string, unknown>>, semanticUsed = false) {
  const searchVisible = vi.fn(async (_context: unknown, userIds: readonly string[], query: MemoryQuery) => ({
    memories: rows
      .filter((row) => row.scope !== "user" || userIds.includes(row.userId as string))
      .filter((row) => !query.scopes || query.scopes.includes(row.scope as MemoryScope))
      .map((row) => ({ ...row })),
    semanticUsed,
  }));
  return {
    store: {
      searchVisible,
      touch: async (ids: readonly string[]) => {
        for (const row of rows) if (ids.includes(row.id as string)) row.accessCount = Number(row.accessCount) + 1;
      },
    } as unknown as MemoryStore,
    searchVisible,
  };
}

function recallTool(rows: Array<Record<string, unknown>>, semanticUsed = false) {
  const { store: memoryStore, searchVisible } = store(rows, semanticUsed);
  const tools = createChannelTools(channel, memoryStore, {} as PendingStore, {
    evidenceCount: async () => 0,
    readConversation: async () => [],
    rearm: async () => {},
    search: async () => ({ answer: "", memories: [], unresolved: [] }),
  });
  return { tool: tools.find((entry) => entry.name === "recall")!, searchVisible };
}

describe("recall tool", () => {
  it("limits user memory to participants in the current turn and returns projections only", async () => {
    const rows = [
      { id: "channel", type: "fact", content: "channel fact", scope: "channel", importance: 1, confidence: 1, updatedAt: 0, accessCount: 0 },
      { id: "alice", type: "fact", content: "alice fact", scope: "user", userId: "alice", importance: 1, confidence: 1, updatedAt: 0, accessCount: 0 },
      { id: "bob", type: "fact", content: "bob fact", scope: "user", userId: "bob", importance: 1, confidence: 1, updatedAt: 0, accessCount: 0 },
    ];
    const { tool } = recallTool(rows);

    const result = await tool.execute({ limit: 10 }, { messages: [{ role: "custom", type: "yesimbot.message", data: { user: { id: "alice" } } }] } as never);

    expect(result).toMatchObject({
      semanticUsed: false,
      memories: [
        { id: "channel", evidenceCount: 0 },
        { id: "alice", evidenceCount: 0 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("bob");
  });

  it("forwards the semantic flag to the store instead of probing the model itself", async () => {
    const rows = [{ id: "shared", type: "fact", content: "fact", scope: "shared", importance: 1, confidence: 1, updatedAt: 0, accessCount: 0 }];
    const { tool, searchVisible } = recallTool(rows);

    await tool.execute({ query: "coffee", semantic: true }, { messages: [] } as never);
    expect(searchVisible.mock.calls.at(-1)?.[2]).toMatchObject({ query: "coffee", semantic: true });

    await tool.execute({ query: "coffee" }, { messages: [] } as never);
    expect(searchVisible.mock.calls.at(-1)?.[2]).toMatchObject({ semantic: undefined });
  });

  it("reports semanticUsed from the store result", async () => {
    const rows = [{ id: "shared", type: "fact", content: "fact", scope: "shared", importance: 1, confidence: 1, updatedAt: 0, accessCount: 0 }];
    const { tool } = recallTool(rows, true);

    await expect(tool.execute({ query: "coffee", semantic: true }, { messages: [] } as never)).resolves.toMatchObject({ semanticUsed: true });
  });
});
