"""Per-page frontend version handshake over ComfyUI's existing websocket."""
import asyncio
import contextlib
import hashlib
import json
from pathlib import Path

from aiohttp import web
from server import PromptServer

ROOT = Path(__file__).parent
INTERVAL = 5


class Versions:
    def __init__(self, root):
        self.root = root
        # Backend changes take effect on restart, not merely when a file is saved.
        self.backend = self.digest(sorted(root.glob('*.py')))
        self.signature = None
        self.current = None

    @staticmethod
    def digest(paths):
        digest = hashlib.sha256()
        for path in paths:
            digest.update(path.name.encode())
            digest.update(path.read_bytes())
        return digest.hexdigest()

    def version(self):
        paths = sorted(p for p in self.root.rglob('*')
                       if p.suffix in ('.js', '.css') and 'tests' not in p.parts and 'node_modules' not in p.parts)
        signature = tuple((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in paths)
        if signature != self.signature:
            self.current = hashlib.sha256((self.backend + self.digest(paths)).encode()).hexdigest()
            self.signature = signature
        return self.current


versions = Versions(ROOT)


async def version_module(request):
    version = await asyncio.to_thread(versions.version)
    return web.Response(text='export const version = '+json.dumps(version)+';\n',
                        content_type='application/javascript', headers={'Cache-Control': 'no-store'})


async def report_version(request):
    if request.content_type != 'application/json':
        return web.json_response({'error': '需要 JSON 请求'}, status=400)
    try:
        data = await request.json()
        client = data.get('client_id')
        if not isinstance(client, str) or client not in PromptServer.instance.sockets:
            return web.json_response({'error': '页面连接已失效'}, status=409)
        current = await asyncio.to_thread(versions.version)
        stale = data.get('version') != current
        if stale:
            PromptServer.instance.send_sync('liuxinyu.frontend_reload', {'version': current}, client)
        return web.json_response({'version': current, 'reload': stale}, headers={'Cache-Control': 'no-store'})
    except (ValueError, AttributeError):
        return web.json_response({'error': '版本报告无效'}, status=400)


async def lifecycle(app):
    async def poll():
        while True:
            await asyncio.sleep(INTERVAL)
            PromptServer.instance.send_sync('liuxinyu.frontend_version_query', {})
    task = asyncio.create_task(poll())
    yield
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


@web.middleware
async def fresh_extensions(request, handler):
    response = await handler(request)
    if request.path.startswith('/extensions/comfyui-liuxinyu-packs/'):
        response.headers['Cache-Control'] = 'no-store'
    return response


if getattr(PromptServer, 'instance', None):
    server = PromptServer.instance
    server.routes.get('/liuxinyu/frontend/version.js')(version_module)
    server.routes.post('/liuxinyu/frontend/version')(report_version)
    server.app.cleanup_ctx.append(lifecycle)
    server.app.middlewares.append(fresh_extensions)
