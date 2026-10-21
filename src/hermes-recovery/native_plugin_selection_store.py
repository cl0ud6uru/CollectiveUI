"""Pure selection sidecar and immutable process-start snapshot; no plugin imports."""
from __future__ import annotations
import contextlib
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat

PROTOCOL = "collective.plugin-selection.v1"
KEY = "teams_pipeline"
VERSION = "0.1.0"
FILE = ".collective-plugin-selection.json"
LOCK = ".collective-plugin-selection.lock"
HASHES = {
    "__init__.py": "62d1391b190e6c23efde5e784d3507d454eccea719006a97f1e93448aeee3262",
    "cli.py": "d00d1662c3e2462d6e5c9ac5ed6803fc36f82477562c4ac4498aa00ae8ecd4e4",
    "meetings.py": "058aa377bfc9402595d5b9e4b701067b5f8c95b9c5dd2f92a622302c0342eb7a",
    "models.py": "1a51af3c34926ce38dd8a2497bac1a4ac5cd663f2849275f79df132f31c536b2",
    "pipeline.py": "a008770c6f170b1e78a7db9c1cf648c7dae7fdf4b204adc28e098860dc0771e0",
    "plugin.yaml": "fcee683bb9f637bb871fbb5e2ef25fff2efa9c78accdcc7ab7327563f8a7aae3",
    "runtime.py": "041d206ea83724a5b90b81ed5380ca2c635119823cc27d6e5c06bde8a8e91653",
    "store.py": "e123ccb2b3cb959e73a479f6149876074c6497611fcd19c58d0401d6e039f452",
    "subscriptions.py": "5890a4aeb54097b6d31c0eea0c4bd3f3ca2191a16ec713be2c240ccbf358c8d8",
}
IDENTITY = hashlib.sha256(json.dumps(HASHES, sort_keys=True).encode()).hexdigest()
MISSING = hashlib.sha256(b"collective.plugin-selection.v1:missing").hexdigest()
_startup = None


def _read(fd, name, limit):
    opened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(opened)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise ValueError("unsupported selection storage")
        data = os.read(opened, limit + 1)
        if len(data) > limit:
            raise ValueError("oversized selection storage")
        return data
    finally:
        os.close(opened)


def _eligible(root):
    if os.name != "posix" or os.environ.get("HERMES_BUNDLED_PLUGINS"):
        raise ValueError("unsupported plugin installation")
    from hermes_cli import config
    if config.is_managed() or config.managed_scope.managed_config_keys():
        raise ValueError("managed plugin selection is unavailable")
    package = Path(root) / "plugins" / KEY
    fd = os.open(package, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        actual = set(os.listdir(fd)) - {"__pycache__"}
        if actual != set(HASHES):
            raise ValueError("unreviewed plugin package")
        sources = {}
        for name, digest in HASHES.items():
            sources[name] = _read(fd, name, 256 * 1024)
            if hashlib.sha256(sources[name]).hexdigest() != digest:
                raise ValueError("plugin package changed")
        # This is reviewed SOURCE identity within an operator-trusted native
        # installation. Normal Python caches are runtime residue, not executable
        # attestation. A local actor able to replace code/cache can also replace
        # this adapter; no compromised-installation defense is claimed.
    finally:
        os.close(fd)
    return package


@contextlib.contextmanager
def _locked(home):
    import fcntl
    directory = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        lock = os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
        info = os.fstat(lock)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("unsupported selection lock")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield directory
    finally:
        if lock is not None:
            os.close(lock)
        os.close(directory)


def _state(fd, home):
    try:
        data = _read(fd, FILE, 4096)
    except FileNotFoundError:
        return MISSING, None, 0, None
    value = json.loads(data)
    expected_keys = {"protocol", "home", "identity", "enabled", "generation", "committed"}
    if (not isinstance(value, dict) or set(value) != expected_keys or value["protocol"] != PROTOCOL
            or value["home"] != hashlib.sha256(str(home).encode()).hexdigest()
            or value["identity"] != IDENTITY or type(value["enabled"]) is not bool
            or value["committed"] is not None and type(value["committed"]) is not bool
            or type(value["generation"]) is not int or not 1 <= value["generation"] < 2**53):
        raise ValueError("unrecognized selection storage")
    return hashlib.sha256(data).hexdigest(), value["enabled"], value["generation"], value["committed"]


def _update(home, expected_revision, enabled, *, operator_promote=False):
    with _locked(home) as fd:
        revision, previous, generation, committed = _state(fd, home)
        if revision != expected_revision:
            raise ValueError("selection changed after review")
        if generation >= 2**53 - 1:
            raise ValueError("selection generation exhausted")
        if operator_promote and previous is None:
            raise ValueError("no pending selection to promote")
        data = json.dumps({"protocol": PROTOCOL, "home": hashlib.sha256(str(home).encode()).hexdigest(),
            "identity": IDENTITY, "enabled": previous if operator_promote else enabled,
            "committed": previous if operator_promote else committed, "generation": generation + 1}, sort_keys=True).encode()
        temporary = ".collective-plugin-selection-" + secrets.token_hex(16)
        opened = None
        try:
            opened = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=fd)
            with os.fdopen(opened, "wb") as stream:
                opened = None
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if _state(fd, home)[0] != expected_revision:
                raise ValueError("selection changed after review")
            os.replace(temporary, FILE, src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
            result = _state(fd, home)
            if result[0] != hashlib.sha256(data).hexdigest() or result[1] is not (previous if operator_promote else enabled):
                raise OSError("selection readback mismatch")
            return result
        finally:
            if opened is not None:
                os.close(opened)
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary, dir_fd=fd)


