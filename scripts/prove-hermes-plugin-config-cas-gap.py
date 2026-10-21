"""Reproduce the shared-config CAS gap using only disposable synthetic settings.

This is a diagnostic for an unsupported native preference implementation, not a
feature test or installer. It intentionally proves lost updates at the reviewed
Hermes pin; do not run against a live profile or an installed adapter checkout.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--hermes-source", type=Path, required=True)
args = parser.parse_args()
SOURCE = args.hermes_source.resolve()
PIN = "f97608f178d1ffeca59860195ab7da295f7c8e5f"
assert subprocess.check_output(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], text=True).strip() == PIN
assert not subprocess.check_output(["git", "-C", str(SOURCE), "status", "--porcelain", "--untracked-files=all"], text=True).strip()
sys.path.insert(0, str(SOURCE))


def denied(*args, **kwargs):
    raise AssertionError("Network access is prohibited in this synthetic proof")


socket.socket.connect = denied
socket.create_connection = denied

with tempfile.TemporaryDirectory(prefix="plugin-preference-cas-") as directory:
    home = Path(directory)
    os.environ["HERMES_HOME"] = str(home)
    os.environ["HERMES_MANAGED"] = "false"
    from hermes_cli import config
    from utils import fast_safe_load

    config.get_config_path = lambda: home / "config.yaml"
    config.ensure_hermes_home = lambda: None
    config.is_managed = lambda: False
    config.managed_scope.managed_config_keys = lambda: set()
    path = config.get_config_path()
    original = {
        "plugins": {"enabled": [], "disabled": ["teams_pipeline"]},
        "security": {"redact_secrets": True},
        "model": {"default": "synthetic-model", "api_key": "${SYNTHETIC_KEY}"},
        "dashboard": {"basic_auth": {"username": "synthetic", "password": "${SYNTHETIC_PASS}"}},
        "display": {"compact": False},
    }

    def reset():
        path.write_text(json.dumps(original))
        config._RAW_CONFIG_CACHE.clear()
        config._LOAD_CONFIG_CACHE.clear()
        config._LAST_EXPANDED_CONFIG_BY_PATH.clear()

    def raw():
        return fast_safe_load(path.read_text())

    def candidate_preference_cas(expected):
        # Strongest bounded use of existing native primitives: shared in-process
        # config lock, exact raw revision, one write, only the approved target.
        with config._CONFIG_LOCK:
            data = path.read_bytes()
            assert hashlib.sha256(data).hexdigest() == expected
            current = fast_safe_load(data)
            current["plugins"]["enabled"] = ["teams_pipeline"]
            current["plugins"]["disabled"] = []
            config.atomic_config_write(path, current)
            return hashlib.sha256(path.read_bytes()).hexdigest()

    reset()
    candidate_preference_cas(hashlib.sha256(path.read_bytes()).hexdigest())
    expected = copy.deepcopy(original)
    expected["plugins"] = {"enabled": ["teams_pipeline"], "disabled": []}
    assert raw() == expected
    print("PASS: one raw locked update preserves unrelated synthetic security/auth/provider/env-reference values")

    for writer in ("atomic_config_write", "save_config"):
        reset()
        read_finished = threading.Event()
        preference_finished = threading.Event()
        failures = []

        def unrelated_save():
            try:
                # Native callers may construct their save payload outside the
                # save_config critical section. Hold that pre-edit snapshot.
                stale = config.read_user_config_raw()
                stale["display"]["compact"] = True
                read_finished.set()
                assert preference_finished.wait(5)
                if writer == "save_config":
                    config.save_config(stale, strip_defaults=False)
                else:
                    config.atomic_config_write(path, stale)
            except BaseException as error:
                failures.append(error)

        thread = threading.Thread(target=unrelated_save)
        thread.start()
        assert read_finished.wait(5)
        candidate_preference_cas(hashlib.sha256(path.read_bytes()).hexdigest())
        assert raw()["plugins"]["enabled"] == ["teams_pipeline"]
        preference_finished.set()
        thread.join(5)
        assert not thread.is_alive()
        assert not failures, failures
        after = raw()
        assert after["display"]["compact"] is True
        assert after["plugins"] == original["plugins"]
        print(f"REPRODUCED: stale unrelated {writer} overwrites completed preference CAS despite native RLock")

    reset()
    child = r'''
import os, socket, sys
from pathlib import Path
def denied(*args, **kwargs):
    raise AssertionError("No network")
socket.socket.connect = denied
socket.create_connection = denied
sys.path.insert(0, sys.argv[1])
os.environ["HERMES_HOME"] = sys.argv[2]
from hermes_cli import config
config.get_config_path = lambda: Path(sys.argv[2]) / "config.yaml"
config.ensure_hermes_home = lambda: None
config.is_managed = lambda: False
config.managed_scope.managed_config_keys = lambda: set()
current = config.read_user_config_raw()
current["display"]["compact"] = True
config.save_config(current, strip_defaults=False)
assert config.read_user_config_raw()["display"]["compact"] is True
'''
    with config._CONFIG_LOCK:
        expected_revision = hashlib.sha256(path.read_bytes()).hexdigest()
        data = path.read_bytes()
        assert hashlib.sha256(data).hexdigest() == expected_revision
        pending = fast_safe_load(data)
        pending["plugins"] = {"enabled": ["teams_pipeline"], "disabled": []}
        # An actual second process is not held by this native RLock and commits
        # after the expected-revision read but before full-state replacement.
        subprocess.run([sys.executable, "-c", child, str(SOURCE), str(home)], check=True, timeout=10)
        assert raw()["display"]["compact"] is True
        config.atomic_config_write(path, pending)
        assert raw()["plugins"]["enabled"] == ["teams_pipeline"]
        assert raw()["display"]["compact"] is False
    print("REPRODUCED: preference revision-check/write loses intervening separate-process unrelated save while RLock is held")

print("No plugin imports, discovery, toggle, activation, reload, restart, live profile, or network call occurred")
