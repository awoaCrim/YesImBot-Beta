import { describe, expect, it } from "vitest";

import type { EmbeddingIndexer } from "../src/semantic.js";
import { MemoryStore } from "../src/store/memory.js";

/** Three orthogonal concept axes; synonyms let a query match without sharing a keyword. */
const CONCEPTS: Record<string, number> = { 咖啡: 0, coffee: 0, 吉他: 1, music: 1, 代码: 2, code: 2 };

function toyEmbed(text: string): number[] {
  const vector = [0, 0, 0];
  for (const [word, axis] of Object.entries(CONCEPTS)) if (text.includes(word)) vector[axis] = 1;
  return vector;
}

function fakeIndexer(modelId = "toy-v1", queryPrefix = ""): EmbeddingIndexer & { calls: string[] } {
  const calls: string[] = [];
  return {
    modelId,
    queryPrefix,
    calls,
    async embed(text) {
      calls.push(text);
      return toyEmbed(text);
    },
  };
}

class Model {
  public readonly rows: Record<string, unknown>[] = [];
  public extend(): void {}
  public async get(_table: string, query: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    return this.rows.filter((row) => Object.entries(query).every(([key, value]) => row[key] === value));
  }
  public async create(_table: string, row: Record<string, unknown>): Promise<void> {
    this.rows.push({ ...row });
  }
  public async set(_table: string, query: Record<string, unknown>, patch: Record<string, unknown>): Promise<void> {
    for (const row of this.rows) if (Object.entries(query).every(([key, value]) => row[key] === value)) Object.assign(row, patch);
  }
  public async remove(_table: string, query: Record<string, unknown>): Promise<void> {
    for (let index = this.rows.length - 1; index >= 0; index--)
      if (Object.entries(query).every(([key, value]) => this.rows[index]![key] === value)) this.rows.splice(index, 1);
  }
}

const context = { type: "guild", platform: "test", channelId: "room", guildId: "room" } as const;

function seed(id: string, content: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: "fact",
    content,
    scope: "shared",
    channelType: null,
    platform: null,
    guildId: null,
    channelId: null,
    selfId: null,
    userId: null,
    importance: 0.5,
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: 0,
    updatedAt: 0,
    lastAccessedAt: 0,
    accessCount: 0,
    forgottenAt: null,
    embedding: null,
    embeddingModel: null,
    ...overrides,
  };
}

function createStore(rows: Record<string, unknown>[], options = {}) {
  const model = new Model();
  model.rows.push(...rows);
  return new MemoryStore({ model } as never, options);
}

describe("MemoryStore embedding index", () => {
  it("vectorises content and tags when a memory is created", async () => {
    const model = new Model();
    const store = new MemoryStore({ model } as never, { indexer: fakeIndexer() });

    const memory = await store.create({
      type: "preference",
      content: "张三喜欢咖啡",
      scope: "shared",
      importance: 0.8,
      confidence: 0.9,
      tags: ["偏好"],
    });

    expect(memory.embedding).toEqual([1, 0, 0]);
    expect(memory.embeddingModel).toBe("toy-v1");
    expect(model.rows[0]!.embedding).toEqual([1, 0, 0]);
  });

  it("still writes the memory when the embedding model is unavailable", async () => {
    const model = new Model();
    const store = new MemoryStore({ model } as never, { indexer: { modelId: "down", embed: async () => undefined } });

    const memory = await store.create({ type: "fact", content: "张三喜欢咖啡", scope: "shared", importance: 0.8, confidence: 0.9, tags: [] });

    expect(memory.embedding).toBeUndefined();
    expect((await store.get(memory.id))?.content).toBe("张三喜欢咖啡");
    expect(model.rows[0]!.embedding).toBeNull();
  });

  it("re-vectorises on content edits and leaves the vector alone otherwise", async () => {
    const indexer = fakeIndexer();
    const model = new Model();
    const store = new MemoryStore({ model } as never, { indexer });
    const memory = await store.create({ type: "fact", content: "张三喜欢咖啡", scope: "shared", importance: 0.8, confidence: 0.9, tags: [] });
    indexer.calls.length = 0;

    await store.update(memory.id, { importance: 0.4 });
    expect(indexer.calls).toEqual([]);
    expect((await store.get(memory.id))?.embedding).toEqual([1, 0, 0]);

    await store.update(memory.id, { content: "张三喜欢吉他" });
    expect((await store.get(memory.id))?.embedding).toEqual([0, 1, 0]);
    expect(indexer.calls).toEqual(["张三喜欢吉他"]);
  });

  it("clears a stale vector when content changes without an embedding model", async () => {
    const store = createStore([seed("a", "张三喜欢咖啡", { embedding: [1, 0, 0], embeddingModel: "toy-v1" })]);

    await store.update("a", { content: "张三喜欢吉他" });

    expect((await store.get("a"))?.embedding).toBeUndefined();
    expect((await store.get("a"))?.embeddingModel).toBeUndefined();
  });

  it("re-vectorises the canonical memory on merge", async () => {
    const store = createStore([seed("keep", "张三喜欢咖啡"), seed("drop", "张三爱喝咖啡")], { indexer: fakeIndexer() });

    const merged = await store.merge("keep", "drop", { content: "张三喜欢咖啡和吉他" });

    expect(merged.embedding).toEqual([1, 1, 0]);
    expect(await store.get("drop")).toBeUndefined();
  });
});

