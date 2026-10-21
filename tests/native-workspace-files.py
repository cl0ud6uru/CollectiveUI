"""Synthetic endpoint coverage for the exact-pin native workspace adapter.

Runs without a live Hermes gateway, network, profile grant, or external file fixture:
`python3 tests/native-workspace-files.py`.
"""
from __future__ import annotations

import contextvars
import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = types.ModuleType("tui_gateway")
PACKAGE.__path__ = []
import sys
sys.modules["tui_gateway"] = PACKAGE

contracts = types.ModuleType("tui_gateway.contracts")
contracts.__path__ = []
sys.modules["tui_gateway.contracts"] = contracts


class _Field:
    def __init__(self, default=None, default_factory=None):
        self.default = default
        self.default_factory = default_factory


def _field(*, default=None, default_factory=None, **_kwargs):
    return _Field(default, default_factory)


class _Model:
    def __init__(self, **values):
        for parent in reversed(type(self).__mro__):
            for name in getattr(parent, "__annotations__", {}):
                if name in self.__dict__:
                    continue
                default = getattr(type(self), name, None)
                if isinstance(default, _Field):
                    default = default.default_factory() if default.default_factory else default.default
                    self.__dict__[name] = default
                elif default is not None:
                    self.__dict__[name] = default
        self.__dict__.update(values)

    @classmethod
    def model_validate(cls, values):
        return cls(**values)

    def model_dump(self):
        return self.__dict__.copy()


base = types.ModuleType("tui_gateway.contracts.base")
base.Params = type("Params", (_Model,), {})
base.Result = type("Result", (_Model,), {})
sys.modules["tui_gateway.contracts.base"] = base
registry = types.ModuleType("tui_gateway.contracts.registry")
registry.method = lambda *_args, **_kwargs: None
sys.modules["tui_gateway.contracts.registry"] = registry
transport = types.ModuleType("tui_gateway.transport")
_current_transport = contextvars.ContextVar("workspace_test_transport", default=None)
transport.current_transport = _current_transport.get
sys.modules["tui_gateway.transport"] = transport
rpc_dispatch = types.ModuleType("tui_gateway.rpc_dispatch")
rpc_dispatch._LONG_HANDLERS = frozenset()
sys.modules["tui_gateway.rpc_dispatch"] = rpc_dispatch
pydantic = types.ModuleType("pydantic")
pydantic.Field = _field
sys.modules["pydantic"] = pydantic

owner_module = types.ModuleType("tui_gateway.collective_hub_owner")
owner_module._active_binding = contextvars.ContextVar("owner_binding", default=None)
sys.modules["tui_gateway.collective_hub_owner"] = owner_module

spec = importlib.util.spec_from_file_location("collective_workspace_files", ROOT / "src/hermes-recovery/native_workspace_files.py")
workspace_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = workspace_module
spec.loader.exec_module(workspace_module)


class _Workdir:
    def __init__(self):
        self.config_backend = "local"

    @staticmethod
    def _persisted_session_cwd(session):
        return session.get("cwd") if session.get("explicit_cwd") and not session.get("cwd_from_settle") else None

    @staticmethod
    def _is_local_terminal_backend():
        return True

    def _effective_terminal_backend(self):
        env_backend = os.environ.get("TERMINAL_ENV", "").strip().lower()
        if env_backend and env_backend != "local":
            return env_backend
        return self.config_backend or "local"


class _Server:
    def __init__(self, profile_home, session, transport_obj):
        self._hermes_home = profile_home
        self._sessions = {"runtime-session": session}
        self._session_workdir = _Workdir()
        self._persisted_session_cwd = self._session_workdir._persisted_session_cwd
        self._effective_terminal_backend = self._session_workdir._effective_terminal_backend
        self._LONG_HANDLERS = frozenset()
        self._rpc_dispatch = rpc_dispatch
        self._transport_obj = transport_obj
        self._profile_home = lambda _profile: profile_home
        self._session_home = lambda _session: profile_home
        self._current_session_steer_authority = lambda sid: (transport_obj, session) if sid == "runtime-session" and _current_transport.get() is transport_obj else (None, None)
        self._session_live_status = lambda _sid, _session: "idle"
        self._inflight_snapshot = lambda _session: None
        self._queued_prompt_snapshot = lambda _session: None
        self._session_has_active_delegations = lambda _sid, _session: False
        self._methods = {}

    def register_method(self, name, fn):
        self._methods[name] = fn

    @staticmethod
    def _ok(rid, result):
        return {"id": rid, "result": result}

    @staticmethod
    def _err(rid, code, message):
        return {"id": rid, "error": {"code": code, "message": message}}


class WorkspaceFilesEndpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.base = Path(self.temp.name)
        self.home = self.base / "profile"
        self.home.mkdir()
        self.workspace = self.base / "workspace"
        self.workspace.mkdir()
        (self.workspace / "src").mkdir()
        (self.workspace / "src" / "main.py").write_text("print('synthetic')\n", encoding="utf8")
        (self.workspace / "README.md").write_text("Synthetic read-only fixture\n", encoding="utf8")
        (self.workspace / ".env").write_text("SYNTHETIC_SECRET=never-return", encoding="utf8")
        (self.workspace / "my-secret.txt").write_text("never-return", encoding="utf8")
        (self.workspace / "access-token.txt").write_text("never-return", encoding="utf8")
        (self.workspace / "outside-link").symlink_to(self.base / "outside.txt")
        (self.base / "outside.txt").write_text("outside", encoding="utf8")
        outside_credential = self.base / "credential-source.txt"
        outside_credential.write_text("synthetic secret", encoding="utf8")
        os.link(outside_credential, self.workspace / "ordinary-name.txt")
        db = sqlite3.connect(self.home / "projects.db")
        db.executescript("CREATE TABLE projects (id TEXT, name TEXT, archived INTEGER); CREATE TABLE project_folders (project_id TEXT, path TEXT);")
        db.execute("INSERT INTO projects VALUES ('project-1', 'Synthetic project', 0)")
        db.execute("INSERT INTO project_folders VALUES ('project-1', ?)", (str(self.workspace),))
        db.commit(); db.close()
        self.transport_obj = object()
        self.session = {"cwd": str(self.workspace), "explicit_cwd": True, "cwd_from_settle": False,
            "profile_home": str(self.home), "source": "desktop", "_compute_host_active": False,
            "history_lock": threading.Lock()}
        self.server = _Server(str(self.home), self.session, self.transport_obj)
        self.handle = workspace_module.install(self.server)

    def tearDown(self):
        self.temp.cleanup()

    def call(self, **params):
        token = _current_transport.set(self.transport_obj)
        binding = types.SimpleNamespace(phase="full", profile="test-profile", home=str(self.home), transport=self.transport_obj)
        owner_token = owner_module._active_binding.set(binding)
        try:
            return self.handle("request-1", {"profile": "test-profile", "session_id": "runtime-session", **params})
        finally:
            owner_module._active_binding.reset(owner_token)
            _current_transport.reset(token)

    def test_list_and_read_are_root_relative_and_bounded(self):
        listing = self.call(action="list")
        if "error" in listing:
            self.fail(listing["error"]["message"])
        result = listing["result"]
        self.assertTrue(result["available"])
        self.assertEqual(result["path"], ".")
        self.assertEqual({row["name"] for row in result["entries"]}, {"README.md", "src"})
        self.assertNotIn(str(self.workspace), str(result))
        workspace_id = result["workspace_id"]
        read = self.call(action="read", workspace_id=workspace_id, path="README.md")["result"]
        self.assertEqual(read["content"], "Synthetic read-only fixture\n")

    def test_traversal_secret_symlink_and_wrong_workspace_fail_closed(self):
        listing = self.call(action="list")["result"]
        workspace_id = listing["workspace_id"]
        for bad_path in ("../outside.txt", "/etc/passwd", "src/../../outside.txt", ".env", "my-secret.txt", "access-token.txt", "outside-link", "ordinary-name.txt"):
            response = self.call(action="read", workspace_id=workspace_id, path=bad_path)
            self.assertIn("error", response, bad_path)
        response = self.call(action="read", workspace_id="0" * 32, path="README.md")
        self.assertIn("error", response)

    def test_directory_listing_has_a_hard_entry_cap(self):
        for index in range(110):
            (self.workspace / f"file-{index:03}.txt").write_text("x", encoding="utf8")
        result = self.call(action="list")["result"]
        self.assertEqual(len(result["entries"]), 100)
        self.assertTrue(result["truncated"])

    def test_fifo_and_regular_to_fifo_replacement_do_not_block(self):
        completed = subprocess.run([sys.executable, __file__, "--fifo-probe"], capture_output=True, text=True, timeout=3)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

    def test_no_owner_fence_or_non_idle_session_cannot_access(self):
        token = _current_transport.set(self.transport_obj)
        owner_token = owner_module._active_binding.set(None)
        try:
            self.assertIn("error", self.handle("request-2", {"profile": "test-profile", "session_id": "runtime-session", "action": "list"}))
        finally:
            owner_module._active_binding.reset(owner_token)
            _current_transport.reset(token)
        self.server._session_live_status = lambda _sid, _session: "working"
        self.assertIn("error", self.call(action="list"))

    def test_configured_nonlocal_backend_is_rejected_without_terminal_env(self):
        previous = os.environ.pop("TERMINAL_ENV", None)
        try:
            for backend in ("docker", "ssh"):
                self.server._session_workdir.config_backend = backend
                response = self.call(action="list")
                self.assertIn("error", response, backend)
                self.assertIsNone(workspace_module._project_root(self.server, "test-profile", self.session), backend)
        finally:
            self.server._session_workdir.config_backend = "local"
            if previous is not None:
                os.environ["TERMINAL_ENV"] = previous

    def test_broad_shared_roots_are_never_project_roots(self):
        for root in (
            "/", "/Applications", "/home", "/Library", "/media", "/mnt",
            "/opt", "/private", "/private/tmp", "/run", "/srv", "/tmp",
            "/Users", "/Volumes",
        ):
            self.assertFalse(workspace_module._root_is_approved(root, "/home/synthetic-user"), root)
        # Reject the exact shared roots, while allowing a specific project child
        # to proceed through the remaining project/session authorization checks.
        for root in ("/tmp/myrepo", "/private/tmp/myrepo", "/mnt/myrepo"):
            self.assertTrue(workspace_module._root_is_approved(root, "/home/synthetic-user"), root)

    def test_launch_fallback_settled_cwd_and_archived_project_are_not_roots(self):
        self.session["explicit_cwd"] = False
        self.assertFalse(self.call(action="list")["result"]["available"])
        self.session["explicit_cwd"] = True
        self.session["cwd_from_settle"] = True
        self.assertFalse(self.call(action="list")["result"]["available"])
        self.session["cwd_from_settle"] = False
        db = sqlite3.connect(self.home / "projects.db")
        db.execute("UPDATE projects SET archived=1")
        db.commit(); db.close()
        self.assertFalse(self.call(action="list")["result"]["available"])


