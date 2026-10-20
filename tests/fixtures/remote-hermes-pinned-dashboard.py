"""Disposable actual pinned dashboard; synthetic auth/agent only, no external I/O.

Started by remote-hermes-dashboard-conformance.test.ts, never as a deployment.
Requires HERMES_SOURCE at the exact clean public pin. stdout emits readiness only.
"""
import asyncio
import contextlib
import hashlib
import importlib.metadata
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time

PIN = "f97608f178d1ffeca59860195ab7da295f7c8e5f"
SOURCE = Path(os.environ["HERMES_SOURCE"]).resolve()
ROOT = Path(__file__).resolve().parents[2]
assert subprocess.check_output(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], text=True).strip() == PIN
assert not subprocess.check_output(["git", "-C", str(SOURCE), "status", "--porcelain", "--untracked-files=all"], text=True).strip()
assert not (SOURCE / ".env").exists(), "A source checkout with credentials is not a fixture"
TEMP = tempfile.TemporaryDirectory(prefix="collective-pinned-dashboard-")
HOME = Path(TEMP.name).resolve()
os.environ.clear()
os.environ.update(PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", HOME=str(HOME),
                  HERMES_HOME=str(HOME / "profile"), HERMES_DISABLE_LAZY_INSTALLS="1",
                  HERMES_ISO_CERTIFY_SYNTH_TURN="1", PYTEST_CURRENT_TEST="collective-pinned-conformance", HERMES_DASHBOARD_SESSION_TOKEN="synthetic-loopback-only")
Path(os.environ["HERMES_HOME"]).mkdir()
os.chdir(HOME)
Path(os.environ["HERMES_HOME"], "config.yaml").write_text("model:\n  default: synthetic-conformance\n  provider: synthetic\ndashboard:\n  process_isolation: false\n")
METRICS = {"agent_turns": 0, "external_attempts": 0, "refreshes": 0, "protected_answers": 0, "dropped_acks": 0, "attachment_hashes": []}
# Deny external networking before importing any source with import-time hooks.
_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex
_sendto = socket.socket.sendto

def local_address(address):
    if isinstance(address, str):  # Unix socket, never an external destination.
        return True
    try:
        return ipaddress.ip_address(address[0]).is_loopback
    except (ValueError, TypeError, IndexError):
        return False

def guarded_connect(self, address):
    if not local_address(address):
        METRICS["external_attempts"] += 1
        raise AssertionError("External network forbidden in pinned dashboard fixture")
    return _connect(self, address)

def guarded_connect_ex(self, address):
    if not local_address(address):
        METRICS["external_attempts"] += 1
        raise AssertionError("External network forbidden in pinned dashboard fixture")
    return _connect_ex(self, address)

def guarded_sendto(self, data, *args):
    if not local_address(args[-1]):
        METRICS["external_attempts"] += 1
        raise AssertionError("External datagram forbidden in pinned dashboard fixture")
    return _sendto(self, data, *args)

_getaddrinfo = socket.getaddrinfo

def guarded_getaddrinfo(host, *args, **kwargs):
    if host not in {None, "localhost", "127.0.0.1", "::1"}:
        METRICS["external_attempts"] += 1
        raise AssertionError("External DNS forbidden in pinned dashboard fixture")
    return _getaddrinfo(host, *args, **kwargs)

socket.getaddrinfo = guarded_getaddrinfo
socket.socket.connect, socket.socket.connect_ex, socket.socket.sendto = guarded_connect, guarded_connect_ex, guarded_sendto
_popen = subprocess.Popen

class GuardedPopen(_popen):
    # Keep Popen a class: the actual pinned dashboard evaluates Popen | None
    # annotations eagerly on Python 3.13 (3.14 defers those annotations).
    def __init__(self, argv, *args, **kwargs):
        command = Path(argv[0]).name if isinstance(argv, (list, tuple)) else ""
        # Native profile creation checks for an alias before writing its wrapper.
        # Permit only this local lookup for the pool-one test's canonical name;
        # arbitrary lookups, shell commands and executable overrides stay denied.
        profile_lookup = (isinstance(argv, (list, tuple)) and len(argv) == 2
                          and argv[0] == "which" and isinstance(argv[1], str)
                          and re.fullmatch(r"pool-one-[a-z0-9]{8}", argv[1])
                          and not kwargs.get("shell") and kwargs.get("executable") is None)
        if not profile_lookup and (command not in {"git", "pdftoppm"} or (command == "git" and any(word in argv for word in ("fetch", "pull", "push", "clone", "ls-remote")))):
            raise AssertionError("Only local git inspection and PDF rendering may spawn")
        super().__init__(argv, *args, **kwargs)

