import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

it("uses the real community endpoint and excludes posts from other communities", () => {
  const file = fileURLToPath(new URL("../src/community-mcp.py", import.meta.url));
  const script = `
import asyncio, runpy, sys, types
registered = {}
for name in ['mcp', 'mcp.types', 'pydantic', 'xhh_operator', 'xhh_operator.http', 'xhh_operator.mcp_server', 'xhh_operator.selections', 'xhh_operator.session']:
    sys.modules[name] = types.ModuleType(name)
sys.modules['mcp.types'].ToolAnnotations = lambda **kw: None
sys.modules['pydantic'].StrictInt = int
class Server:
    def tool(self, **kw):
        def register(fn):
            registered[kw['name']] = fn
            return fn
        return register
    def run(self, transport):
        assert transport == 'stdio'
sys.modules['xhh_operator.mcp_server'].create_server = Server
class Store:
    def require(self): return {'cookies': []}
sys.modules['xhh_operator.session'].SessionStore = Store
sys.modules['xhh_operator.session'].safe_result = lambda value: value
async def resolve(api, communities):
    assert communities == ['AI']
    return {'topic_ids': '7'}
sys.modules['xhh_operator.selections'].resolve_selections = resolve
class API:
    def __init__(self, cookies): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def request(self, path, params):
        assert path == '/bbs/app/topic/feeds'
        assert params['topic_id'] == '7'
        assert params['offset'] == 0
        return {'status': 'ok', 'result': {'links': [{'linkid': 'yes', 'topics': [{'topic_id': 7}]}, {'linkid': 'no', 'topics': [{'topic_id': 8}]}, {'content_type': 'banner'}]}}
sys.modules['xhh_operator.http'].HeyboxAPI = API
file = sys.argv[1]
sys.argv = [file]
runpy.run_path(file, run_name='__main__')
async def check():
    result = await registered['get_community_content']('AI', 3)
    assert [post['linkid'] for post in result['result']['links']] == ['yes']
    for limit in [0, 101]:
        try: await registered['get_community_content']('AI', limit)
        except ValueError: pass
        else: raise AssertionError('invalid limit accepted')
asyncio.run(check())
`;
  const result = spawnSync("python3", ["-c", script, file], { encoding: "utf8", timeout: 10000 });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
