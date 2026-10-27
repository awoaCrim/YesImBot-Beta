import type { Comment, PostDetail, PostSummary, Receipt } from "./types.js";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_mcp_result");
  return value as Record<string, unknown>;
}

export function identifier(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("invalid_identifier");
  if (typeof value !== "string" && typeof value !== "number") throw new Error("invalid_identifier");
  const id = String(value);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("invalid_identifier");
  return id;
}

export function decodeResult(value: unknown): Record<string, unknown> {
  const result = record(value);
  if (result.isError) throw new Error("upstream_failed");
  let data: Record<string, unknown>;
  if (result.structuredContent !== undefined) data = record(result.structuredContent);
  else {
    const blocks = result.content;
    if (!Array.isArray(blocks) || blocks.length !== 1) throw new Error("invalid_mcp_result");
    const block = record(blocks[0]);
    if (block.type !== "text" || typeof block.text !== "string" || block.text.length > 2_000_000) throw new Error("invalid_mcp_result");
    try {
      data = record(JSON.parse(block.text));
    } catch {
      throw new Error("invalid_mcp_result");
    }
  }
  if (data.status !== undefined && data.status !== "ok") throw new Error("upstream_failed");
  return data;
}

export function normalizePosts(value: unknown): PostSummary[] {
  const data = record(value);
  const result = data.result === undefined ? data : record(data.result);
  const items = data.posts ?? result.links ?? result.link_list ?? result.list ?? result.items;
  if (!Array.isArray(items)) throw new Error("invalid_post_list");
  return items.slice(0, 100).flatMap((value) => {
    const item = record(value);
    const post = item.link ? record(item.link) : item.info ? record(item.info) : item;
    return post.linkid === undefined && post.link_id === undefined ? [] : [summary(post)];
  });
}

export function normalizePost(value: unknown, expectedId: string): PostDetail {
  const result = record(record(value).result);
  const link = record(result.link);
  const post = summary(link);
  if (post.id !== expectedId) throw new Error("post_identity_mismatch");
  let body = text(link.text);
  if (body.startsWith("[")) {
    try {
      const blocks: unknown = JSON.parse(body);
      if (Array.isArray(blocks))
        body = blocks
          .slice(0, 100)
          .map((value) => {
            const block = record(value);
            return block.type === "text" || block.type === "html" ? text(block.text) : "";
          })
          .filter(Boolean)
          .join("\n")
          .slice(0, 20000);
    } catch {
      /* The original string remains untrusted post text. */
    }
  }
  const comments: Comment[] = [];
  if (!Array.isArray(result.comments)) throw new Error("invalid_comment_list");
  let complete = result.has_more_floors === 0 && result.total_page === 1;
  for (const value of result.comments.slice(0, 100)) {
    const floor = record(value);
    if (!Array.isArray(floor.comment) || !floor.comment.length) continue;
    const rootId = identifier(record(floor.comment[0]).commentid);
    for (const value of floor.comment.slice(0, 100)) {
      if (comments.length >= 100) {
        complete = false;
        break;
      }
      const c = record(value);
      if (c.has_more) complete = false;
      const reply = c.replyid ?? c.reply_id;
      comments.push({
        id: identifier(c.commentid),
        authorId: identifier(c.userid ?? record(c.user).userid),
        text: text(c.text, 2000),
        rootId,
        ...(reply === undefined || reply === null || String(reply) === "-1" ? {} : { replyToId: identifier(reply) }),
      });
    }
  }
  return { ...post, text: body, comments, commentsComplete: complete };
}

export function normalizeReceipt(value: unknown, kind: "post" | "interaction"): Receipt {
  const data = record(value);
  if (data.dry_run === true || data.is_draft === true || typeof data.accepted !== "boolean" || typeof data.verified !== "boolean")
    throw new Error("invalid_publication_receipt");
  const id = kind === "post" ? data.link_id : data.comment_id;
  return {
    accepted: data.accepted,
    verified: data.verified && (kind !== "post" || data.is_draft === false),
    ...(id === undefined || id === null ? {} : { id: identifier(id) }),
  };
}

function text(value: unknown, max = 20000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function summary(value: unknown): PostSummary {
  const p = record(value);
  return {
    id: identifier(p.linkid ?? p.link_id),
    authorId: identifier(p.userid ?? record(p.user).userid),
    title: text(p.title, 200),
    text: text(p.description ?? p.text, 1000),
  };
}