def _select(home, expected_revision, enabled):
    return _update(home, expected_revision, enabled)


def promote_by_local_operator(home, expected_revision, expected_identity):
    """Offline explicit operator boundary. Never registered as a native RPC."""
    if expected_identity != IDENTITY:
        raise ValueError("plugin source identity changed")
    _eligible(Path(__file__).resolve().parents[1])
    return _update(home, expected_revision, None, operator_promote=True)


def snapshot_startup(homes):
    global _startup
    if _startup is not None:
        raise RuntimeError("plugin selection startup snapshot already frozen")
    frozen = {}
    for home in homes:
        try:
            home = Path(home).resolve(strict=True)
            # Startup is read-only: missing sidecars do not create a lock file.
            directory = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                _revision, _pending, _generation, committed = _state(directory, home)
                frozen[str(home)] = committed
            finally:
                os.close(directory)
        except (OSError, ValueError, TypeError):
            continue
    _startup = frozen


def overlay_startup(home, winners, disabled, enabled):
    """Called only by existing upstream initialization, never by the portal RPC."""
    if _startup is None:
        return disabled, enabled
    choice = _startup.get(str(Path(home).resolve()))
    if choice is None:
        return disabled, enabled
    try:
        root = Path(__file__).resolve().parents[1]
        package = _eligible(root)
        candidate = winners.get(KEY)
        if (candidate is None or candidate.source != "bundled" or candidate.name != KEY or candidate.version != VERSION
                or candidate.kind != "standalone" or candidate.provides_tools or candidate.provides_hooks
                or Path(candidate.path).resolve() != package.resolve()):
            return disabled, enabled
        # A second manifest's canonical, leaf or manifest-name alias must never
        # inherit this one positively classified plugin's selection.
        if any(other is not candidate and KEY in {key, key.split("/")[-1], other.name}
               for key, other in winners.items()):
            return disabled, enabled
        denied, allowed = set(disabled), set(enabled or ())
        allowed.discard(KEY)
        denied.discard(KEY)
        (allowed if choice else denied).add(KEY)
        return denied, allowed
    except (OSError, ValueError, TypeError, AttributeError):
        return disabled, enabled



# Imported by hermes_cli.plugins before its first discovery, including serve,
# dashboard, gateway and direct callers. Never refreshed by the runtime RPC.
if os.name == "posix":
    from hermes_cli.profiles import get_profile_dir, list_profile_names
    from hermes_constants import get_process_hermes_home
    snapshot_startup([get_process_hermes_home(), *[get_profile_dir(name) for name in list_profile_names()[:500]]])
else:
    _startup = {}
