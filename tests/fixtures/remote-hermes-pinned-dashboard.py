"""Disposable actual pinned dashboard; synthetic auth/agent only, no external I/O.

Started by remote-hermes-dashboard-conformance.test.ts, never as a deployment.
Requires HERMES_SOURCE at the exact clean public pin. stdout emits readiness only.
"""
import asyncio
import contextlib
import hashlib
import importlib.metadata
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import tarfile
import threading
import time

PIN = "f97608f178d1ffeca59860195ab7da295f7c8e5f"
SOURCE = Path(os.environ["HERMES_SOURCE"]).resolve()
RECOVERY_ADAPTERS = os.environ.get("REMOTE_HERMES_RECOVERY_ADAPTER_FIXTURE") == "1"
ROOT = Path(__file__).resolve().parents[2]
assert subprocess.check_output(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], text=True).strip() == PIN
assert not subprocess.check_output(["git", "-C", str(SOURCE), "status", "--porcelain", "--untracked-files=all"], text=True).strip()
assert not (SOURCE / ".env").exists(), "A source checkout with credentials is not a fixture"
TEMP = tempfile.TemporaryDirectory(prefix="collective-pinned-dashboard-")
HOME = Path(TEMP.name).resolve()
# Explicit composed-adapter mode changes only a tracked archive inside the disposable home.
# The original clean pin remains untouched; this is never an installation/deployment path.
if RECOVERY_ADAPTERS:
    copy = HOME / "source"
    copy.mkdir()
    archive = subprocess.Popen(["git", "-C", str(SOURCE), "archive", PIN], stdout=subprocess.PIPE)
    with tarfile.open(fileobj=archive.stdout, mode="r|") as tar:
        tar.extractall(copy, filter="data")
    assert archive.wait() == 0
    for script, module in (("install-hermes-recovery.py", "native_recovery.py"),
                           ("install-hermes-hub-owner.py", "native_hub_owner.py")):
        spec = importlib.util.spec_from_file_location("fixture_installer_" + module.removesuffix(".py"), ROOT / "scripts" / script)
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        originals = {name: (copy / name).read_text() for name in installer.TARGETS}
        for name, content in installer.patch_sources(originals).items():
            (copy / name).write_text(content)
        (copy / (getattr(installer, "MODULE", None) or installer.OWNER_MODULE)).write_bytes((ROOT / "src/hermes-recovery" / module).read_bytes())
    SOURCE = copy
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
        if command not in {"git", "pdftoppm"} or (command == "git" and any(word in argv for word in ("fetch", "pull", "push", "clone", "ls-remote"))):
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
FAULTED_TRANSPORTS = set()
RECOVERY_RELEASE = threading.Event()

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
            METRICS["protected_answers"] += int(bool(answer))  # Native _ask unwraps the result to a string.
        elif "fixture-clarify" in text:
            server._ask("clarify", self.sid, {"questions": [{"qid": "q1", "question": "Synthetic question", "choices": ["One", "Two"]}]}, timeout=10)
        elif "fixture-approval" in text:
            server._ask("approval", self.sid, {"command": "synthetic-noop", "choices": ["once", "deny"]}, timeout=10)
        if "fixture-drain-hold" in text:
            RECOVERY_RELEASE.wait(20)  # Deliberately ignores interrupt until the synthetic control releases it.
        if "fixture-hold" in text:
            deadline = time.monotonic() + 10
            while not self._interrupt.is_set() and time.monotonic() < deadline:
                time.sleep(.01)
        final = "Synthetic fixture reply"
        if stream_callback:
            stream_callback(final)
        user = {"role": "user", "content": text}
        assistant = {"role": "assistant", "content": final}
        if RECOVERY_ADAPTERS:
            # The real agent owns assistant persistence. The synthetic seam must
            # implement that contract to test retained completed output, using the
            # actual profile-scoped native SessionDB rather than a fake history API.
            user = getattr(self, "_pending_cli_user_message", None) or user
            session = server._sessions[self.sid]
            with server._session_db(session) as database:
                assert database is not None
                assistant["_row_id"] = database.append_message(self.session_id, "assistant", content=final)
            assistant[server._DB_PERSISTED_MARKER] = True
        self.history = [*(conversation_history or []), user, assistant]
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

