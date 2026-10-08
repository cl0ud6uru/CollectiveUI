"""Pinned routing/home regression over synthetic HTTP; no inference or live profiles."""
import ast
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ["HERMES_ATTACHMENTS_SOURCE"]).resolve()
PIN = "47676981f55de91231fdeef2f0eec47e7c209e78"
assert subprocess.check_output(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], text=True).strip() == PIN
sys.path.insert(0, str(SOURCE))
from hermes_constants import get_hermes_home, reset_hermes_home_override, set_hermes_home_override
from hermes_cli import profiles


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


attachments = load("attachments", ROOT / "src/hermes-attachments/api_server_attachments.py")
installer = load("installer", ROOT / "scripts/install-hermes-attachments.py")
api_source = (SOURCE / installer.API).read_text()
patched_api, patched_runs = installer.patched(api_source, (SOURCE / installer.RUNS).read_text())
assert "_api_request_profile.get() or \"default\"" not in patched_api.split("async def _handle_attachment_upload", 1)[1].split("async def _handle_runs", 1)[0]
assert "user_message, _api_server._api_request_profile.get())" in patched_runs

# Execute the exact pinned resolver and prefix check, without importing the
# gateway's inference/runtime dependencies. Profile/home helpers stay real.
syntax = ast.parse(api_source)
prefix = next(node for node in syntax.body if isinstance(node, ast.FunctionDef) and node.name == "_prefix_names_served_profile")
adapter_class = next(node for node in syntax.body if isinstance(node, ast.ClassDef) and node.name == "APIServerAdapter")
resolver = next(node for node in adapter_class.body if isinstance(node, ast.FunctionDef) and node.name == "_resolve_request_profile")
namespace = {"_PROFILE_REJECTED": object()}
exec(compile(ast.Module(body=[prefix, resolver], type_ignores=[]), str(SOURCE / installer.API), "exec"), namespace)


class ProfileHomes(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="attachment-profile-homes-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.named = self.root / "profiles" / "synthetic-named"
        self.other = self.root / "profiles" / "synthetic-other"
        self.named.mkdir(parents=True)
        self.other.mkdir(parents=True)

    async def client(self, home, multiplex=False):
        # Runtime home selection matches gateway middleware: no-op on a
        # single-profile route, selected get_profile_dir on multiplex routes.
        adapter = SimpleNamespace(gateway_runner=SimpleNamespace(config=SimpleNamespace(multiplex_profiles=multiplex)))
        adapter._expected_api_key = lambda: "synthetic-api-key"
        adapter._parse_session_key_header = lambda request: (request.headers.get("X-Hermes-Session-Key"), None)

        @web.middleware
        async def routing(request, handler):
            selected = namespace["_resolve_request_profile"](adapter, request)
            if selected is namespace["_PROFILE_REJECTED"]:
                return web.Response(status=404)
            token = set_hermes_home_override(profiles.get_profile_dir(selected) if selected else home)
            request["selected"] = selected
            try:
                return await handler(request)
            finally:
                reset_hermes_home_override(token)

        async def upload(request):
            return await attachments.handle_upload(adapter, request, request["selected"])

        async def run(request):
            body = await request.json()
            text, error = await attachments.bind_run(adapter, request, body, body.get("input", ""), request["selected"])
            if error is not None:
                return error
            files = json.loads(text.splitlines()[-1])
            return web.json_response({"files": files, "home": str(get_hermes_home())})

        app = web.Application(middlewares=[routing])
        for prefix_path in ("", "/p/{profile}"):
            app.router.add_post(prefix_path + "/v1/attachments", upload)
            app.router.add_post(prefix_path + "/v1/runs", run)
        client = TestClient(TestServer(app))
        await client.start_server()
        self.addAsyncCleanup(client.close)
        return client

    def headers(self, **overrides):
        return {"Authorization": "Bearer synthetic-api-key", "Content-Type": "application/pdf",
                "X-Hermes-Filename": "example.pdf", "X-Hermes-Session-Id": "synthetic-conversation",
                "X-Hermes-Session-Key": "synthetic-owner", "Idempotency-Key": "synthetic-upload", **overrides}

    async def stage(self, client, prefix=""):
        response = await client.post(prefix + "/v1/attachments", data=b"%PDF synthetic original", headers=self.headers())
        self.assertEqual(response.status, 201, await response.text())
        return await response.json()

    async def bind(self, client, receipt, prefix="", **overrides):
        return await client.post(prefix + "/v1/runs", json={"input": "Read it.", "session_id": "synthetic-conversation", "file_ids": [receipt["id"]]},
                                 headers=self.headers(**{"Content-Type": "application/json", **overrides}))

    async def assert_original(self, client, receipt, home, identity, prefix=""):
        response = await self.bind(client, receipt, prefix)
        self.assertEqual(response.status, 200, await response.text())
        result = await response.json()
        original = Path(result["files"][0]["path"])
        self.assertEqual(original.parent, home / "attachments" / "collectiveui")
        self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(), receipt["sha256"])
        scope = attachments.scope_for(identity, "synthetic-api-key", "synthetic-conversation", "synthetic-owner")
        self.assertEqual(receipt["id"], hashlib.sha256((scope + ":synthetic-upload").encode()).hexdigest()[:32])

    async def test_named_single_gateway_bare_and_matching_prefix_share_named_receipts(self):
        with patch.dict(os.environ, {"HERMES_HOME": str(self.named)}):
            client = await self.client(self.named)
            receipt = await self.stage(client)
            self.assertEqual(receipt, await self.stage(client, "/p/synthetic-named"))
            await self.assert_original(client, receipt, self.named, "synthetic-named")
            await self.assert_original(client, receipt, self.named, "synthetic-named", "/p/synthetic-named")
            self.assertFalse((self.root / "attachments").exists())
            self.assertEqual((await client.post("/p/synthetic-other/v1/attachments", data=b"synthetic", headers=self.headers())).status, 404)

    async def test_default_and_custom_home_gateways_keep_originals_in_selected_home(self):
        for home in (self.root, self.root / "custom-gateway-home"):
            with patch.dict(os.environ, {"HERMES_HOME": str(home)}):
                client = await self.client(home)
                receipt = await self.stage(client, "/p/default")
                await self.assert_original(client, receipt, home, "default")

    async def test_multiplex_requests_keep_receipts_and_worker_storage_in_each_profile(self):
        with patch.dict(os.environ, {"HERMES_HOME": str(self.root)}), patch.object(profiles, "profiles_to_serve", return_value=[("default", self.root), ("synthetic-named", self.named), ("synthetic-other", self.other)]):
            client = await self.client(self.root, multiplex=True)
            receipts = await asyncio.gather(self.stage(client, "/p/synthetic-named"), self.stage(client, "/p/synthetic-other"), self.stage(client))
            for receipt, home, identity, prefix_path in zip(receipts, (self.named, self.other, self.root), ("synthetic-named", "synthetic-other", "default"), ("/p/synthetic-named", "/p/synthetic-other", "")):
                await self.assert_original(client, receipt, home, identity, prefix_path)
                self.assertEqual(receipt, await self.stage(client, prefix_path))
            self.assertEqual((await self.bind(client, receipts[0], "/p/synthetic-other")).status, 404)
            self.assertEqual((await self.bind(client, receipts[0], "/p/synthetic-named", **{"X-Hermes-Session-Key": "different-owner"})).status, 404)
            self.assertEqual((await self.bind(client, receipts[0], "/p/synthetic-named", Authorization="Bearer wrong-key")).status, 401)


if __name__ == "__main__":
    unittest.main()
