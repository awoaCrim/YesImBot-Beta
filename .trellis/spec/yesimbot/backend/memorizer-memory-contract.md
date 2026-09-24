# Memorizer Long-Term Memory Contract

## 1. Scope / Trigger

Use this contract whenever YesImBot's `plugins/memorizer` changes memory persistence, embedding indexing, retrieval ranking, or the agent-facing `remember` / `recall` / `search` tools.

Memorizer is the single long-term memory owner in production. `plugins/memos-client` and the MemOS-specific QQ import CLI were removed; do not reintroduce a second memory backend that competes for the same write path.

## 2. Signatures

```ts
interface EmbeddingIndexer {
  readonly modelId: string;
  readonly queryPrefix: string; // derived from modelId unless overridden
  embed(text: string): Promise<number[] | undefined>; // never throws
}

const EMBEDDING_INPUT_CHAR_BUDGET = 450;

interface SemanticOptions {
  minSimilarity: number; // config semanticMinSimilarity, default 0.35
  boostWeight: number; // config semanticBoostWeight, default 1
}

interface MemoryQuery {
  query?: string;
  tags?: string[];
  scopes?: MemoryScope[];
  types?: MemoryType[];
  limit?: number;
  semantic?: boolean;
  halfLifeDays?: number;
}

class MemoryStore {
  constructor(ctx: Context, options?: { indexer?: EmbeddingIndexer; semantic?: SemanticOptions; halfLifeDays?: number });
  searchVisible(context, userIds, query): Promise<{ memories: Memory[]; semanticUsed: boolean }>;
  queryVisible(context, userIds, query): Promise<Memory[]>; // delegates, returns memories only
  reindex(limit?: number): Promise<number>; // REINDEX_BATCH = 64
  missingEmbeddings(): Promise<number>;
}
```

`memoryEmbeddingText(memory)` = trimmed `content` + newline-joined trimmed `tags`, **capped at `EMBEDDING_INPUT_CHAR_BUDGET`**. Every stored document vector MUST be produced through this helper so a vector always describes the same text the query path expects.

The cap is not an optimisation. `BAAI/bge-large-zh-v1.5` accepts 512 input tokens and SiliconFlow **rejects** longer input with `code 20015` rather than truncating it, so an unbounded document text makes the whole embed call fail and silently leaves that memory without a vector. Stored content keeps full detail; only the vector covers the head.

## 3. Contracts

- The indexer resolves the embedding model on every call (`resolve()`), so a re-registered provider is picked up without restarting.
- Query vectors embed `indexer.queryPrefix + trimmed query`. Stored documents never receive the prefix.
- The prefix belongs to the **model**, not to the retrieval tuning knobs: `autoQueryPrefix(modelId)` returns `为这个句子生成表示以用于检索相关文章：` for the `bge-{tiny,small,base,large}-zh` families and `""` for everything else, so switching to a model that does not expect an instruction cannot leave a stale prefix corrupting every query vector. `semanticQueryPrefix` overrides the derivation; setting it to `""` disables the instruction explicitly.
- A stored vector is usable only when `memory.embeddingModel === indexer.modelId`. Vectors from another model are ignored for scoring and are reindex candidates.
- Ranking in both modes: `retentionScore(memory, now, halfLifeDays) * confidence`, where `halfLifeDays` comes from the store configuration, never a hard-coded constant.
- Semantic ranking: `retention * confidence * (1 + boostWeight * max(0, cosineSimilarity))`.
- `reindex()` runs after every maintenance sweep (plugin start, then every 24 h) and backfills at most `REINDEX_BATCH` active memories per run, oldest selection first by table order.

## 4. Validation & Error Matrix

| Condition                                                                | Required result                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Embedding model unavailable during `create`                              | memory is still written; `embedding`/`embeddingModel` stay `null`               |
| Embedding model unavailable during `update`/`merge` with changed content | stale vector is **cleared**, never kept                                         |
| Content and tags unchanged on `update`                                   | no embedding call, vector untouched                                             |
| No indexer configured and content changes                                | stale vector is cleared                                                         |
| `semantic: true` without `query` text                                    | keyword-only path, `semanticUsed: false`                                        |
| `semantic: true` with no configured indexer                              | keyword-only path, `semanticUsed: false`                                        |
| Query embedding call fails                                               | keyword-only fallback, `semanticUsed: false`                                    |
| No candidate has a usable vector                                         | `semanticUsed: false`                                                           |
| Vector produced by a different `embeddingModel`                          | ignored for scoring; counted by `missingEmbeddings()`                           |
| `reindex` partially fails (model down mid-run)                           | already-indexed rows persist, remainder retried on next sweep                   |
| Document text exceeds the embedding input budget                         | text is truncated to the budget before the call; the memory still gets a vector |
| `scope` / `type` / participant-visibility filter                         | applied **before** similarity scoring; semantic recall never widens visibility  |

