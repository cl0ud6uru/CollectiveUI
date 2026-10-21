"""Exact-pin synthetic sidecar/startup/loader proof; no plugin execution or network.

HERMES_SOURCE=/clean/pinned/hermes python -B tests/native-plugin-selection.py
"""
from __future__ import annotations
import ast
import hashlib
import importlib
import importlib.util
import json
import os
from pathlib import Path
import py_compile
import queue
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(os.environ["HERMES_SOURCE"]).resolve()
PIN = "f97608f178d1ffeca59860195ab7da295f7c8e5f"
assert subprocess.check_output(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], text=True).strip() == PIN
assert not subprocess.check_output(["git", "-C", str(SOURCE), "status", "--porcelain", "--untracked-files=all"], text=True).strip()
TEMP = tempfile.TemporaryDirectory(prefix="collective-selection-proof-")
BASE = Path(TEMP.name).resolve()
COPY = BASE / "source"
COPY.mkdir()
archive = subprocess.Popen(["git", "-C", str(SOURCE), "archive", PIN], stdout=subprocess.PIPE)
with tarfile.open(fileobj=archive.stdout, mode="r|") as tar:
    tar.extractall(COPY, filter="data")
assert archive.wait() == 0
def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
installer = load(ROOT / "scripts/install-hermes-plugin-selection.py", "selection_installer_test")
workspace = load(ROOT / "scripts/install-hermes-workspace-files.py", "selection_workspace_test")
recovery = load(ROOT / "scripts/install-hermes-recovery.py", "selection_recovery_test")
owner = load(ROOT / "scripts/install-hermes-hub-owner.py", "selection_owner_test")
targets = set(recovery.TARGETS) | set(owner.TARGETS) | {"hermes_cli/plugins.py"}
originals = {name: (COPY / name).read_text() for name in targets}
for name, content in installer.patch_sources(originals, workspace, recovery, owner).items():
    (COPY / name).write_text(content)
for name, source in installer.MODULES.items():
    (COPY / name).write_bytes((ROOT / "src/hermes-recovery" / source).read_bytes())
HOME = BASE / "profile"
HOME.mkdir()
os.environ.update(HERMES_HOME=str(HOME), HERMES_DISABLE_LAZY_INSTALLS="1", HERMES_MANAGED="false")
os.environ.pop("HERMES_BUNDLED_PLUGINS", None)
sys.path.insert(0, str(COPY))
sys.dont_write_bytecode = True
def denied(*_args, **_kwargs):
    raise AssertionError("Network prohibited")
socket.socket.connect = denied
socket.create_connection = denied
from hermes_cli import collective_plugin_selection as store
from hermes_cli import config
from hermes_cli.plugins_manifest import parse_manifest_file
config.is_managed = lambda: False
config.managed_scope.managed_config_keys = lambda: set()
PACKAGE = COPY / "plugins" / store.KEY
MANIFEST = parse_manifest_file(PACKAGE / "plugin.yaml", PACKAGE, "bundled", "")