def _fifo_probe():
    fixture = WorkspaceFilesEndpointTests("test_list_and_read_are_root_relative_and_bounded")
    fixture.setUp()
    try:
        workspace_id = fixture.call(action="list")["result"]["workspace_id"]
        os.mkfifo(fixture.workspace / "guessed-pipe")
        result = fixture.call(action="read", workspace_id=workspace_id, path="guessed-pipe")
        if "error" not in result:
            raise AssertionError("A guessed FIFO path must be rejected")

        swapped = fixture.workspace / "listed-regular.txt"
        swapped.write_text("synthetic regular file", encoding="utf8")
        original_open = os.open
        replaced = False

        def replace_before_final_open(path, flags, *args, **kwargs):
            nonlocal replaced
            if path == "listed-regular.txt" and not replaced:
                swapped.unlink()
                os.mkfifo(swapped)
                replaced = True
            return original_open(path, flags, *args, **kwargs)

        workspace_module.os.open = replace_before_final_open
        try:
            result = fixture.call(action="read", workspace_id=workspace_id, path="listed-regular.txt")
        finally:
            workspace_module.os.open = original_open
        if not replaced or "error" not in result:
            raise AssertionError("A regular file replaced by a FIFO must be rejected")
    finally:
        fixture.tearDown()


if __name__ == "__main__":
    if sys.argv[1:] == ["--fifo-probe"]:
        _fifo_probe()
    else:
        unittest.main()
