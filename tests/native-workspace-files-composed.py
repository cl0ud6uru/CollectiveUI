"""Exercise the workspace handler through Hermes' pinned RPC dispatch and #266 owner fence.

This harness uses an exact Hermes checkout and the separately published PR #266 adapter. It
does not patch that checkout, create a real profile grant, or start a gateway process. Pydantic
must be available from the Hermes Python environment.

Example:
  python tests/native-workspace-files-composed.py \
    --hermes-source /path/to/hermes-at-the-pin \
    --owner-checkout /path/to/CollectiveUI-at-PR266
"""
from __future__ import annotations

import argparse
import ast
import contextvars
import importlib
import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import types
import unittest

PIN = "f97608f178d1ffeca59860195ab7da295f7c8e5f"
OWNER_HEAD = "5de681d1c1050e825c6b2b0d679426590102bafa"
WORKSPACE_FILE = Path(__file__).resolve().parents[1] / "src/hermes-recovery/native_workspace_files.py"


def _exec_defs(path: Path, names: set[str], namespace: dict) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    selected = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name in names]
    found = {node.name for node in selected}
    if found != names:
        raise AssertionError(f"Pinned source definitions differ: wanted {sorted(names)}, found {sorted(found)}")
    module = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), *selected],
                        type_ignores=[])
    ast.fix_missing_locations(module)
    exec(compile(module, str(path), "exec"), namespace)


def _package(name: str, path: Path | None = None) -> types.ModuleType:
    value = types.ModuleType(name)
    value.__path__ = [str(path)] if path is not None else []
    sys.modules[name] = value
    return value


