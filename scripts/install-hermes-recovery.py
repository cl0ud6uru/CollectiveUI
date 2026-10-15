#!/usr/bin/env python3
"""Review-first exact-pin native recovery adapter installer; no services/configuration."""
import argparse
import ast
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

PIN = "f97608f178d1ffeca59860195ab7da295f7c8e5f"
ROOT = Path(__file__).resolve().parents[1]
MODULE = "tui_gateway/collective_recovery.py"
TARGETS = ("tui_gateway/server.py", "tui_gateway/session_auto_continue.py", "tui_gateway/methods_prompt.py")


def once(text, before, after):
    if text.count(before) != 1:
        raise ValueError("Pinned integration point does not match; no patch applied")
    return text.replace(before, after, 1)


def patch_sources(originals):
    changes = dict(originals)
    changes[TARGETS[0]] = once(changes[TARGETS[0]], "del _m\n", "del _m\n\n# Explicit optional CollectiveUI protocol adapter; not an upstream native capability.\nfrom .collective_recovery import install as _install_collective_recovery\n_install_collective_recovery(sys.modules[__name__])\n")
    changes[TARGETS[1]] = once(changes[TARGETS[1]], '_start_session_work(kickoff, name=f"auto-continue-{sid}")', '_collective_start_auxiliary_work(kickoff, name=f"auto-continue-{sid}", session=session)')
    changes[TARGETS[2]] = once(changes[TARGETS[2]], '_start_session_work(run, name=f"side-agent-{task_id}")', '_collective_start_auxiliary_work(run, name=f"side-agent-{task_id}", session=session)')
    for text in changes.values():
        ast.parse(text)
    return changes


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
    parser.add_argument("--apply", action="store_true", help="Apply only the reviewed source patch; default validates without changing files")
    args = parser.parse_args()
    root = args.hermes_source.resolve()
    if subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip() != PIN:
        raise SystemExit("Unsupported Hermes revision; review and port the patch first")
    if subprocess.check_output(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=all"], text=True).strip() or (root / MODULE).exists():
        raise SystemExit("A clean exact source checkout is required; nothing changed")
    originals = {name: (root / name).read_text() for name in TARGETS}
    changes = patch_sources(originals)
    module = (ROOT / "src/hermes-recovery/native_recovery.py").read_bytes()
    ast.parse(module)
    print("Validated collective.cancel-drain.v1 against exact pinned source")
    print("Adapter SHA-256: " + hashlib.sha256(module).hexdigest())
    if not args.apply:
        print("Read-only validation complete; no source, services or configuration changed")
        return
    try:
        atomic(root / MODULE, module)
        for name, text in changes.items():
            atomic(root / name, text.encode())
    except BaseException:
        for name, text in originals.items():
            atomic(root / name, text.encode())
        (root / MODULE).unlink(missing_ok=True)
        raise
    print("Source patch applied; no service restarted or policy/authentication changed")


if __name__ == "__main__":
    main()