class SelectionProof(unittest.TestCase):
    def setUp(self):
        for file in HOME.glob(".collective-plugin-selection*"):
            file.unlink()
        shutil.rmtree(PACKAGE / "__pycache__", ignore_errors=True)
        self.config = "security: {redact_secrets: true}\nmodel: {provider: synthetic, api_key: '${SYNTHETIC_KEY}'}\nplugins: {enabled: [], disabled: [teams_pipeline]}\n"
        (HOME / "config.yaml").write_text(self.config)

    def test_import_is_read_only_and_never_imports_plugin(self):
        self.assertIsNone(store._startup[str(HOME)])
        self.assertNotIn("plugins.teams_pipeline", sys.modules)
        self.assertFalse((HOME / store.FILE).exists())
        self.assertFalse((HOME / store.LOCK).exists())

    def test_single_write_cas_readback_preserves_raw_config_and_frozen_snapshot(self):
        revision, selected, generation, committed = store._select(HOME, store.MISSING, True)
        self.assertTrue(selected)
        self.assertIsNone(committed)
        self.assertEqual(generation, 1)
        self.assertNotEqual(revision, store.MISSING)
        self.assertIsNone(store._startup[str(HOME)])
        self.assertEqual((HOME / "config.yaml").read_text(), self.config)
        self.assertEqual(store.overlay_startup(HOME, {store.KEY: MANIFEST}, {store.KEY}, set()), ({store.KEY}, set()))
        with self.assertRaises(ValueError):
            store._select(HOME, store.MISSING, False)
        self.assertEqual(store._select(HOME, revision, False)[2], 2)

    def test_cross_process_cas_writes_exactly_once(self):
        child = '''import os,socket,sys\ndef deny(*a,**k): raise AssertionError("network")\nsocket.socket.connect=deny\nsys.path.insert(0,sys.argv[1])\nfrom hermes_cli import collective_plugin_selection as s\ntry: s._select(__import__('pathlib').Path(sys.argv[2]),s.MISSING,True); print("written")\nexcept (ValueError,OSError): print("rejected")\n'''
        children = [subprocess.Popen([sys.executable, "-B", "-c", child, str(COPY), str(HOME)], stdout=subprocess.PIPE, text=True) for _ in range(2)]
        outputs = [child.communicate(timeout=10)[0].strip() for child in children]
        self.assertEqual(sorted(outputs), ["rejected", "written"])
        self.assertTrue(all(child.returncode == 0 for child in children))
        self.assertEqual((HOME / "config.yaml").read_text(), self.config)

    def test_fresh_process_snapshots_selection_before_pinned_initialization(self):
        store._select(HOME, store.MISSING, True)
        captured = {}
        def popen(argv, **kwargs):
            captured.update(argv=argv, env=kwargs["env"])
            return types.SimpleNamespace(stdout=[], stderr=[], stdin=None)
        class NoThread:
            def __init__(self, *_args, **_kwargs): pass
            def start(self): pass
        tree = ast.parse((COPY / "tui_gateway/server.py").read_text())
        node = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "_SlashWorker")
        namespace = {"sys": sys, "os": os, "Path": Path, "queue": queue, "__file__": str(COPY / "tui_gateway/server.py"),
            "threading": types.SimpleNamespace(Lock=threading.Lock, Thread=NoThread),
            "subprocess": types.SimpleNamespace(Popen=popen, PIPE=subprocess.PIPE),
            "_prepend_tool_paths": lambda env: env, "_hermes_home": HOME}
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(COPY / "tui_gateway/server.py"), "exec"), namespace)
        namespace["_SlashWorker"]("synthetic-session", "", profile_home=str(HOME))
        self.assertEqual(captured["argv"][1:3], ["-m", "tui_gateway.slash_worker"])
        child = '''import socket,sys,json\ndef deny(*a,**k): raise AssertionError("network")\nsocket.socket.connect=deny\nsys.path.insert(0,sys.argv[1])\nfrom pathlib import Path\nfrom hermes_cli import plugins as p\nfrom hermes_cli import collective_plugin_selection as s\nfrom hermes_cli.plugins_manifest import parse_manifest_file\nroot=Path(sys.argv[1]); home=Path(sys.argv[2]); package=root/'plugins'/s.KEY\nm=parse_manifest_file(package/'plugin.yaml',package,'bundled','')\nmanager=p.PluginManager(str(home)); captured=[]\nmanager._collect_directory_manifests=lambda:[m]\nmanager._scan_entry_points=lambda:[]\nmanager._gate_manifest=lambda manifest,disabled,enabled: captured.append((disabled,enabled)) or False\nmanager._refresh_plugin_compat_report=lambda manifests:None\np._get_disabled_plugins=lambda:{s.KEY}\np._get_enabled_plugins=lambda:set()\nmanager._discover_and_load_inner()\nexpected=json.loads(sys.argv[3])\nassert captured==([(set(),{s.KEY})] if expected else [({s.KEY},set())]),captured\nassert 'plugins.teams_pipeline' not in sys.modules\nassert s._startup[str(home)] is expected\nprint('actual worker environment and pinned initializer honor only explicit operator commitment; no plugin imported')\n'''
        def child_probe(expected):
            result = subprocess.run([sys.executable, "-B", "-c", child, str(COPY), str(HOME), json.dumps(expected)], env=captured["env"], capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
        # A newly spawned actual worker environment must not consume pending.
        child_probe(None)
        def revision():
            with store._locked(HOME) as fd: return store._state(fd, HOME)[0]
        store.promote_by_local_operator(HOME, revision(), store.IDENTITY)
        child_probe(True)
        store._select(HOME, revision(), False)
        child_probe(True)
        store.promote_by_local_operator(HOME, revision(), store.IDENTITY)
        child_probe(False)
        self.assertIsNone(store._startup[str(HOME)])

    def test_generation_exhaustion_refuses_before_mutation(self):
        store._select(HOME, store.MISSING, True)
        path = HOME / store.FILE
        value = json.loads(path.read_bytes()); value["generation"] = 2**53 - 1
        path.write_text(json.dumps(value))
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            store._select(HOME, hashlib.sha256(before).hexdigest(), False)
        self.assertEqual(path.read_bytes(), before)

    def test_local_confirmation_requires_exact_pending_revision_and_source(self):
        revision = store._select(HOME, store.MISSING, True)[0]
        before = (HOME / store.FILE).read_bytes()
        for expected, identity in [(store.MISSING, store.IDENTITY), (revision, "0" * 64)]:
            with self.assertRaises(ValueError): store.promote_by_local_operator(HOME, expected, identity)
            self.assertEqual((HOME / store.FILE).read_bytes(), before)
        promoted = store.promote_by_local_operator(HOME, revision, store.IDENTITY)
        self.assertTrue(promoted[3]); self.assertNotEqual(promoted[0], revision)
        self.assertEqual((HOME / "config.yaml").read_text(), self.config)

    def test_symlink_and_hardlink_sidecar_are_refused(self):
        target = BASE / "outside.json"; target.write_text("synthetic outside")
        (HOME / store.FILE).symlink_to(target)
        with self.assertRaises(OSError):
            store._select(HOME, store.MISSING, True)
        (HOME / store.FILE).unlink()
        os.link(target, HOME / store.FILE)
        with self.assertRaises(ValueError):
            store._select(HOME, store.MISSING, True)
        self.assertEqual(target.read_text(), "synthetic outside")

    def test_reviewed_source_cache_accepted_by_actual_loader_code_boundary(self):
        for name in store.HASHES:
            if name.endswith(".py"):
                for level in (0, 1, 2):
                    py_compile.compile(str(PACKAGE / name), doraise=True, optimize=level)
        store._eligible(COPY)
        spec = importlib.util.spec_from_file_location("selection_only_code_probe", PACKAGE / "__init__.py")
        code = spec.loader.get_code("selection_only_code_probe")
        reviewed_code = compile((PACKAGE / "__init__.py").read_bytes(), str(PACKAGE / "__init__.py"), "exec", dont_inherit=True)
        self.assertEqual(code, reviewed_code)
        self.assertNotIn("plugins.teams_pipeline", sys.modules)

    def test_source_identity_explicitly_does_not_attest_cached_executable(self):
        from importlib._bootstrap_external import _code_to_timestamp_pyc
        source = PACKAGE / "__init__.py"
        cache = Path(importlib.util.cache_from_source(str(source))); cache.parent.mkdir()
        info = source.stat()
        malicious = compile("UNREVIEWED_CACHE_EXECUTED = True", str(source), "exec")
        cache.write_bytes(_code_to_timestamp_pyc(malicious, int(info.st_mtime), info.st_size))
        # Deliberate trusted-installation residual, never execute this cache.
        # A local code-directory writer can replace the adapter too.
        store._eligible(COPY)
        self.assertNotIn("plugins.teams_pipeline", sys.modules)

    def test_overlay_rejects_source_shadow_alias_and_changed_package(self):
        frozen = {str(HOME): True}
        with patch.object(store, "_startup", frozen):
            self.assertEqual(store.overlay_startup(HOME, {store.KEY: MANIFEST}, {store.KEY}, set()), (set(), {store.KEY}))
            for field, value in [("source", "user"), ("source", "project"), ("path", str(BASE)), ("version", "0.2.0")]:
                changed = types.SimpleNamespace(**vars(MANIFEST)); setattr(changed, field, value)
                self.assertEqual(store.overlay_startup(HOME, {store.KEY: changed}, {store.KEY}, set()), ({store.KEY}, set()))
            for key, name in [("other", store.KEY), ("other/teams_pipeline", "different")]:
                other = types.SimpleNamespace(name=name)
                self.assertEqual(store.overlay_startup(HOME, {store.KEY: MANIFEST, key: other}, {store.KEY}, set()), ({store.KEY}, set()))
            extra = PACKAGE / "extra.py"; extra.write_text("raise AssertionError('must never import')")
            try:
                self.assertEqual(store.overlay_startup(HOME, {store.KEY: MANIFEST}, {store.KEY}, set()), ({store.KEY}, set()))
            finally:
                extra.unlink()

    def test_managed_and_bundle_override_are_refused(self):
        with patch.object(config, "is_managed", return_value=True):
            with self.assertRaises(ValueError): store._eligible(COPY)
        with patch.dict(os.environ, {"HERMES_BUNDLED_PLUGINS": str(PACKAGE.parent)}):
            with self.assertRaises(ValueError): store._eligible(COPY)


try:
    unittest.main(verbosity=2)
finally:
    TEMP.cleanup()
