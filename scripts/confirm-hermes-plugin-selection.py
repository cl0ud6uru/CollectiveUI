#!/usr/bin/env python3
"""Inspect or explicitly promote a pending ordinary-plugin selection locally.

Never run by the portal. Promotion authorizes later native initializations,
including automatically created workers; it does not activate/reload anything.
No shared configuration, credentials, provider or security settings are written.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PIN = "f97608f178d1ffeca59860195ab7da295f7c8e5f"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-source", type=Path, required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--expected-revision")
    parser.add_argument("--expected-identity")
    parser.add_argument("--confirm-future-native-initializations", action="store_true")
    args = parser.parse_args()
    source = args.hermes_source.resolve()
    if subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip() != PIN:
        raise SystemExit("Unsupported Hermes source pin")
    installed = source / "hermes_cli/collective_plugin_selection.py"
    expected = ROOT / "src/hermes-recovery/native_plugin_selection_store.py"
    if not installed.is_file() or hashlib.sha256(installed.read_bytes()).digest() != hashlib.sha256(expected.read_bytes()).digest():
        raise SystemExit("The reviewed selection store is not installed; no preference changed")
    sys.path.insert(0, str(source))
    from hermes_cli.profiles import get_profile_dir, validate_profile_name
    from hermes_cli import collective_plugin_selection as store
    validate_profile_name(args.profile)
    home = get_profile_dir(args.profile).resolve(strict=True)
    store._eligible(source)
    if args.confirm_future_native_initializations:
        if not args.expected_revision or not args.expected_identity:
            raise SystemExit("Review the exact pending revision and source identity before explicit confirmation")
        revision, pending, _generation, committed = store.promote_by_local_operator(home, args.expected_revision, args.expected_identity)
    else:
        # Read-only inspection never creates a lock or profile file.
        import os
        fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            revision, pending, _generation, committed = store._state(fd, home)
        finally:
            os.close(fd)
    print(json.dumps({"key": store.KEY, "reviewed_source_identity": store.IDENTITY, "revision": revision,
        "pending_selection": pending, "operator_committed_selection": committed,
        "loaded_state": "unreported", "future_initializations_including_workers_authorized": args.confirm_future_native_initializations}))


if __name__ == "__main__":
    main()
