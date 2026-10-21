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
import re
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
WORKSPACE_ADAPTER = os.environ.get("REMOTE_HERMES_WORKSPACE_ADAPTER_FIXTURE", "")
assert WORKSPACE_ADAPTER in {"", "read", "write"}
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
    installers = {}
    adapters = (("install-hermes-recovery.py", "native_recovery.py"),
                ("install-hermes-hub-owner.py", "native_hub_owner.py"))
    for script, module in adapters:
        spec = importlib.util.spec_from_file_location("fixture_installer_" + module.removesuffix(".py"), ROOT / "scripts" / script)
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        installers[module] = installer
    if WORKSPACE_ADAPTER:
        spec = importlib.util.spec_from_file_location("fixture_workspace_installer", ROOT / "scripts/install-hermes-workspace-files.py")
        workspace_installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(workspace_installer)
        targets = set(installers["native_recovery.py"].TARGETS) | set(installers["native_hub_owner.py"].TARGETS)
        originals = {name: (copy / name).read_text() for name in targets}
        changed = workspace_installer.patch_sources(originals, installers["native_recovery.py"], installers["native_hub_owner.py"])
        for name, content in changed.items():
            (copy / name).write_text(content)
        for _script, module in adapters:
            installer = installers[module]
            (copy / (getattr(installer, "MODULE", None) or installer.OWNER_MODULE)).write_bytes((ROOT / "src/hermes-recovery" / module).read_bytes())
        workspace_source = (ROOT / "src/hermes-recovery/native_workspace_files.py").read_bytes()
        owner_source = (ROOT / "src/hermes-recovery/native_hub_owner.py").read_bytes()
        ADAPTER_PROVENANCE = {"workspace_sha256": hashlib.sha256(workspace_source).hexdigest(),
                              "owner_sha256": hashlib.sha256(owner_source).hexdigest(),
                              "owner_installer_sha256": hashlib.sha256((ROOT / "scripts/install-hermes-hub-owner.py").read_bytes()).hexdigest()}
        (copy / workspace_installer.MODULE).write_bytes(workspace_source)
    else:
      for _script, module in adapters:
        installer = installers[module]
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
if RECOVERY_ADAPTERS:
    other = Path(os.environ["HERMES_HOME"], "profiles", "fixture-other")
    other.mkdir(parents=True)
    (other / "config.yaml").write_text(Path(os.environ["HERMES_HOME"], "config.yaml").read_text())
WORKSPACES = {}
if WORKSPACE_ADAPTER:
    for profile in ("default", "fixture-other"):
        workspace = HOME / ("workspace-" + profile)
        workspace.mkdir()
        (workspace / "README.md").write_text("Synthetic " + profile + " workspace\n")
        (workspace / ".env").write_text("SYNTHETIC_TOKEN=never-project-this\n")
        outside = HOME / ("outside-" + profile + ".txt")
        outside.write_text("Synthetic outside boundary\n")
        (workspace / "outside-link").symlink_to(outside)
        (workspace / "nested").mkdir()
        WORKSPACES[profile] = str(workspace)
METRICS = {"agent_turns": 0, "external_attempts": 0, "refreshes": 0, "protected_answers": 0, "auxiliary_calls": 0, "auxiliary_tracked": 0, "dropped_acks": 0, "attachment_hashes": []}
CAPTURED_POLLER = None
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
if RECOVERY_ADAPTERS:
    # A real named profile needs its native schema before read-only discovery/owner CAS.
    with server._profile_db({"profile": "fixture-other"}, writer=True) as fixture_other_db:
        assert fixture_other_db is not None
from fastapi import Request
import uvicorn

