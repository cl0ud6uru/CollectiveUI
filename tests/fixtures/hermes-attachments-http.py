"""Isolated HTTP contract fixture. Requires aiohttp; never calls a model or a live profile."""
import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from aiohttp import web

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("attachments", ROOT / "src/hermes-attachments/api_server_attachments.py")
attachments = importlib.util.module_from_spec(spec)
spec.loader.exec_module(attachments)


async def main():
    with tempfile.TemporaryDirectory(prefix="synthetic-hermes-attachments-") as directory:
        attachments._store = lambda profile: attachments.AttachmentStore(Path(directory) / profile)
        admitted = {}

        class Adapter:
            def _expected_api_key(self):
                return "synthetic-api-key"

            def _parse_session_key_header(self, request):
                return request.headers.get("X-Hermes-Session-Key"), None

        adapter = Adapter()

        async def caps(request):
            return web.json_response({"features": {"run_attachments": attachments.FEATURE}})

        async def upload(request):
            return await attachments.handle_upload(adapter, request, request.match_info["profile"])

        async def run(request):
            body = await request.json()
            text, error = await attachments.bind_run(adapter, request, body, body.get("input", ""), request.match_info["profile"])
            if error is not None:
                return error
            # Test-only oracle: prove the delivered bytes are readable at the exact paths the agent receives.
            files = json.loads(text.splitlines()[-1])
            admitted["run_synthetic"] = [{"name": file["name"], "sha256": hashlib.sha256(Path(file["path"]).read_bytes()).hexdigest()} for file in files]
            return web.json_response({"run_id": "run_synthetic"}, status=202)

        async def events(request):
            result = json.dumps(admitted["run_synthetic"])
            return web.Response(text='data: ' + json.dumps({"event": "run.completed", "output": result, "usage": {}}) + '\n\n', content_type="text/event-stream")

        app = web.Application(client_max_size=attachments.MAX_FILE_BYTES + 1)
        app.router.add_get("/p/{profile}/v1/capabilities", caps)
        app.router.add_post("/p/{profile}/v1/attachments", upload)
        app.router.add_post("/p/{profile}/v1/runs", run)
        app.router.add_get("/p/{profile}/v1/runs/{run_id}/events", events)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        print(json.dumps({"port": site._server.sockets[0].getsockname()[1]}), flush=True)
        try:
            await asyncio.Event().wait()
        finally:
            await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
