#!/usr/bin/env python3
"""Review-first exact-pin composition of the native read-only workspace browser.

Default mode validates the pinned Hermes source and installer composition without
writing. Applying requires the separately reviewed #247 recovery and #96 owner
installers; the new method is registered before the owner fence is installed.
No service, profile configuration, workspace permission, or secret is changed.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile

PIN = "f97608f178d1ffeca59860195ab7da295f7c8e5f"
ROOT = Path(__file__).resolve().parents[1]
MODULE = "tui_gateway/collective_workspace_files.py"
SOURCE = ROOT / "src/hermes-recovery/native_workspace_files.py"
OWNER_IMPORT = (
    "# Explicit optional CollectiveUI native owner fence; not an upstream Hermes capability.\n"
    "from .collective_hub_owner import install as _install_collective_hub_owner\n"
    "_install_collective_hub_owner(sys.modules[__name__])"
)
WORKSPACE_IMPORT = (
    "# Explicit optional CollectiveUI read-only workspace files adapter; not an upstream Hermes method.\n"
    "from .collective_workspace_files import install as _install_collective_workspace_files\n"
    "_install_collective_workspace_files(sys.modules[__name__])"
)


def once(text: str, before: str, after: str) -> str:
    if text.count(before) != 1:
        raise ValueError("The exact pinned Hermes installer composition does not match; nothing was written")
    return text.replace(before, after, 1)


def load_installer(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ValueError(f"Cannot load the required {name} installer")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def patch_sources(originals: dict[str, str], recovery, owner) -> dict[str, str]:
    recovery_inputs = {name: originals[name] for name in recovery.TARGETS}
    recovery_changes = recovery.patch_sources(recovery_inputs)
    combined = dict(originals)
    combined.update(recovery_changes)
    owner_changes = owner.patch_sources(combined)
    server_path = "tui_gateway/server.py"
    server = once(owner_changes[server_path], OWNER_IMPORT, WORKSPACE_IMPORT + "\n" + OWNER_IMPORT)
    # This exact order is part of the authorization boundary: workspace.register_method
    # must run before install_hub_owner snapshots and wraps the native method table.
    if server.index(WORKSPACE_IMPORT) > server.index(OWNER_IMPORT):
        raise ValueError("Workspace registration must precede the native owner fence")
    owner_changes[server_path] = server
    for text in owner_changes.values():
        ast.parse(text)
    return owner_changes


def atomic(path: Path, data: bytes) -> None:
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-source", type=Path, required=True)
    parser.add_argument("--recovery-installer", type=Path, required=True,
                        help="Separately reviewed #247 exact-pin installer")
    parser.add_argument("--owner-installer", type=Path, required=True,
                        help="Separately reviewed #96 exact-pin owner installer")
    parser.add_argument("--apply", action="store_true", help="Apply validated source adapter; default is read-only")
    args = parser.parse_args()
    root = args.hermes_source.resolve()
    if subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip() != PIN:
        raise SystemExit("Unsupported Hermes revision; review and port the adapter first")
    recovery = load_installer(args.recovery_installer.resolve(), "collective_recovery_installer")
    owner = load_installer(args.owner_installer.resolve(), "collective_hub_owner_installer")
    targets = set(recovery.TARGETS) | set(owner.TARGETS) | {"tui_gateway/server.py"}
    dirty = subprocess.check_output(["git", "-C", str(root), "status", "--porcelain", "--", *sorted(targets)], text=True)
    installed = [root / recovery.MODULE, root / owner.OWNER_MODULE, root / MODULE]
    if dirty or any(path.exists() for path in installed):
        raise SystemExit("A clean exact source checkout with no installed adapter modules is required")
    originals = {name: (root / name).read_text() for name in targets}
    changes = patch_sources(originals, recovery, owner)
    workspace_module = SOURCE.read_bytes()
    ast.parse(workspace_module)
    recovery_module = (args.recovery_installer.resolve().parent.parent / "src/hermes-recovery/native_recovery.py").read_bytes()
    owner_module = (args.owner_installer.resolve().parent.parent / "src/hermes-recovery/native_hub_owner.py").read_bytes()
    ast.parse(recovery_module)
    ast.parse(owner_module)
    print("Validated #247 recovery → #95 workspace method → #96 owner fence on the exact pinned Hermes source")
    print("Workspace adapter SHA-256: " + hashlib.sha256(workspace_module).hexdigest())
    if not args.apply:
        print("Read-only validation complete; no source, runtime, workspace permissions, or configuration changed")
        return
    modules = {recovery.MODULE: recovery_module, owner.OWNER_MODULE: owner_module, MODULE: workspace_module}
    written: list[Path] = []
    try:
        for name, data in modules.items():
            path = root / name
            atomic(path, data)
            written.append(path)
        for name, text in changes.items():
            atomic(root / name, text.encode())
    except BaseException:
        for name, text in originals.items():
            atomic(root / name, text.encode())
        for path in written:
            path.unlink(missing_ok=True)
        raise
    print("Source adapter installed; no service was restarted and no profile grant was created")


if __name__ == "__main__":
    main()
