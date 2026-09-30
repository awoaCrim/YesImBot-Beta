import { embed, type EmbeddingModel } from "ai";

import type { Memory } from "./types.js";

/**
 * Character budget for embedding input. bge-large-zh-v1.5 caps input at 512
 * tokens and SiliconFlow rejects (rather than truncates) anything longer, so an
 * unbounded document text fails the whole embed call and leaves the memory
 * without a vector. ~1 token per CJK character, so 450 chars stays inside.
 */
export const EMBEDDING_INPUT_CHAR_BUDGET = 450;

/**
 * Embedding families that expect an instruction in front of the query and not
 * in front of the documents. Matching on the model id keeps the instruction
 * tied to the model, so switching to a model that does not expect one cannot
 * leave a stale prefix corrupting every query vector.
 */
const QUERY_INSTRUCTIONS: readonly { pattern: RegExp; prefix: string }[] = [
  { pattern: /bge-(tiny|small|base|large)-zh/i, prefix: "为这个句子生成表示以用于检索相关文章：" },
];

/**
 * Computes memory vectors and query vectors. `embed` never throws: an
 * unavailable embedding model must degrade to keyword-only retrieval instead of
 * failing memory writes.
 */
export interface EmbeddingIndexer {
  readonly modelId: string;
  /**
   * Instruction prepended to queries only, never to stored documents. Derived
   * from the model family unless the operator overrode it explicitly.
   */
  readonly queryPrefix: string;
  embed(text: string): Promise<number[] | undefined>;
}

export interface EmbeddingIndexerOptions {
  readonly modelId: string;
  /** Resolved per call so a re-registered provider is picked up immediately. */
  resolve(): EmbeddingModel;
  /** Overrides model-derived retrieval; `""` disables the instruction entirely. */
  queryPrefix?: string;
  warn?(event: string, fields: Record<string, unknown>): void;
}

/** The retrieval instruction a model expects on the query side, if any. */
export function autoQueryPrefix(modelId: string): string {
  return QUERY_INSTRUCTIONS.find((entry) => entry.pattern.test(modelId))?.prefix ?? "";
}

/**
 * Text used to build a memory's stored vector. Both the write path and the
 * reindex path must use this helper so an existing vector always describes the
 * same text the query path expects. The result is capped to the embedding
 * input budget: stored content keeps full detail, the vector covers the head.
 */
export function memoryEmbeddingText(memory: { content: string; tags: readonly string[] }): string {
  const text = [memory.content.trim(), ...memory.tags.map((tag) => tag.trim())].filter(Boolean).join("\n");
  return text.length > EMBEDDING_INPUT_CHAR_BUDGET ? text.slice(0, EMBEDDING_INPUT_CHAR_BUDGET).trimEnd() : text;
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function createEmbeddingIndexer(options: EmbeddingIndexerOptions): EmbeddingIndexer {
  return {
    modelId: options.modelId,
    queryPrefix: options.queryPrefix ?? autoQueryPrefix(options.modelId),
    async embed(text) {
      const value = text.trim();
      if (!value) return undefined;
      try {
        const result = await embed({ model: options.resolve(), value, maxRetries: 0 });
        return result.embedding.length > 0 ? [...result.embedding] : undefined;
      } catch (cause) {
        options.warn?.("memorizer.embedding_failed", {
          model: options.modelId,
          cause: cause instanceof Error ? cause.message : String(cause),
        });
        return undefined;
      }
    },
  };
}

/** A stored vector is only usable when it was produced by the current model. */
export function usableEmbedding(memory: Pick<Memory, "embedding" | "embeddingModel">, modelId: string): readonly number[] | undefined {
  return memory.embedding && memory.embeddingModel === modelId ? memory.embedding : undefined;
}
