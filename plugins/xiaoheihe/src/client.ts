import type { Context } from "koishi";
import { connectMcpServer, type McpServer } from "koishi-plugin-yesimbot-mcp-client/transports";

import { decodeResult, identifier, normalizePost, normalizePosts, normalizeReceipt, record } from "./protocol.js";
import type { PostSummary, XiaoheiheApi } from "./types.js";

const REQUIRED_TOOLS = [
  "check_login_status",
  "get_home_content",
  "get_user_profile",
  "search_content",
  "get_post_detail",
  "publish_content",
  "post_comment",
  "reply_comment",
];

export async function connectXiaoheihe(ctx: Context, server: McpServer, browseCommunities: string[] = []): Promise<XiaoheiheApi> {
  const communities = [...new Set(browseCommunities)];
  const { client, transport } = await connectMcpServer(ctx, "xiaoheihe-adapter", server);
  const close = async () => {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  };
  try {
    const catalog = await client.listTools();
    const required = communities.length ? [...REQUIRED_TOOLS, "get_community_content"] : REQUIRED_TOOLS;
    if (required.some((name) => !catalog.tools.some((tool) => tool.name === name))) throw new Error("missing_xiaoheihe_tools");
  } catch {
    await close();
    throw new Error("invalid_xiaoheihe_catalog");
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    try {
      return decodeResult(await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 }));
    } catch {
      throw new Error("xiaoheihe_upstream_failed");
    }
  };
  return {
    async login() {
      const data = await call("check_login_status");
      if (data.authenticated !== true || data.stored !== true) throw new Error("authentication_required");
      return { userId: identifier(data.user_id), ...(typeof data.username === "string" ? { username: data.username.slice(0, 100) } : {}) };
    },
    async feed(limit) {
      if (!communities.length) return normalizePosts(await call("get_home_content", { limit, offset: 0 })).slice(0, limit);
      const feeds: PostSummary[][] = [];
      for (const community of communities) {
        feeds.push(
          normalizePosts(await call("get_community_content", { community, limit }))
            .slice(0, limit)
            .map((post) => ({
              ...post,
              source: `community:${community}`,
            })),
        );
      }
      const posts: PostSummary[] = [];
      const seen = new Set<string>();
      for (let round = 0; round < limit && posts.length < limit; round++) {
        for (const feed of feeds) {
          const post = feed.find((post) => !seen.has(post.id));
          if (!post) continue;
          seen.add(post.id);
          posts.push(post);
          if (posts.length === limit) break;
        }
      }
      return posts;
    },
    async profile(limit) {
      const data = await call("get_user_profile", { pageSize: limit });
      return { userId: identifier(record(data.user).userid), posts: normalizePosts(data).slice(0, limit) };
    },
    async search(keyword, limit) {
      return normalizePosts(await call("search_content", { keyword, kind: "post", limit, offset: 0 })).slice(0, limit);
    },
    async post(id) {
      return normalizePost(await call("get_post_detail", { postId: identifier(id) }), id);
    },
    async publish(title, content, communities) {
      return normalizeReceipt(await call("publish_content", { title, content, communities, images: [], tags: [], draft: false, dry_run: false }), "post");
    },
    async comment(postId, content, targetText) {
      return normalizeReceipt(
        await call(targetText === undefined ? "post_comment" : "reply_comment", {
          postId: identifier(postId),
          content,
          dry_run: false,
          ...(targetText === undefined ? { images: [] } : { targetCommentContent: targetText }),
        }),
        "interaction",
      );
    },
    close,
  };
}