## 5. Good / Base / Bad Cases

### Good

A memory stores "张三喜欢咖啡". `recall({ query: "coffee", semantic: true })` returns it even though the keyword never appears, because the query vector is similar and passes `minSimilarity`.

### Base

Embedding model is unconfigured. `recall` behaves exactly as before this feature: keyword substring + tag filtering ranked by retention.

### Bad

`semantic: true` is requested, the embedding endpoint is down, and the tool reports `semanticUsed: true`. This is forbidden: the flag MUST reflect that vectors actually participated, so operators can tell a silent degradation from real semantic recall.

## 6. Tests Required

- `semantic.test.ts`: tag-aware document text, cosine edge cases (length mismatch, empty, zero norm), model-id gating, failure degrades to `undefined`, empty text skips the model call, the query instruction follows the bge-zh family and stays empty for `bge-m3` / English / OpenAI models, and an explicit override (including `""`) wins over the model.
- `semantic-search.test.ts`: create writes a vector; unavailable model still writes the memory; content edit re-vectorises and non-content edit does not; stale vector cleared when content changes without an indexer; merge re-vectorises the canonical row; semantic recall of a keyword-free memory; keyword-only behaviour unchanged; unrelated memory not recalled; `minSimilarity` respected; closer vector ranks higher; foreign-model vectors ignored; query-embed failure falls back to keywords; visibility and type filters stay authoritative; the indexer prefix applies to queries only; `reindex` backfills missing and foreign vectors, respects the batch limit, survives an unavailable model, and no-ops without an indexer.
- `recall.test.ts`: the tool forwards `semantic` to the store and reports `semanticUsed` from the store result rather than probing the model itself.

## 7. Wrong vs Correct

### Wrong

```ts
// A probe that proves the model is reachable, then throws the vector away.
if (input.semantic && options.embeddingModel && input.query) {
  await embed({ model: options.embeddingModel, value: input.query });
  semanticUsed = true;
}
const memories = await store.queryVisible(context, userIds, { query: input.query });
```

This reports `semanticUsed: true` while retrieval is still keyword-only, and the same query text is never compared against stored vectors.

### Correct

```ts
// The store owns both vectors and reports what actually participated.
const result = await store.searchVisible(context, userIds, { query: input.query, semantic: true });
return { memories: result.memories, semanticUsed: result.semanticUsed };
```

Likewise, never keep a vector after its document text changed:

```ts
// Wrong: the vector now describes removed text.
if (!this.indexer) return {};

// Correct: clear it so scoring cannot use a stale vector.
if (!this.indexer) return { embedding: undefined, embeddingModel: undefined };
```

And never treat the query instruction as a global tuning string:

```ts
// Wrong: it survives a model switch and keeps prepending a Chinese instruction
// to every query for a model that never expects one.
queryPrefix: config.semanticQueryPrefix ?? "为这个句子生成表示以用于检索相关文章：";

// Correct: the instruction is looked up from the model that produced the vectors.
queryPrefix: config.semanticQueryPrefix; // undefined => autoQueryPrefix(modelId)
```

## 8. Production Verification (2026-09-04)

Verified against the live deployment through a one-shot in-process hook (real plugin instance, real model registry, real SQLite, real embedding API), then removed:

- `queryPrefix` resolved to `为这个句子生成表示以用于检索相关文章：` from `siliconflow-embedding:BAAI/bge-large-zh-v1.5`, and a probe returned a 1024-dimension vector, proving `resolveEmbedding` works inside the running process rather than only over raw HTTP.
- Three seeded memories each persisted a 1024-dimension vector tagged with the correct `embeddingModel`.
- `coffee` / `electric guitar` / `programming language` each recalled the right memory with `semanticUsed: true`, while the keyword-only path returned **nothing** for all three — that cross-lingual gap is exactly what this feature exists to close.
- The control query `明天会不会下雨` recalled nothing, so `minSimilarity` rejects unrelated memories instead of always returning nearest neighbours.
- Seeded rows were deleted afterwards (`yesimbot_memory` back to 0 rows) and the final deployed build logs no selftest lines.