subprocess.Popen = GuardedPopen
sys.path.insert(0, str(SOURCE))
from hermes_cli import web_server
from hermes_cli.dashboard_auth.base import DashboardAuthProvider, InvalidCredentialsError, RefreshExpiredError, Session
from hermes_cli.dashboard_auth.registry import register_global_provider
from tui_gateway import server, server_requests, ws as native_ws
from tui_gateway.synthetic_turn import SyntheticHeavyAgent
from fastapi import Request
import uvicorn

app = web_server.app
app.state.auth_required = True
app.state.bound_host = "127.0.0.1"
app.state.allowed_hosts = {"127.0.0.1", "localhost"}
TOKENS = {}
REFRESH = {}
DROP_ACK = False
CONNECTIONS = set()

class FixtureProvider(DashboardAuthProvider):
    name = "synthetic"
    display_name = "Synthetic fixture"
    supports_password = True
    def issue(self):
        token, refresh = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
        session = Session("synthetic-owner", "fixture@example.invalid", "Synthetic fixture", "", self.name,
                          int(time.time()) + 3600, token, refresh)
        TOKENS[token], REFRESH[refresh] = session, session
        return session
    def start_login(self, **kwargs):
        raise AssertionError("Interactive external OAuth is forbidden")
    def complete_login(self, **kwargs):
        raise AssertionError("Interactive external OAuth is forbidden")
    def complete_password_login(self, *, username, password):
        if username != "synthetic" or password != "synthetic-password":
            raise InvalidCredentialsError("Synthetic credential rejected")
        return self.issue()
    def verify_session(self, *, access_token):
        return TOKENS.get(access_token)
    def refresh_session(self, *, refresh_token):
        old = REFRESH.pop(refresh_token, None)
        if old is None:
            raise RefreshExpiredError("Synthetic refresh expired")
        TOKENS.pop(old.access_token, None)
        METRICS["refreshes"] += 1
        return self.issue()
    def revoke_session(self, **kwargs):
        raise AssertionError("No account revocation in a conformance fixture")

register_global_provider(FixtureProvider())

class FixtureAgent(SyntheticHeavyAgent):
    def __init__(self, sid, key):
        super().__init__(key, model="synthetic-conformance")
        self.sid = sid
    def run_conversation(self, message, *, conversation_history=None, stream_callback=None, **kwargs):
        METRICS["agent_turns"] += 1
        text = str(message)
        if "fixture-protected" in text:
            answer = server._ask("secret", self.sid, {"prompt": "Synthetic protected value"}, timeout=10)
            METRICS["protected_answers"] += int(bool(answer and answer.get("value")))
        elif "fixture-clarify" in text:
            server._ask("clarify", self.sid, {"questions": [{"qid": "q1", "question": "Synthetic question", "choices": ["One", "Two"]}]}, timeout=10)
        elif "fixture-approval" in text:
            server._ask("approval", self.sid, {"command": "synthetic-noop", "choices": ["once", "deny"]}, timeout=10)
        if "fixture-hold" in text:
            deadline = time.monotonic() + 10
            while not self._interrupt.is_set() and time.monotonic() < deadline:
                time.sleep(.01)
        final = "Synthetic fixture reply"
        if stream_callback:
            stream_callback(final)
        self.history = [*(conversation_history or []), {"role": "user", "content": text}, {"role": "assistant", "content": final}]
        return {"final_response": final, "messages": self.history, "interrupted": self._interrupt.is_set(), "completed": True, "error": None, "last_reasoning": None}

# Only construction/inference is replaced. Registry, admission, persistence,
# server requests, queue helpers, interrupt, resume and WS framing remain real.
server._make_agent = lambda sid, key, **kwargs: FixtureAgent(sid, key)
from hermes_cli import mcp_startup
mcp_startup.start_deferred_mcp_discovery_now = lambda: None
def observe_attachment(frame):
    result = frame.get("result") or {}
    if result.get("attached") is True and isinstance(result.get("path"), str):
        path = Path(result["path"]).resolve()
        if not path.is_relative_to(HOME):
            raise AssertionError("Native attachment escaped the disposable home")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest not in METRICS["attachment_hashes"]:
            METRICS["attachment_hashes"].append(digest)

_original_write = native_ws.WSTransport.write

def fault_write(self, frame):
    global DROP_ACK
    CONNECTIONS.add(self)
    observe_attachment(frame)
    if DROP_ACK and isinstance(frame.get("id"), int) and frame.get("result", {}).get("status") in {"streaming", "queued"}:
        DROP_ACK = False
        METRICS["dropped_acks"] += 1
        asyncio.run_coroutine_threadsafe(self._ws.close(code=1012), self._loop)
        return True
    return _original_write(self, frame)

native_ws.WSTransport.write = fault_write
_original_write_async = native_ws.WSTransport.write_async

async def fault_write_async(self, frame):
    global DROP_ACK
    CONNECTIONS.add(self)
    observe_attachment(frame)
    if DROP_ACK and isinstance(frame.get("id"), int) and frame.get("result", {}).get("status") in {"streaming", "queued"}:
        DROP_ACK = False
        METRICS["dropped_acks"] += 1
        await self._ws.close(code=1012)
        return True
    return await _original_write_async(self, frame)