if RECOVERY_ADAPTERS:
    # Fixture-only worker observation; uses the actual guarded RPC dispatch context
    # and the published composed auxiliary starter, never a fabricated owner context.
    from tui_gateway.contracts.base import Params, Result
    from tui_gateway.contracts.registry import method as declare_method
    class AuxiliaryProbeParams(Params):
        profile: str
        session_id: str
    class AuxiliaryProbeResult(Result):
        scheduled: bool
    def auxiliary_probe(rid, params):
        with server._sessions_lock:
            session = server._sessions.get(params["session_id"])
        assert session is not None
        def target():
            METRICS["auxiliary_calls"] += 1
            owner = server._collective_hub_owner
            with owner._guard:
                METRICS["auxiliary_tracked"] += int(owner._active_workers.get(str(Path(server._session_home(session)).resolve()), 0) > 0)
        thread = server._collective_start_auxiliary_work(target, name="fixture-bound-auxiliary", session=session)
        return server._ok(rid, {"scheduled": thread is not None})
    declare_method("fixture.owner_auxiliary", params=AuxiliaryProbeParams, result=AuxiliaryProbeResult)
    server.register_method("fixture.owner_auxiliary", server._collective_hub_owner.guard_method("fixture.owner_auxiliary", auxiliary_probe))

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
    global CAPTURED_POLLER
    global DROP_ACK
    web_server._require_token(request)
    body = await request.json()
    if WORKSPACE_ADAPTER and body == {"workspace_roots": True}:
        return {"roots": WORKSPACES, "adapter": WORKSPACE_ADAPTER, **ADAPTER_PROVENANCE}
    elif WORKSPACE_ADAPTER and set(body) == {"workspace_busy", "session_id"} and isinstance(body["workspace_busy"], bool):
        with server._sessions_lock:
            session = server._sessions.get(body["session_id"])
        assert session is not None
        with session["history_lock"]:
            session["running"] = body["workspace_busy"]
        return {"ok": True}
    elif body == {"drop_next_ack": True}:
        DROP_ACK = True
    elif RECOVERY_ADAPTERS and body == {"release_recovery_worker": True}:
        RECOVERY_RELEASE.set()
    elif RECOVERY_ADAPTERS and body == {"probe_recovery_worker": True}:
        with server._sessions_lock:
            session = next(record for record in server._sessions.values() if Path(server._session_home(record)).resolve() == Path(os.environ["HERMES_HOME"]) and not record.get("_finalized") and not record.get("_closing"))
        entered, auxiliary, tracked = [], [], []
        owner = server._collective_hub_owner
        owner.protect_worker(lambda: entered.append(True), session)()
        def auxiliary_target():
            auxiliary.append(True)
            with owner._guard:
                tracked.append(owner._active_workers.get(str(Path(server._session_home(session)).resolve()), 0) > 0)
        worker = server._collective_start_auxiliary_work(auxiliary_target, name="fixture-owner-auxiliary", session=session)
        if worker is not None:
            worker.join(timeout=1)
        return {"target_called": bool(entered), "auxiliary_called": bool(auxiliary), "auxiliary_tracked": bool(tracked and tracked[0])}
    elif RECOVERY_ADAPTERS and body == {"profile_real_work": True}:
        owner = server._collective_hub_owner
        home = Path(os.environ["HERMES_HOME"])
        with owner._locked(home):
            return {"default": owner._profile_has_native_work(home)}
    elif RECOVERY_ADAPTERS and body == {"profile_workers": True}:
        owner = server._collective_hub_owner
        home = Path(os.environ["HERMES_HOME"])
        with owner._guard:
            return {name: owner._active_workers.get(str(path.resolve()), 0)
                    for name, path in (("default", home), ("fixture-other", home / "profiles" / "fixture-other"))}
    elif RECOVERY_ADAPTERS and set(body) == {"probe_pending_auxiliary_claim"} and isinstance(body["probe_pending_auxiliary_claim"], str):
        from tui_gateway.collective_hub_owner import _active_binding
        from tui_gateway.transport import bind_transport, reset_transport
        with server._sessions_lock:
            session = server._sessions[body["probe_pending_auxiliary_claim"]]
            binding = session["_collective_poller_binding"]
        owner = server._collective_hub_owner
        entered = threading.Event()
        with owner._locked(Path(binding.home)):
            token = _active_binding.set(binding)
            transport_token = bind_transport(binding.transport)
            try:
                worker = server._collective_start_auxiliary_work(entered.set, name="synthetic-pending-auxiliary", session=session)
                assert worker is not None and worker.is_alive() and not entered.is_set()
                claim = owner.claim("synthetic-pending-claim", {
                    "profile": binding.profile, "portal_connection_id": binding.connection_id,
                    "portal_instance_id": "synthetic-pending-successor", "portal_generation": binding.portal_generation + 1,
                    "portal_socket_epoch": binding.socket_epoch + 1, "expected_native_generation": binding.native_generation,
                })
                blocked = claim.get("error", {}).get("code") == 4091
                unchanged = owner._current_owner(binding.home).same_claim(binding)
            finally:
                reset_transport(transport_token)
                _active_binding.reset(token)
        worker.join(timeout=2)
        return {"claim_rejected": blocked, "generation_unchanged": unchanged, "worker_executed": entered.is_set()}
    elif RECOVERY_ADAPTERS and set(body) == {"capture_poller_claim"} and isinstance(body["capture_poller_claim"], str):
        sid = body["capture_poller_claim"]
        with server._sessions_lock:
            session = server._sessions.get(sid)
            binding = session.get("_collective_poller_binding") if session is not None else None
        assert binding is not None
        CAPTURED_POLLER = (sid, session, binding)
        return {"captured": True}
    elif RECOVERY_ADAPTERS and body == {"probe_stale_poller_drain": True}:
        import queue
        from tools.process_registry import process_registry
        from tui_gateway.collective_hub_owner import _active_binding
        assert CAPTURED_POLLER is not None
        sid, session, binding = CAPTURED_POLLER
        owner = server._collective_hub_owner
        class ProbeQueue(queue.Queue):
            gets = 0
            def get(self, *args, **kwargs):
                self.gets += 1
                return super().get(*args, **kwargs)
        probe = ProbeQueue()
        probe.put({"type": "synthetic-stale-drain"})
        stop = threading.Event()
        stop.set()  # Enter the real native final-drain path directly.
        with owner._locked(Path(binding.home)):
            original = process_registry.completion_queue
            process_registry.completion_queue = probe
            token = _active_binding.set(binding)
            try:
                server._notification_poller_loop(stop, sid, session)
            finally:
                _active_binding.reset(token)
                process_registry.completion_queue = original
        return {"consumed": probe.gets, "retained": probe.qsize()}
    elif RECOVERY_ADAPTERS and body == {"profile_pollers": True}:
        result = {name: {"count": 0, "stopped": 0, "alive": 0, "all_alive": 0} for name in ("default", "fixture-other")}
        with server._sessions_lock:
            sessions = list(server._sessions.items())
        for sid, session in sessions:
            home = Path(server._session_home(session)).resolve()
            name = "default" if home == Path(os.environ["HERMES_HOME"]) else "fixture-other" if home == Path(os.environ["HERMES_HOME"], "profiles", "fixture-other") else None
            stop = session.get("_notif_stop")
            if name is not None and stop is not None:
                result[name]["count"] += 1
                result[name]["stopped"] += int(stop.is_set())
                result[name]["alive"] += int(any(event is stop and thread.is_alive() for event, thread in server._notification_pollers))
                result[name]["all_alive"] += sum(thread.is_alive() and thread.name == f"tui-notif-poller-{sid}"
                                                  for _, thread in server._notification_pollers)
        return result
    elif RECOVERY_ADAPTERS and set(body) == {"probe_unowned_stdio", "request_id"} and body["probe_unowned_stdio"] is True and isinstance(body["request_id"], str) and 0 < len(body["request_id"]) <= 200:
        create = server.handle_request({"jsonrpc": "2.0", "id": "fixture-stdio-create", "method": "session.create", "params": {"profile": "default"}})
        answer = server.handle_request({"jsonrpc": "2.0", "id": "fixture-stdio-answer", "method": "request.answer", "params": {"id": body["request_id"], "result": {"value": "synthetic-stdio-rejected"}}})
        response = server_requests.resolve_response({"jsonrpc": "2.0", "id": body["request_id"], "result": {"value": "synthetic-stdio-rejected"}})
        with server_requests._lock:
            req = server_requests._open.get(body["request_id"])
        assert req is not None
        with server._sessions_lock:
            orphan = server._sessions.pop(req.sid)
        try:
            orphan_response = server_requests.resolve_response({"jsonrpc": "2.0", "id": body["request_id"], "result": {"value": "synthetic-orphan-rejected"}})
        finally:
            with server._sessions_lock:
                server._sessions[req.sid] = orphan
        return {"create_rejected": "error" in create, "answer_rejected": "error" in answer, "response_resolved": bool(response), "orphan_response_resolved": bool(orphan_response)}
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
print(json.dumps({"port": listener.getsockname()[1], "pin": PIN, "runtimeVersion": "0.21.5", "desktopContract": server.DESKTOP_BACKEND_CONTRACT, "recoveryAdapters": RECOVERY_ADAPTERS, "workspaceAdapter": WORKSPACE_ADAPTER}), file=sys.__stdout__, flush=True)
try:
    uvicorn.Server(uvicorn.Config(app, lifespan="off", access_log=False, log_level="error")).run(sockets=[listener])
finally:
    TEMP.cleanup()