describe("MemoryStore semantic retrieval", () => {
  const rows = [
    seed("coffee-cn", "张三喜欢咖啡", { embedding: [1, 0, 0], embeddingModel: "toy-v1" }),
    seed("guitar", "张三弹吉他", { embedding: [0, 1, 0], embeddingModel: "toy-v1" }),
    seed("legacy", "张三爱喝咖啡", { embedding: null, embeddingModel: null }),
  ];

  it("recalls a memory that shares no keyword but is semantically close", async () => {
    const store = createStore(rows, { indexer: fakeIndexer() });

    const result = await store.searchVisible(context, [], { query: "coffee", semantic: true });

    expect(result.memories.map((memory) => memory.id)).toContain("coffee-cn");
    expect(result.semanticUsed).toBe(true);
  });

  it("keeps keyword-only behaviour when semantic is not requested", async () => {
    const store = createStore(rows, { indexer: fakeIndexer() });

    const result = await store.searchVisible(context, [], { query: "coffee" });

    expect(result.memories).toEqual([]);
    expect(result.semanticUsed).toBe(false);
  });

  it("does not recall unrelated memories just because semantic is on", async () => {
    const store = createStore(rows, { indexer: fakeIndexer() });

    const result = await store.searchVisible(context, [], { query: "coffee", semantic: true });

    expect(result.memories.map((memory) => memory.id)).not.toContain("guitar");
  });

  it("still recalls vectorless legacy memories through the keyword filter", async () => {
    const store = createStore([seed("legacy", "张三爱喝咖啡")], { indexer: fakeIndexer() });

    const result = await store.searchVisible(context, [], { query: "咖啡", semantic: true });

    expect(result.memories.map((memory) => memory.id)).toEqual(["legacy"]);
    expect(result.semanticUsed).toBe(false);
  });

  it("honours the minimum similarity threshold", async () => {
    const partial = [seed("partial", "张三喜欢咖啡和吉他", { embedding: [1, 1, 0], embeddingModel: "toy-v1" })];

    const lenient = createStore(partial, { indexer: fakeIndexer(), semantic: { minSimilarity: 0.35, boostWeight: 1 } });
    expect((await lenient.searchVisible(context, [], { query: "coffee", semantic: true })).memories).toHaveLength(1);

    const strict = createStore(partial, { indexer: fakeIndexer(), semantic: { minSimilarity: 0.9, boostWeight: 1 } });
    expect((await strict.searchVisible(context, [], { query: "coffee", semantic: true })).memories).toHaveLength(0);
  });

  it("ranks the closer match above the weaker one", async () => {
    const store = createStore(
      [
        seed("weaker", "张三喜欢咖啡和吉他", { embedding: [1, 1, 0], embeddingModel: "toy-v1" }),
        seed("closer", "张三喜欢咖啡", { embedding: [1, 0, 0], embeddingModel: "toy-v1" }),
      ],
      { indexer: fakeIndexer() },
    );

    const result = await store.searchVisible(context, [], { query: "coffee", semantic: true });

    expect(result.memories.map((memory) => memory.id)).toEqual(["closer", "weaker"]);
  });

  it("ignores vectors produced by a different embedding model", async () => {
    const store = createStore([seed("stale", "张三喜欢咖啡", { embedding: [1, 0, 0], embeddingModel: "other-model" })], { indexer: fakeIndexer() });

    const result = await store.searchVisible(context, [], { query: "coffee", semantic: true });

    expect(result.memories).toEqual([]);
    expect(result.semanticUsed).toBe(false);
  });

  it("falls back to keyword-only recall when the query cannot be embedded", async () => {
    const store = createStore([seed("a", "张三喜欢咖啡", { embedding: [1, 0, 0], embeddingModel: "toy-v1" })], {
      indexer: { modelId: "toy-v1", embed: async () => undefined },
    });

    const result = await store.searchVisible(context, [], { query: "咖啡", semantic: true });

    expect(result.memories.map((memory) => memory.id)).toEqual(["a"]);
    expect(result.semanticUsed).toBe(false);
  });

  it("applies the indexer query prefix to queries but never to stored documents", async () => {
    const indexer = fakeIndexer("toy-v1", "指令：");
    const store = createStore([], { indexer, semantic: { minSimilarity: 0.35, boostWeight: 1 } });

    await store.create({ type: "fact", content: "张三喜欢咖啡", scope: "shared", importance: 0.5, confidence: 1, tags: [] });
    expect(indexer.calls).toEqual(["张三喜欢咖啡"]);

    indexer.calls.length = 0;
    await store.searchVisible(context, [], { query: "coffee", semantic: true });
    expect(indexer.calls).toEqual(["指令：coffee"]);
  });

  it("keeps visibility and type filters authoritative over semantic recall", async () => {
    const store = createStore(
      [
        seed("coffee-cn", "张三喜欢咖啡", { embedding: [1, 0, 0], embeddingModel: "toy-v1" }),
        seed("private", "李四喜欢咖啡", { embedding: [1, 0, 0], embeddingModel: "toy-v1", scope: "user", platform: "test", userId: "lisi" }),
        seed("typed", "张三了解咖啡", { embedding: [1, 0, 0], embeddingModel: "toy-v1", type: "event" }),
      ],
      { indexer: fakeIndexer() },
    );

    const visible = await store.searchVisible(context, [], { query: "coffee", semantic: true });
    expect(visible.memories.map((memory) => memory.id)).toEqual(expect.arrayContaining(["coffee-cn"]));
    expect(visible.memories.map((memory) => memory.id)).not.toContain("private");

    const typed = await store.searchVisible(context, [], { query: "coffee", semantic: true, types: ["fact"] });
    expect(typed.memories.map((memory) => memory.id)).not.toContain("typed");
  });
});

