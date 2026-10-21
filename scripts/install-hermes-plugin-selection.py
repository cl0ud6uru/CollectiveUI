#!/usr/bin/env python3
"""Review-first exact-pin selection sidecar + startup-only loader overlay.

Default validates without writing. --apply only patches a clean disposable/source
checkout; it never edits a profile, loads a plugin or starts/restarts a service.
"""
from __future__ import annotations
import argparse
import ast
import hashlib
from pathlib import Path
import subprocess

import importlib.util

ROOT = Path(__file__).resolve().parents[1]
PIN = "f97608f178d1ffeca59860195ab7da295f7c8e5f"
MODULES = {"tui_gateway/collective_plugin_selection.py": "native_plugin_selection.py",
    "hermes_cli/collective_plugin_selection.py": "native_plugin_selection_store.py"}


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def patch_sources(originals, workspace, recovery, owner):
    changes = workspace.patch_sources(originals, recovery, owner)
    anchor = workspace.OWNER_IMPORT
    extra = ("# Explicit selection-only plugin sidecar; not an upstream Hermes capability.\n"
        "from .collective_plugin_selection import install as _install_collective_plugin_selection\n"
        "_install_collective_plugin_selection(sys.modules[__name__])\n")
    changes["tui_gateway/server.py"] = workspace.once(changes["tui_gateway/server.py"], anchor, extra + anchor)
    plugins = originals["hermes_cli/plugins.py"]
    plugins = workspace.once(plugins, "\n\ndef get_bundled_plugins_dir() -> Path:",
        "\n\n# Freeze selection before any plugin discovery, including CLI serve startup.\n"
        "from hermes_cli.collective_plugin_selection import overlay_startup as _collective_selection_overlay\n"
        "\n\ndef get_bundled_plugins_dir() -> Path:")
    plugins = workspace.once(plugins, "        winners = resolve_manifest_winners(manifests)\n",
        "        winners = resolve_manifest_winners(manifests)\n"
        "        disabled, enabled = _collective_selection_overlay(self.home_path, winners, disabled, enabled)\n")
    changes["hermes_cli/plugins.py"] = plugins
    for text in changes.values():
        ast.parse(text)
    return changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-source", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    root = args.hermes_source.resolve()
    if subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip() != PIN:
        raise SystemExit("Unsupported Hermes source pin")
    if subprocess.check_output(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=all"], text=True).strip():
        raise SystemExit("A clean source checkout is required; no patch applied")
    workspace = load(ROOT / "scripts/install-hermes-workspace-files.py", "selection_workspace")
    recovery = load(ROOT / "scripts/install-hermes-recovery.py", "selection_recovery")
    owner = load(ROOT / "scripts/install-hermes-hub-owner.py", "selection_owner")
    targets = set(recovery.TARGETS) | set(owner.TARGETS) | {"hermes_cli/plugins.py"}
    originals = {name: (root / name).read_text() for name in targets}
    changes = patch_sources(originals, workspace, recovery, owner)
    modules = {recovery.MODULE: (ROOT / "src/hermes-recovery/native_recovery.py").read_bytes(),
        owner.OWNER_MODULE: (ROOT / "src/hermes-recovery/native_hub_owner.py").read_bytes(),
        workspace.MODULE: (ROOT / "src/hermes-recovery/native_workspace_files.py").read_bytes(),
        **{name: (ROOT / "src/hermes-recovery" / source).read_bytes() for name, source in MODULES.items()}}
    if any((root / name).exists() for name in modules):
        raise SystemExit("An adapter module exists already; no patch applied")
    for name, data in modules.items():
        ast.parse(data)
        print(name + " SHA256 " + hashlib.sha256(data).hexdigest())
    if not args.apply:
        print("Validated selection-only composition; no source, profile, service or configuration changed")
        return
    written = []
    try:
        for name, data in modules.items():
            workspace.atomic(root / name, data)
            written.append(root / name)
        for name, text in changes.items():
            workspace.atomic(root / name, text.encode())
    except BaseException:
        for name, text in originals.items():
            workspace.atomic(root / name, text.encode())
        for path in written:
            path.unlink(missing_ok=True)
        raise
    print("Installed source only; no plugin activation, reload, profile write or restart occurred")


if __name__ == "__main__":
    main()
