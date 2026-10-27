import argparse
import logging

from mcp.types import ToolAnnotations
from pydantic import StrictInt
from xhh_operator.http import HeyboxAPI
from xhh_operator.mcp_server import create_server
from xhh_operator.selections import resolve_selections
from xhh_operator.session import SessionStore, safe_result


def main():
    parser = argparse.ArgumentParser(description="小黑盒社区只读 feed MCP 包装")
    parser.add_argument("--transport", choices=["stdio"], default="stdio")
    parser.parse_args()
    logging.getLogger("httpx").setLevel(logging.CRITICAL)
    server = create_server()

    @server.tool(
        name="get_community_content",
        annotations=ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=True,
        ),
    )
    async def get_community_content(community: str, limit: StrictInt = 10) -> dict:
        """按精确社区名读取热帖，不发布内容，不以普通关键词搜索替代社区 feed。"""
        if not community.strip() or len(community) > 100 or not 1 <= limit <= 100:
            raise ValueError("invalid_community_feed_request")
        try:
            session = SessionStore().require()
            async with HeyboxAPI(session["cookies"]) as api:
                selection = await resolve_selections(api, communities=[community])
                response = await api.request(
                    "/bbs/app/topic/feeds",
                    params={
                        "topic_id": selection["topic_ids"],
                        "lastval": "",
                        "dw": 720,
                        "offset": 0,
                        "limit": limit,
                    },
                )
            result = response.get("result")
            if not isinstance(result, dict) or not isinstance(result.get("links"), list):
                raise ValueError("invalid_community_feed")
            topic_id = selection["topic_ids"]
            links = []
            for item in result["links"]:
                if not isinstance(item, dict):
                    continue
                post = item.get("link", item)
                if isinstance(post, dict) and any(
                    isinstance(topic, dict) and str(topic.get("topic_id")) == topic_id
                    for topic in post.get("topics", [])
                ):
                    links.append(item)
            return safe_result({"status": "ok", "result": {"links": links[:limit]}})
        except Exception:
            raise ValueError("community_feed_failed") from None

    server.run(transport="stdio")


if __name__ == "__main__":
    main()
