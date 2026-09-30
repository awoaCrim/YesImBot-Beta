import { describe, expect, it } from "vitest";

import {
  autoQueryPrefix,
  cosineSimilarity,
  createEmbeddingIndexer,
  EMBEDDING_INPUT_CHAR_BUDGET,
  memoryEmbeddingText,
  usableEmbedding,
} from "../src/semantic.js";

const BGE_INSTRUCTION = "为这个句子生成表示以用于检索相关文章：";

describe("query-side retrieval instruction", () => {
  it("follows the bge-zh family that expects a query-only instruction", () => {
    expect(autoQueryPrefix("siliconflow-embedding:BAAI/bge-large-zh-v1.5")).toBe(BGE_INSTRUCTION);
    expect(autoQueryPrefix("BAAI/bge-base-zh-v1.5")).toBe(BGE_INSTRUCTION);
    expect(autoQueryPrefix("BAAI/bge-small-zh-v1.5")).toBe(BGE_INSTRUCTION);
  });

  it("stays empty for models that do not expect an instruction", () => {
    expect(autoQueryPrefix("BAAI/bge-m3")).toBe("");
    expect(autoQueryPrefix("BAAI/bge-large-en-v1.5")).toBe("");
    expect(autoQueryPrefix("text-embedding-3-small")).toBe("");
    expect(autoQueryPrefix("")).toBe("");
  });

  it("binds the indexer prefix to its own model id", () => {
    const zh = createEmbeddingIndexer({ modelId: "BAAI/bge-large-zh-v1.5", resolve: () => undefined as never });
    const other = createEmbeddingIndexer({ modelId: "BAAI/bge-m3", resolve: () => undefined as never });
    expect(zh.queryPrefix).toBe(BGE_INSTRUCTION);
    expect(other.queryPrefix).toBe("");
  });

  it("lets an explicit prefix override the model, including an explicit empty one", () => {
    const custom = createEmbeddingIndexer({ modelId: "BAAI/bge-large-zh-v1.5", queryPrefix: "q: ", resolve: () => undefined as never });
    const disabled = createEmbeddingIndexer({ modelId: "BAAI/bge-large-zh-v1.5", queryPrefix: "", resolve: () => undefined as never });
    expect(custom.queryPrefix).toBe("q: ");
    expect(disabled.queryPrefix).toBe("");
  });
});

describe("semantic helpers", () => {
  it("embeds content together with its tags so tags carry retrieval signal", () => {
    expect(memoryEmbeddingText({ content: "  张三喜欢咖啡  ", tags: [" 偏好 ", "", " 饮食 "] })).toBe("张三喜欢咖啡\n偏好\n饮食");
  });

  it("caps the embedded text at the model input budget instead of letting the call fail", () => {
    const long = "记".repeat(EMBEDDING_INPUT_CHAR_BUDGET + 400);
    const text = memoryEmbeddingText({ content: long, tags: ["标签"] });
    expect(text.length).toBeLessThanOrEqual(EMBEDDING_INPUT_CHAR_BUDGET);
    expect(text.startsWith("记".repeat(50))).toBe(true);
  });

  it("leaves text that already fits the budget untouched", () => {
    expect(memoryEmbeddingText({ content: "张三喜欢咖啡", tags: ["偏好"] })).toBe("张三喜欢咖啡\n偏好");
  });

  it("computes cosine similarity and fails closed on mismatched or empty vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([2, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("only reuses a vector produced by the current embedding model", () => {
    expect(usableEmbedding({ embedding: [1], embeddingModel: "a" }, "a")).toEqual([1]);
    expect(usableEmbedding({ embedding: [1], embeddingModel: "b" }, "a")).toBeUndefined();
    expect(usableEmbedding({}, "a")).toBeUndefined();
  });

  it("degrades to undefined instead of throwing when the model is unavailable", async () => {
    const warnings: Array<[string, Record<string, unknown>]> = [];
    const indexer = createEmbeddingIndexer({
      modelId: "broken",
      resolve: () => {
        throw new Error("provider not found");
      },
      warn: (event, fields) => warnings.push([event, fields]),
    });

    await expect(indexer.embed("hello")).resolves.toBeUndefined();
    expect(indexer.modelId).toBe("broken");
    expect(warnings[0]?.[0]).toBe("memorizer.embedding_failed");
    expect(JSON.stringify(warnings)).not.toContain("hello");
  });

  it("skips empty text without calling the model", async () => {
    let calls = 0;
    const indexer = createEmbeddingIndexer({
      modelId: "toy",
      resolve: () =>
        ({
          doEmbed: () => {
            calls += 1;
            return { embedding: [1] };
          },
        }) as never,
    });

    await expect(indexer.embed("   ")).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });
});
