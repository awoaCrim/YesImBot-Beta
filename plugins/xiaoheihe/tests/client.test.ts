import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("koishi-plugin-yesimbot-mcp-client/transports", () => ({ connectMcpServer: mocks.connect }));
import { connectXiaoheihe } from "../src/client.js";
const names = [
  "check_login_status",
  "get_home_content",
  "get_user_profile",
  "search_content",
  "get_post_detail",
  "publish_content",
  "post_comment",
  "reply_comment",
];
function fixture() {
  const client = {
    listTools: vi.fn(async () => ({ tools: names.map((name) => ({ name })) })),
    callTool: vi.fn(async () => ({ structuredContent: { accepted: true, verified: true, link_id: "post", comment_id: "comment", is_draft: false } })),
    close: vi.fn(async () => {}),
  };
  const transport = { close: vi.fn(async () => {}) };
  mocks.connect.mockResolvedValue({ client, transport });
  return { client, transport };
}
describe("fixed MCP operations", () => {
  it("requires the community tool only for targeted browsing", async () => {
    const { client } = fixture();
    await expect(connectXiaoheihe({} as never, { type: "stdio", command: "stub" }, ["AI"])).rejects.toThrow("invalid_xiaoheihe_catalog");
    expect(client.close).toHaveBeenCalledOnce();
  });
  it("fairly merges configured community feeds and deduplicates posts without reading home", async () => {
    const { client } = fixture();
    client.listTools.mockResolvedValue({ tools: [...names, "get_community_content"].map((name) => ({ name })) });
    client.callTool.mockImplementation(
      async (call) =>
        ({
          structuredContent: {
            status: "ok",
            result: {
              links: (call.arguments.community === "AI" ? ["shared", "ai"] : ["shared", "chat"]).map((linkid) => ({ linkid, userid: "user", title: linkid })),
            },
          },
        }) as never,
    );
    const api = await connectXiaoheihe({} as never, { type: "stdio", command: "stub" }, ["AI", "盒友杂谈", "AI"]);
    expect((await api.feed(3)).map((post) => [post.id, post.source])).toEqual([
      ["shared", "community:AI"],
      ["chat", "community:盒友杂谈"],
      ["ai", "community:AI"],
    ]);
    expect(client.callTool.mock.calls.map(([call]) => call.name)).toEqual(["get_community_content", "get_community_content"]);
    await api.close();
  });
  it("uses explicit live flags only for approved posting and replying operations", async () => {
    const { client } = fixture();
    const api = await connectXiaoheihe({} as never, { type: "stdio", command: "stub" });
    await api.publish("title", "content", ["community"]);
    await api.comment("p", "comment");
    await api.comment("p", "reply", "target");
    expect(client.callTool.mock.calls.map(([call]) => call)).toEqual([
      {
        name: "publish_content",
        arguments: { title: "title", content: "content", communities: ["community"], images: [], tags: [], draft: false, dry_run: false },
      },
      { name: "post_comment", arguments: { postId: "p", content: "comment", images: [], dry_run: false } },
      { name: "reply_comment", arguments: { postId: "p", content: "reply", targetCommentContent: "target", dry_run: false } },
    ]);
    await api.close();
  });
  it("requires the full supported catalog and closes a rejected connection", async () => {
    const { client, transport } = fixture();
    client.listTools.mockResolvedValue({ tools: [] });
    await expect(connectXiaoheihe({} as never, { type: "stdio", command: "stub" })).rejects.toThrow("invalid_xiaoheihe_catalog");
    expect(client.close).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
  });
  it("never retries a timed-out write or exposes remote error text", async () => {
    const { client } = fixture();
    const api = await connectXiaoheihe({} as never, { type: "stdio", command: "stub" });
    client.callTool.mockRejectedValue(new Error("SECRET_TOKEN timeout"));
    await expect(api.publish("title", "body", [])).rejects.toThrow("xiaoheihe_upstream_failed");
    expect(client.callTool).toHaveBeenCalledOnce();
    await api.close();
  });
});