async def close_after_lost_ack(transport, observed_turns):
    if RECOVERY_ADAPTERS:
        # The native callback runs after a successful write. Drop the bytes while
        # returning success, then allow actual deferred admission to enter its agent
        # before disconnecting. This removes a reconnect/queued-worker race from the
        # active-worker recovery case without inventing a native completion result.
        deadline = time.monotonic() + 1
        while METRICS["agent_turns"] <= observed_turns and time.monotonic() < deadline:
            await asyncio.sleep(.005)
    await transport._ws.close(code=1012)

_original_write = native_ws.WSTransport.write

def fault_write(self, frame):
    global DROP_ACK
    CONNECTIONS.add(self)
    observe_attachment(frame)
    if RECOVERY_ADAPTERS and frame.get("method") == "event" and frame.get("params", {}).get("type") != "gateway.ready" and (DROP_ACK or self in FAULTED_TRANSPORTS):
        return True  # The same lost transport cannot deliver terminal evidence around its missing ACK.
    if DROP_ACK and isinstance(frame.get("id"), int) and frame.get("result", {}).get("status") in {"streaming", "queued"}:
        DROP_ACK = False
        if RECOVERY_ADAPTERS:
            FAULTED_TRANSPORTS.add(self)
        METRICS["dropped_acks"] += 1
        asyncio.run_coroutine_threadsafe(close_after_lost_ack(self, METRICS["agent_turns"]), self._loop)
        return True
    return _original_write(self, frame)

native_ws.WSTransport.write = fault_write
_original_write_async = native_ws.WSTransport.write_async

async def fault_write_async(self, frame):
    global DROP_ACK
    CONNECTIONS.add(self)
    observe_attachment(frame)
    if RECOVERY_ADAPTERS and frame.get("method") == "event" and frame.get("params", {}).get("type") != "gateway.ready" and (DROP_ACK or self in FAULTED_TRANSPORTS):
        return True  # The same lost transport cannot deliver terminal evidence around its missing ACK.
    if DROP_ACK and isinstance(frame.get("id"), int) and frame.get("result", {}).get("status") in {"streaming", "queued"}:
        DROP_ACK = False
        if RECOVERY_ADAPTERS:
            FAULTED_TRANSPORTS.add(self)
        METRICS["dropped_acks"] += 1
        if RECOVERY_ADAPTERS:
            asyncio.create_task(close_after_lost_ack(self, METRICS["agent_turns"]))
        else:
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
    elif RECOVERY_ADAPTERS and body == {"release_recovery_worker": True}:
        RECOVERY_RELEASE.set()
    elif RECOVERY_ADAPTERS and set(body) == {"probe_unowned_stdio", "request_id"} and body["probe_unowned_stdio"] is True and isinstance(body["request_id"], str) and 0 < len(body["request_id"]) <= 200:
        create = server.handle_request({"jsonrpc": "2.0", "id": "fixture-stdio-create", "method": "session.create", "params": {"profile": "default"}})
        answer = server.handle_request({"jsonrpc": "2.0", "id": "fixture-stdio-answer", "method": "request.answer", "params": {"id": body["request_id"], "result": {"value": "synthetic-stdio-rejected"}}})
        response = server_requests.resolve_response({"jsonrpc": "2.0", "id": body["request_id"], "result": {"value": "synthetic-stdio-rejected"}})
        return {"create_rejected": "error" in create, "answer_rejected": "error" in answer, "response_resolved": bool(response)}
    elif body == {"disconnect": True}:
        for connection in list(CONNECTIONS):
            with contextlib.suppress(Exception):
                await connection._ws.close(code=1012)
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
print(json.dumps({"port": listener.getsockname()[1], "pin": PIN, "runtimeVersion": "0.21.5", "desktopContract": server.DESKTOP_BACKEND_CONTRACT, "recoveryAdapters": RECOVERY_ADAPTERS}), file=sys.__stdout__, flush=True)
try:
    uvicorn.Server(uvicorn.Config(app, lifespan="off", access_log=False, log_level="error")).run(sockets=[listener])
finally:
    TEMP.cleanup()
