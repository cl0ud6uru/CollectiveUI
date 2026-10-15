#!/usr/bin/env python3
"""Review-first composition of the pinned recovery and native hub-owner adapters.

Default mode validates the exact Hermes pin and writes nothing. `--apply` patches only a
clean checkout and installs the explicitly versioned CollectiveUI adapter modules.
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
TARGETS = ("tui_gateway/server.py", "tui_gateway/session_notifications.py", "tui_gateway/methods_prompt.py")
OWNER_MODULE = "tui_gateway/collective_hub_owner.py"


def once(text, before, after):
    if text.count(before) != 1:
        raise ValueError("Pinned integration point does not match; no patch applied")
    return text.replace(before, after, 1)


def patch_sources(originals):
    changes = dict(originals)
    server = changes["tui_gateway/server.py"]
    recovery = "from .collective_recovery import install as _install_collective_recovery\n_install_collective_recovery(sys.modules[__name__])\n"
    if server.count(recovery) != 1:
        raise ValueError("The exact v1 recovery adapter must be composed first")
    server = once(server, recovery, recovery + "\n# Explicit optional CollectiveUI native owner fence; not an upstream Hermes capability.\nfrom .collective_hub_owner import install as _install_collective_hub_owner\n_install_collective_hub_owner(sys.modules[__name__])\n")
    server = once(server, "threading.Thread(target=_build, daemon=True)", "threading.Thread(target=_collective_hub_owner.protect_worker(_build, session), daemon=True)")
    server = once(server, "threading.Thread(target=_run, daemon=True).start()",
                  "_collective_hub_owner.start_resume_thread(_run, _sessions.get(sid), f'tui-resume-hydration-{sid}')")
    changes["tui_gateway/server.py"] = server
    changes["tui_gateway/session_notifications.py"] = once(
        changes["tui_gateway/session_notifications.py"],
        "target=_notification_poller_loop, args=(stop, sid, session)",
        "target=_collective_hub_owner.protect_worker(_notification_poller_loop, session), args=(stop, sid, session)",
    )
    prompt = changes["tui_gateway/methods_prompt.py"]
    prompt = once(prompt, "    run_thread = threading.Thread(\n        target=lambda:",
                  "    from tui_gateway import server as _owner_server\n    run_thread = threading.Thread(\n        target=_owner_server._collective_hub_owner.protect_worker(lambda:")
    prompt = once(prompt,
                  "rid, sid, session, text, display_kind, display_metadata, hosted_terminal_callback, turn_author),\n        daemon=True)",
                  "rid, sid, session, text, display_kind, display_metadata, hosted_terminal_callback, turn_author), session),\n        daemon=True)")
    changes["tui_gateway/methods_prompt.py"] = prompt
    for text in changes.values():
        ast.parse(text)
    return changes


def load_installer(path):
    spec = importlib.util.spec_from_file_location("collective_recovery_installer", path)
    if spec is None or spec.loader is None:
        raise ValueError("Cannot load the approved recovery installer")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def atomic(path, data):
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-source", type=Path, required=True)
    parser.add_argument("--recovery-installer", type=Path, required=True,
                        help="Path to the separately reviewed exact-pin issue #90 installer")
    parser.add_argument("--apply", action="store_true", help="Apply validated source patch; default is read-only")
    args = parser.parse_args()
    root = args.hermes_source.resolve()
    recovery_installer = args.recovery_installer.resolve()
    if subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip() != PIN:
        raise SystemExit("Unsupported Hermes revision; review and port the patch first")
    if subprocess.check_output(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=all"], text=True).strip():
        raise SystemExit("A clean exact source checkout is required; nothing changed")
    recovery = load_installer(recovery_installer)
    originals = {name: (root / name).read_text() for name in set(recovery.TARGETS) | set(TARGETS)}
    recovery_changes = recovery.patch_sources({name: originals[name] for name in recovery.TARGETS})
    combined = dict(originals)
    combined.update(recovery_changes)
    changes = patch_sources(combined)
    recovery_module = (recovery_installer.parent.parent / "src/hermes-recovery/native_recovery.py").read_bytes()
    owner_module = (ROOT / "src/hermes-recovery/native_hub_owner.py").read_bytes()
    ast.parse(recovery_module)
    ast.parse(owner_module)
    installed_paths = [root / recovery.MODULE, root / OWNER_MODULE]
    if any(path.exists() for path in installed_paths):
        raise SystemExit("An adapter module already exists; source checkout not pristine")
    print("Validated the exact pinned Hermes source with native cancel/drain then hub-owner adapters")
    print("Hub-owner adapter SHA-256: " + hashlib.sha256(owner_module).hexdigest())
    if not args.apply:
        print("Read-only validation complete; no source, services or configuration changed")
        return
    try:
        atomic(root / recovery.MODULE, recovery_module)
        atomic(root / OWNER_MODULE, owner_module)
        for name, text in changes.items():
            atomic(root / name, text.encode())
    except BaseException:
        for name, text in originals.items():
            atomic(root / name, text.encode())
        for path in installed_paths:
            path.unlink(missing_ok=True)
        raise
    print("Source patch applied; no service restarted or policy/authentication changed")


if __name__ == "__main__":
    main()