def _load_file(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _boot_modules(hermes: Path, owner_path: Path):
    sys.path.insert(0, str(hermes))
    tg = _package("tui_gateway", hermes / "tui_gateway")
    _package("tui_gateway.contracts", hermes / "tui_gateway/contracts")
    _package("agent")
    sanitization = types.ModuleType("agent.message_sanitization")
    sanitization._sanitize_surrogates = lambda value: value
    sys.modules[sanitization.__name__] = sanitization
    replay = types.ModuleType("tui_gateway.event_replay")
    replay.replay_epoch = lambda *_args, **_kwargs: None
    sys.modules[replay.__name__] = replay
    git_probe = types.ModuleType("tui_gateway.git_probe")
    git_probe.common_repo_root = lambda _path: None
    git_probe.repo_root = lambda _path: None
    sys.modules[git_probe.__name__] = git_probe
    tg.git_probe = git_probe

    # These are the actual pinned Hermes wire models and registry, not test stand-ins.
    from tui_gateway.contracts import base as _base  # noqa: F401
    from tui_gateway.contracts import registry as contracts
    transport = importlib.import_module("tui_gateway.transport")

    server = types.ModuleType("tui_gateway.server")
    server._methods = {}
    server._contracts = contracts
    server._LONG_HANDLERS = frozenset()
    server.current_transport = transport.current_transport
    server.bind_transport = transport.bind_transport
    server.reset_transport = transport.reset_transport
    server._current_runtime_session_record = contextvars.ContextVar("pin_runtime_record", default=None)
    server._methods_lock = threading.RLock()
    _exec_defs(hermes / "tui_gateway/server.py",
               {"_ok", "_err", "register_method", "_normalize_request", "_current_session_steer_authority"},
               vars(server))
    _exec_defs(hermes / "tui_gateway/session_transports.py", {"_session_transport_contains"}, vars(server))
    server._transport_is_dead = lambda _transport: False
    tg.server = server
    sys.modules[server.__name__] = server

    # Import the real pinned WebSocket transport class. Only its write method is replaced by an
    # in-memory capture on the test subclass; the owner adapter sees the native WSTransport type.
    ws = importlib.import_module("tui_gateway.ws")
    retirement_pkg = _package("hermes_cli")
    retirement = types.ModuleType("hermes_cli.backend_retirement")
    class _Retirement:
        @staticmethod
        def work():
            from contextlib import nullcontext
            return nullcontext(True)

        @staticmethod
        def acquire():
            return True

        @staticmethod
        def release():
            return None
    retirement.retirement = _Retirement()
    sys.modules[retirement.__name__] = retirement
    retirement_pkg.backend_retirement = retirement
    server_requests = types.ModuleType("tui_gateway.server_requests")
    server_requests.is_response_frame = lambda _request: False
    server.server_requests = server_requests
    tg.server_requests = server_requests

    rpc_dispatch = importlib.import_module("tui_gateway.rpc_dispatch")
    tg.rpc_dispatch = rpc_dispatch
    server._rpc_dispatch = rpc_dispatch
    server._stdio_transport = None
    server._CONNECTOR_RPC_METHODS = frozenset()
    server._relay_compute_host_response = lambda _request: False
    server._current_rpc_method = contextvars.ContextVar("pin_rpc_method", default="")
    server.contextvars = contextvars

    class _InlineFuture:
        def add_done_callback(self, callback):
            callback(self)

    class _InlinePool:
        @staticmethod
        def submit(callback):
            callback()
            return _InlineFuture()
    server._pool = _InlinePool()
    rpc_dispatch.register(server)  # actual pinned binder and dispatcher functions

    # Bind the real pinned session cwd/backend helpers onto the server namespace. They use
    # server globals exactly as they do in server.py after method_ctx.bind_module.
    from tui_gateway import session_workdir
    session_workdir.register(server)
    server.contextlib = importlib.import_module("contextlib")
    server.os = os

    owner = _load_file("tui_gateway.collective_hub_owner", owner_path)
    workspace = _load_file("composed_native_workspace_files", WORKSPACE_FILE)
    return server, owner, workspace, ws.WSTransport, transport


class ComposedHermesWorkspaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        parser = argparse.ArgumentParser(add_help=False)
        parser.add_argument("--hermes-source", type=Path, required=True)
        parser.add_argument("--owner-checkout", type=Path, required=True)
        args, unittest_args = parser.parse_known_args()
        hermes = args.hermes_source.resolve()
        owner_checkout = args.owner_checkout.resolve()
        if subprocess.check_output(["git", "-C", str(hermes), "rev-parse", "HEAD"], text=True).strip() != PIN:
            raise RuntimeError("Hermes source is not at the reviewed exact pin")
        owner_head = subprocess.check_output(["git", "-C", str(owner_checkout), "rev-parse", "HEAD"], text=True).strip()
        if owner_head != OWNER_HEAD:
            raise RuntimeError("Owner adapter checkout is not the published PR #266 head")
        cls.hermes = hermes
        cls.owner_checkout = owner_checkout
        cls.owner_head = owner_head
        cls.server, cls.owner_module, cls.workspace_module, cls.WSTransport, cls.transport_module = _boot_modules(
            hermes, owner_checkout / "src/hermes-recovery/native_hub_owner.py")
        cls._unittest_args = unittest_args
        print(f"Composed provenance: Hermes {PIN}; CollectiveUI PR266 {owner_head}; workspace adapter {WORKSPACE_FILE}")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1])
        self.base = Path(self.temp.name)
        self.home = self.base / "profile"
        self.home.mkdir()
        (self.home / "state.db").touch()
        self.workspace = self.base / "workspace"
        self.workspace.mkdir()
        self.readme = self.workspace / "README.md"
        self.readme.write_text("synthetic native workspace\n", encoding="utf-8")
        (self.workspace / ".env").write_text("TEST_TOKEN=synthetic-secret\n", encoding="utf-8")
        (self.base / "outside.txt").write_text("outside\n", encoding="utf-8")
        (self.workspace / "outside-link").symlink_to(self.base / "outside.txt")
        private = self.base / "credential-source.txt"
        private.write_text("synthetic credential\n", encoding="utf-8")
        os.link(private, self.workspace / "plain-looking.txt")
        db = sqlite3.connect(self.home / "projects.db")
        db.executescript("CREATE TABLE projects (id TEXT, name TEXT, archived INTEGER); CREATE TABLE project_folders (project_id TEXT, path TEXT);")
        db.execute("INSERT INTO projects VALUES ('project-1', 'Synthetic project', 0)")
        db.execute("INSERT INTO project_folders VALUES ('project-1', ?)", (str(self.workspace),))
        db.commit()
        db.close()

        self.session = {"session_id": "runtime-session", "session_key": "stored-session", "cwd": str(self.workspace),
                        "explicit_cwd": True, "cwd_from_settle": False, "source": "desktop",
                        "profile_home": str(self.home), "transport": None, "_compute_host_active": False}
        server = self.server
        server._hermes_home = self.home
        server._sessions = {"runtime-session": self.session}
        server._sessions_lock = threading.RLock()
        server._profile_home = lambda _profile: self.home
        server._session_home = lambda session: Path(session["profile_home"])
        server._load_cfg = lambda: {"terminal": {"backend": self.backend}}
        server._session_live_status = lambda _sid, _session: self.live_status
        server._inflight_snapshot = lambda _session: None
        server._queued_prompt_snapshot = lambda _session: None
        server._session_has_active_delegations = lambda _sid, _session: False
        server._start_session_work = lambda *args, **kwargs: None
        server._server_requests = types.SimpleNamespace(resolve_response=lambda _frame: True, _lock=threading.RLock(), _open={})
        self.backend = "local"
        self.live_status = "idle"
        self.transport = self._capture_transport()
        self.session["transport"] = self.transport
        self.server._methods.clear()
        self.server._contracts.METHODS.clear()
        self.server._contracts.SERVER_REQUESTS.clear()
        self.server._contracts.EVENTS.clear()
        self.server._LONG_HANDLERS = frozenset()
        self.server._rpc_dispatch._LONG_HANDLERS = frozenset()
        self.server._collective_workspace_files = None
        self.server._collective_hub_owner = None
        self.workspace_module.install(self.server)
        self.owner = self.owner_module.install(self.server)

    def tearDown(self):
        self.temp.cleanup()

    def _capture_transport(self):
        base = self.WSTransport
        class CaptureTransport(base):
            def __init__(inner):
                inner.frames = []

            def write(inner, frame):
                inner.frames.append(frame)
                return True
        return CaptureTransport()

    def dispatch(self, method, params, transport=None, request_id="synthetic-request"):
        client = transport or self.transport
        before = len(client.frames)
        returned = self.server.dispatch({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}, client)
        self.assertIsNone(returned)
        self.assertGreater(len(client.frames), before)
        return client.frames[-1]

    def claim(self, client=None):
        client = client or self.transport
        response = self.dispatch("collective.hub_owner.claim", {
            "profile": "synthetic-profile", "portal_connection_id": "connection-a", "portal_instance_id": "instance-a",
            "portal_generation": 1, "portal_socket_epoch": 1, "expected_native_generation": 0, "phase": "full",
        }, client, "claim")
        self.assertTrue(response.get("result", {}).get("accepted"), response)
        return response

    def workspace_call(self, params, client=None):
        return self.dispatch("collective.workspace.files", {"profile": "synthetic-profile", "session_id": "runtime-session", **params}, client)

    def test_authorized_claim_and_reads_cross_actual_pinned_dispatcher_and_owner_wrapper(self):
        self.assertIsNot(self.server._methods["collective.workspace.files"], self.server._collective_workspace_files)
        self.assertIn("collective.workspace.files", self.server._LONG_HANDLERS)
        self.assertIn("collective.workspace.files", self.server._rpc_dispatch._LONG_HANDLERS)
        self.claim()
        listed = self.workspace_call({"action": "list"})
        self.assertTrue(listed["result"]["available"], listed)
        self.assertIn("README.md", [entry["name"] for entry in listed["result"]["entries"]])
        self.assertNotIn(".env", [entry["name"] for entry in listed["result"]["entries"]])
        read = self.workspace_call({"action": "read", "path": "README.md"})
        self.assertEqual(read["result"]["content"], "synthetic native workspace\n")

    def test_dispatch_rejects_unclaimed_foreign_profile_and_non_idle_requests(self):
        unclaimed = self._capture_transport()
        denied = self.workspace_call({"action": "list"}, unclaimed)
        self.assertIn("error", denied)
        self.claim()
        invalid_contract = self.workspace_call({"action": "list", "arbitrary_path": "/tmp"})
        self.assertIn("error", invalid_contract)
        wrong_profile = self.dispatch("collective.workspace.files", {
            "profile": "other-profile", "session_id": "runtime-session", "action": "list"})
        self.assertIn("error", wrong_profile)
        self.live_status = "working"
        busy = self.workspace_call({"action": "list"})
        self.assertIn("error", busy)

    def test_archived_project_has_no_authoritative_workspace_root(self):
        self.claim()
        db = sqlite3.connect(self.home / "projects.db")
        db.execute("UPDATE projects SET archived=1")
        db.commit()
        db.close()
        response = self.workspace_call({"action": "list"})
        self.assertFalse(response["result"]["available"], response)

    def test_actual_bound_backend_helper_fails_closed_for_configured_docker_and_ssh(self):
        self.claim()
        previous = os.environ.pop("TERMINAL_ENV", None)
        try:
            for backend in ("docker", "ssh"):
                self.backend = backend  # Pinned helper reads terminal.backend when TERMINAL_ENV is unset.
                response = self.workspace_call({"action": "list"})
                self.assertIn("error", response, backend)
            self.backend = "local"
            self.assertTrue(self.workspace_call({"action": "list"})["result"]["available"])
        finally:
            if previous is not None:
                os.environ["TERMINAL_ENV"] = previous

    def test_path_traversal_symlink_hidden_credentials_and_hardlinks_are_denied(self):
        self.claim()
        for path in ("../outside.txt", ".env", "outside-link", "plain-looking.txt"):
            response = self.workspace_call({"action": "read", "path": path})
            self.assertIn("error", response, path)
            self.assertNotIn("synthetic-secret", str(response))
            self.assertNotIn("synthetic credential", str(response))

    def test_fifo_and_replacement_fifo_reads_return_without_blocking(self):
        self.claim()
        fifo = self.workspace / "guessed-pipe"
        os.mkfifo(fifo)
        response = self.workspace_call({"action": "read", "path": "guessed-pipe"})
        self.assertIn("error", response)

        replacement = self.workspace / "swap.txt"
        replacement.write_text("regular before race", encoding="utf-8")
        original_open = os.open
        swapped = False

        def replace_before_open(path, flags, mode=0o777, *, dir_fd=None):
            nonlocal swapped
            if path == "swap.txt" and dir_fd is not None and not swapped:
                os.unlink(path, dir_fd=dir_fd)
                os.mkfifo(path, dir_fd=dir_fd)
                swapped = True
            if dir_fd is None:
                return original_open(path, flags, mode)
            return original_open(path, flags, mode, dir_fd=dir_fd)

        os.open = replace_before_open
        try:
            response = self.workspace_call({"action": "read", "path": "swap.txt"})
        finally:
            os.open = original_open
        self.assertTrue(swapped)
        self.assertIn("error", response)

    def test_fifo_paths_are_bounded_by_a_child_process_timeout(self):
        completed = subprocess.run([
            sys.executable, str(Path(__file__).resolve()),
            "--hermes-source", str(self.hermes),
            "--owner-checkout", str(self.owner_checkout),
            "--fifo-child",
        ], capture_output=True, text=True, timeout=5)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-source", type=Path, required=True)
    parser.add_argument("--owner-checkout", type=Path, required=True)
    parser.add_argument("--fifo-child", action="store_true")
    args, unittest_args = parser.parse_known_args()
    if args.fifo_child:
        suite = unittest.TestSuite([ComposedHermesWorkspaceTests("test_fifo_and_replacement_fifo_reads_return_without_blocking")])
    else:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(ComposedHermesWorkspaceTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
