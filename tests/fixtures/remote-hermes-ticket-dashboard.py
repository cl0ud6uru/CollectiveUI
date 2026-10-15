"""Disposable actual pinned dashboard; synthetic auth only, no inference or external I/O.

Started by remote-hermes-ticket-conformance.test.ts, never as a deployment.
Requires HERMES_SOURCE at the exact clean public pin. stdout emits readiness only.
"""
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time

PIN = "f97608f178d1ffeca59860195ab7da295f7c8e5f"
SOURCE = Path(os.environ["HERMES_SOURCE"]).resolve()
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
METRICS = {"agent_attempts": 0, "external_attempts": 0}
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
        words = list(argv) if isinstance(argv, (list, tuple)) else []
        command = Path(words.pop(0)).name if words else ""
        if words[:1] == ["-C"]:
            words = words[2:]
        if command != "git" or not words or words[0] not in {
            "--version", "rev-parse", "describe", "status", "log", "show", "diff"
        }:
            raise AssertionError("Only local read-only git inspection may spawn")
        super().__init__(argv, *args, **kwargs)

subprocess.Popen = GuardedPopen
sys.path.insert(0, str(SOURCE))
from hermes_cli import web_server
from hermes_cli.dashboard_auth.base import DashboardAuthProvider, InvalidCredentialsError, RefreshExpiredError, Session
from hermes_cli.dashboard_auth.registry import register_global_provider
from tui_gateway import server
from fastapi import Request
import uvicorn

app = web_server.app
app.state.auth_required = True
app.state.bound_host = "127.0.0.1"
app.state.allowed_hosts = {"127.0.0.1", "localhost"}
TOKENS = {}
REFRESH = {}
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
        return self.issue()
    def revoke_session(self, **kwargs):
        raise AssertionError("No account revocation in a conformance fixture")

register_global_provider(FixtureProvider())

# Exercise the real ticket route, upgrade gate, gateway and capabilities only.
# Even an accidental prompt must never construct an inference agent.
def no_agent(*args, **kwargs):
    METRICS["agent_attempts"] += 1
    raise AssertionError("Inference is forbidden in the ticket fixture")
server._make_agent = no_agent
from hermes_cli import mcp_startup
mcp_startup.start_deferred_mcp_discovery_now = lambda: None

@app.get("/api/__fixture/metrics")
async def metrics(request: Request):
    web_server._require_token(request)
    return {**METRICS, "pin": PIN}
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
