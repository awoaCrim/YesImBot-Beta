import { describe, expect, it } from "vitest";

import { decodeResult, normalizePost, normalizePosts, normalizeReceipt, identifier } from "../src/protocol.js";

describe("MCP protocol boundary", () => {
  it("accepts JSON text and structured content without returning raw envelopes", () => {
    expect(decodeResult({ content: [{ type: "text", text: '{"authenticated":true}' }] })).toEqual({ authenticated: true });
    expect(decodeResult({ structuredContent: { accepted: true } })).toEqual({ accepted: true });
    expect(() => decodeResult({ isError: true, content: [{ type: "text", text: "SECRET_COOKIE" }] })).toThrow("upstream_failed");
    expect(() => decodeResult({ content: [{ type: "text", text: "SECRET_COOKIE" }] })).toThrow("invalid_mcp_result");
  });
  it("normalizes real feed/profile shapes and rejects unsafe IDs", () => {
    expect(normalizePosts({ result: { links: [{ linkid: 12, userid: 34, title: "title", description: "body", cookie: "secret" }] } })).toEqual([
      { id: "12", authorId: "34", title: "title", text: "body" },
    ]);
    expect(normalizePosts({ posts: [{ linkid: "p", userid: "u" }] })).toHaveLength(1);
    expect(() => identifier(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => identifier("../private")).toThrow();
    expect(() => normalizePosts({ unexpected: [] })).toThrow();
  });
  it("preserves floor roots and checks the returned post identity", () => {
    const value = {
      result: {
        link: { linkid: 12, userid: 34, title: "title", text: '[{"type":"text","text":"hello"}]' },
        comments: [
          {
            comment: [
              { commentid: 1, userid: 2, text: "root" },
              { commentid: 3, userid: 4, text: "reply", reply_id: 1 },
            ],
          },
        ],
      },
    };
    expect(normalizePost(value, "12")).toMatchObject({
      id: "12",
      text: "hello",
      comments: [
        { id: "1", rootId: "1" },
        { id: "3", rootId: "1", replyToId: "1" },
      ],
    });
    expect(() => normalizePost(value, "13")).toThrow("post_identity_mismatch");
  });
  it("never promotes dry-run, draft, or unverified results to confirmed delivery", () => {
    expect(normalizeReceipt({ accepted: true, verified: true, link_id: 7, is_draft: false }, "post")).toEqual({ accepted: true, verified: true, id: "7" });
    expect(normalizeReceipt({ accepted: true, verified: false, comment_id: 8 }, "interaction")).toEqual({ accepted: true, verified: false, id: "8" });
    expect(() => normalizeReceipt({ dry_run: true, form: {} }, "post")).toThrow();
    expect(() => normalizeReceipt({ accepted: true, verified: true, link_id: 7, is_draft: true }, "post")).toThrow();
    expect(normalizeReceipt({ accepted: true, verified: true }, "post").id).toBeUndefined();
  });
});