describe("MemoryStore.reindex", () => {
  it("backfills missing and foreign-model vectors and reports what remains", async () => {
    const indexer = fakeIndexer();
    const store = createStore(
      [
        seed("missing", "张三喜欢咖啡"),
        seed("foreign", "张三弹吉他", { embedding: [1, 0, 0], embeddingModel: "old-model" }),
        seed("current", "张三写代码", { embedding: [0, 0, 1], embeddingModel: "toy-v1" }),
        seed("gone", "张三爱喝咖啡", { status: "forgotten", forgottenAt: 0 }),
      ],
      { indexer },
    );

    expect(await store.missingEmbeddings()).toBe(2);
    expect(await store.reindex()).toBe(2);

    expect((await store.get("missing"))?.embedding).toEqual([1, 0, 0]);
    expect((await store.get("missing"))?.embeddingModel).toBe("toy-v1");
    expect((await store.get("foreign"))?.embedding).toEqual([0, 1, 0]);
    expect((await store.get("current"))?.embedding).toEqual([0, 0, 1]);
    expect((await store.get("gone"))?.embedding).toBeUndefined();
    expect(await store.missingEmbeddings()).toBe(0);
  });

  it("respects the batch limit and survives an unavailable model", async () => {
    const store = createStore([seed("a", "张三喜欢咖啡"), seed("b", "张三弹吉他")], { indexer: fakeIndexer() });
    expect(await store.reindex(1)).toBe(1);
    expect(await store.missingEmbeddings()).toBe(1);

    const broken = createStore([seed("c", "张三喜欢咖啡")], { indexer: { modelId: "toy-v1", embed: async () => undefined } });
    expect(await broken.reindex()).toBe(0);
    expect(await broken.missingEmbeddings()).toBe(1);
  });

  it("does nothing without an embedding model", async () => {
    const store = createStore([seed("d", "张三喜欢咖啡")]);
    expect(await store.reindex()).toBe(0);
    expect(await store.missingEmbeddings()).toBe(0);
  });
});