native_ws.WSTransport.write_async = fault_write_async

@app.get("/api/__fixture/metrics")
async def metrics(request: Request):
    web_server._require_token(request)
    return {**METRICS, "pin": PIN, "runtime_version": "0.21.5", "desktop_contract": server.DESKTOP_BACKEND_CONTRACT}

@app.post("/api/__fixture/control")
async def control(request: Request):
    global DROP_ACK
    web_server._require_token(request)
    body = await request.json()
    if body == {"drop_next_ack": True}:
        DROP_ACK = True
    elif body == {"disconnect": True}:
        for connection in list(CONNECTIONS):
            with contextlib.suppress(Exception):
                await connection._ws.close(code=1012)
    elif body == {"suppress_openrouter_environment": True}:
        from hermes_cli.web_routers._common import config_scoped_to_thread

        def prepare_suppressed_source():
            from hermes_cli.config import save_env_value
            from hermes_cli.auth import suppress_credential_source

            save_env_value("OPENROUTER_API_KEY", "synthetic-restored-openrouter-source")
            suppress_credential_source("openrouter", "env:OPENROUTER_API_KEY")

        await config_scoped_to_thread("default", prepare_suppressed_source)
    elif body == {"prepare_mcp_oauth": True}:
        # Real native REST handlers, callback routing and flow state; replace
        # only the provider/SDK worker. No registration, token exchange or grant.
        from urllib.parse import urlencode
        import yaml
        from hermes_cli.web_routers import mcp as mcp_routes
        from tools.connectors.mcp_oauth import _validate_client_redirect_uri
        # Execute the exact pin's pure filename mapper without importing an SDK.
        import ast
        filename_node = next(node for node in ast.parse((SOURCE / "tools/mcp_oauth.py").read_text()).body
                             if isinstance(node, ast.FunctionDef) and node.name == "_safe_filename")
        namespace = {"re": re}
        exec(compile(ast.Module(body=[filename_node], type_ignores=[]), "pinned_oauth_filename", "exec"), namespace)
        METRICS["mcp_oauth_filename_cases"] = {name: namespace["_safe_filename"](name) for name in
            ["team.api", "team_api", "_team_api", "team-api", "plugin:name", "___", "a" * 150]}

        assert _validate_client_redirect_uri("http://127.0.0.1:54321/callback") == "http://127.0.0.1:54321/callback"
        try:
            _validate_client_redirect_uri("https://portal.example.invalid/callback")
        except ValueError:
            METRICS["mcp_rpc_https_callback_rejected"] = True
        else:
            raise AssertionError("The pinned RPC unexpectedly accepted a public HTTPS redirect")
        os.environ["HERMES_DASHBOARD_PUBLIC_URL"] = "https://native.example.invalid/hermes"
        config_path = Path(os.environ["HERMES_HOME"], "config.yaml")
        cfg = yaml.safe_load(config_path.read_text())
        cfg.setdefault("mcp_servers", {})["fixture-oauth"] = {"url": "https://mcp.example.invalid/mcp", "auth": "oauth"}
        config_path.write_text(yaml.safe_dump(cfg))
        METRICS["mcp_oauth_starts"] = 0
        METRICS["mcp_oauth_approvals"] = 0

        def synthetic_oauth_worker(flow, config):
            METRICS["mcp_oauth_starts"] += 1

            async def work():
                await flow.publish_authorization_url("https://auth.example.invalid/authorize?" + urlencode({
                    "state": secrets.token_urlsafe(24), "redirect_uri": flow.redirect_uri,
                }))
                try:
                    await flow.wait_for_callback(timeout=15)
                    flow.mark_approved()
                    METRICS["mcp_oauth_approvals"] += 1
                except Exception:
                    flow.mark_error("Synthetic OAuth cancelled or denied")
                finally:
                    flow.mark_worker_done()

            asyncio.run(work())

        mcp_routes._run_dashboard_mcp_oauth = synthetic_oauth_worker
    else:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Unknown synthetic control")
    return {"ok": True}

# Put test-only controls ahead of the real SPA catch-all, retaining native middleware.
controls = [route for route in app.router.routes if getattr(route, "path", "").startswith("/api/__fixture/")]
app.router.routes[:] = controls + [route for route in app.router.routes if route not in controls]
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(128)
print(json.dumps({"port": listener.getsockname()[1], "pin": PIN, "runtimeVersion": "0.21.5", "desktopContract": server.DESKTOP_BACKEND_CONTRACT}), file=sys.__stdout__, flush=True)
try:
    uvicorn.Server(uvicorn.Config(app, lifespan="off", access_log=False, log_level="error")).run(sockets=[listener])
finally:
    TEMP.cleanup()
