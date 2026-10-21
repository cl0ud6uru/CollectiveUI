"""Opt-in, read-only native workspace file protocol for the pinned Hermes gateway.

This is an exact-pin extension, not an upstream Hermes method or a dashboard HTTP proxy.
Access is bound to the owner-fenced profile and the currently attached native session.
Only a persisted local session cwd inside a registered, unarchived project folder is
eligible. All client paths are relative to that root and are opened descriptor-relative
with no symlink following.
"""
from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import stat
from pathlib import Path
from typing import Literal

from pydantic import Field
from tui_gateway.contracts.base import Params, Result
from tui_gateway.contracts.registry import method
from tui_gateway.transport import current_transport

PROTOCOL = "collective.workspace-files.v1"
MAX_ENTRIES = 100
MAX_SCANNED_ENTRIES = 1000
MAX_READ_BYTES = 256 * 1024
MAX_RELATIVE_PATH = 1024
MAX_DEPTH = 16
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_NONBLOCK = getattr(os, "O_NONBLOCK", 0)
_SENSITIVE = re.compile(
    r"^(?:\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.config|\.hermes|\.codex|"
    r"credentials?(?:\..*)?|secrets?(?:\..*)?|vault(?:\..*)?|auth\.(?:json|ya?ml)|"
    r"config\.(?:json|ya?ml)|id_(?:rsa|ed25519)(?:\..*)?|.*\.(?:pem|p12|pfx|key))$",
    re.IGNORECASE,
)
_BROAD_UNSAFE_ROOTS = (
    "/", "/Applications", "/home", "/Library", "/media", "/mnt", "/opt",
    "/private", "/private/tmp", "/run", "/srv", "/tmp", "/Users", "/Volumes",
)
_SYSTEM_ROOTS = ("/bin", "/boot", "/dev", "/etc", "/lib", "/private/etc", "/private/var", "/proc", "/root", "/sbin", "/sys", "/System", "/usr", "/var")


class WorkspaceFilesParams(Params):
    profile: str = Field(min_length=1, max_length=100)
    session_id: str = Field(min_length=1, max_length=200)
    action: Literal["list", "read"]
    workspace_id: str | None = Field(default=None, min_length=16, max_length=64)
    path: str | None = Field(default=None, max_length=MAX_RELATIVE_PATH)


class Entry(Result):
    name: str
    path: str
    kind: Literal["directory", "file"]
    size: int | None = None


class WorkspaceFilesResult(Result):
    protocol: Literal["collective.workspace-files.v1"] = PROTOCOL
    available: bool
    workspace_id: str | None = None
    project_name: str | None = None
    action: Literal["list", "read"]
    path: str
    entries: list[Entry] = Field(default_factory=list)
    content: str | None = None
    truncated: bool = False


def _within(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _sensitive_path(parts: list[str]) -> bool:
    return any(not part or part in {".", ".."} or part.startswith(".") or _SENSITIVE.match(part)
               or any(ord(char) < 32 or ord(char) == 127 for char in part)
               or any(term in part.casefold() for term in ("secret", "credential", "token")) for part in parts)


def _canonical_directory(raw: str) -> str | None:
    if not raw or not os.path.isabs(raw) or "\x00" in raw:
        return None
    lexical = os.path.normpath(raw)
    try:
        canonical = os.path.realpath(lexical, strict=True)
        if canonical != lexical or not os.path.isdir(canonical):
            return None  # Reject symlinks anywhere in a claimed project/cwd path.
    except (OSError, RuntimeError):
        return None
    return canonical


def _root_is_approved(root: str, user_home: str) -> bool:
    if root in _BROAD_UNSAFE_ROOTS or root == user_home or _within(user_home, root):
        return False  # Never grant an entire filesystem or home directory.
    if any(_within(root, protected) for protected in _SYSTEM_ROOTS):
        return False
    # Don't treat another local account's home as an approved project root just because
    # it happens to be registered in this profile's project database.
    for homes in ("/Users", "/home"):
        if _within(root, homes) and not _within(root, user_home):
            return False
    parts = Path(root).parts[1:]
    return len(parts) >= 1 and not _sensitive_path(list(parts))


def _project_root(server, profile: str, session: dict):
    """Return exactly one approved native project root for this explicit session cwd."""
    if not session.get("explicit_cwd") or session.get("cwd_from_settle"):
        return None
    cwd = session.get("cwd")
    persisted = server._persisted_session_cwd(session)
    if not isinstance(cwd, str) or persisted != cwd:
        return None
    # Remote/isolated terminal paths are not host filesystem authorization.
    if session.get("_compute_host_active") or server._effective_terminal_backend() != "local":
        return None
    profile_home = server._profile_home(profile) or server._hermes_home
    profile_home = Path(profile_home).resolve()
    session_home = Path(server._session_home(session)).resolve()
    if profile_home != session_home:
        return None
    canonical_cwd = _canonical_directory(cwd)
    if canonical_cwd is None:
        return None

    projects_db = profile_home / "projects.db"
    try:
        db = sqlite3.connect(projects_db.as_uri() + "?mode=ro", uri=True, timeout=2.0)
        try:
            candidates = db.execute(
                "SELECT p.id, p.name, f.path FROM projects AS p "
                "JOIN project_folders AS f ON f.project_id=p.id WHERE p.archived=0"
            ).fetchall()
        finally:
            db.close()
    except (OSError, sqlite3.Error):
        return None

    roots: list[tuple[int, str, str, str]] = []
    for project_id, name, raw_root in candidates:
        if not isinstance(project_id, str) or not isinstance(name, str) or not isinstance(raw_root, str):
            continue
        root = _canonical_directory(raw_root)
        if root is None or not _root_is_approved(root, str(Path.home().resolve())) or not _within(canonical_cwd, root):
            continue
        roots.append((len(root), project_id, name, root))
    if not roots:
        return None
    _, project_id, name, root = max(roots, key=lambda row: row[0])
    workspace_id = hashlib.sha256((profile + "\0" + project_id + "\0" + root).encode()).hexdigest()[:32]
    return workspace_id, name, root, os.path.relpath(canonical_cwd, root)


def _relative_parts(path: str | None) -> list[str] | None:
    value = "." if path is None else path
    if not isinstance(value, str) or len(value) > MAX_RELATIVE_PATH or "\\" in value or "\x00" in value or value.startswith("/"):
        return None
    if value == ".":
        return []
    parts = value.split("/")
    if len(parts) > MAX_DEPTH or _sensitive_path(parts):
        return None
    return parts


def _open_directory(root: str, parts: list[str]) -> tuple[int, int]:
    if not _NOFOLLOW or not _DIRECTORY or os.name == "nt":
        raise OSError("descriptor-relative no-follow access is unavailable")
    fd = os.open(os.path.sep, os.O_RDONLY | _DIRECTORY)
    try:
        for component in Path(root).parts[1:]:
            next_fd = os.open(component, os.O_RDONLY | _DIRECTORY | _NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        root_device = os.fstat(fd).st_dev
        for component in parts:
            next_fd = os.open(component, os.O_RDONLY | _DIRECTORY | _NOFOLLOW, dir_fd=fd)
            if os.fstat(next_fd).st_dev != root_device:
                os.close(next_fd)
                raise OSError("workspace path crosses a filesystem boundary")
            os.close(fd)
            fd = next_fd
        return fd, root_device
    except BaseException:
        os.close(fd)
        raise


def _list(root: str, parts: list[str]) -> tuple[list[dict], bool]:
    fd, root_device = _open_directory(root, parts)
    try:
        visible = []
        truncated = False
        with os.scandir(fd) as entries:
            for scanned, entry in enumerate(entries):
                if scanned >= MAX_SCANNED_ENTRIES:
                    truncated = True
                    break
                name = entry.name
                if not name or "/" in name or "\\" in name or _sensitive_path([name]):
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                relative = "/".join(parts + [name])
                if stat.S_ISDIR(info.st_mode):
                    if info.st_dev != root_device:
                        continue  # Don't descend into a different mounted filesystem.
                    kind = "directory"
                elif stat.S_ISREG(info.st_mode):
                    if info.st_dev != root_device or info.st_nlink > 1:
                        continue  # Different-volume mounts and hardlinked aliases stay outside the view.
                    kind = "file"
                else:
                    continue  # Symlinks, devices, sockets, and FIFOs are never exposed.
                visible.append({"name": name, "path": relative, "kind": kind, "size": info.st_size})
                if len(visible) > MAX_ENTRIES:
                    truncated = True
                    break
        visible.sort(key=lambda row: row["name"].casefold())
        return visible[:MAX_ENTRIES], truncated or len(visible) > MAX_ENTRIES
    finally:
        os.close(fd)


def _read(root: str, parts: list[str]) -> str:
    if not parts:
        raise ValueError("A file path is required.")
    if not _NONBLOCK:
        raise OSError("nonblocking file access is unavailable")
    fd, root_device = _open_directory(root, parts[:-1])
    try:
        # The client can guess a path or a listed regular file can be replaced between
        # listing and reading. Opening nonblocking ensures a FIFO/device cannot stall
        # the RPC before we inspect the descriptor type.
        file_fd = os.open(parts[-1], os.O_RDONLY | _NOFOLLOW | _NONBLOCK, dir_fd=fd)
    finally:
        os.close(fd)
    try:
        info = os.fstat(file_fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_dev != root_device or info.st_nlink > 1
                or info.st_size > MAX_READ_BYTES):
            raise ValueError("This file is not an eligible small text file.")
        chunks = []
        total = 0
        while total <= MAX_READ_BYTES:
            chunk = os.read(file_fd, min(64 * 1024, MAX_READ_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        raw = b"".join(chunks)
        if len(raw) > MAX_READ_BYTES or b"\x00" in raw:
            raise ValueError("This file is not an eligible small text file.")
        return raw.decode("utf-8", errors="strict")
    finally:
        os.close(file_fd)


def install(server):
    if getattr(server, "_collective_workspace_files", None) is not None:
        raise RuntimeError("Workspace files protocol already installed")

    def handle(rid, raw):
        try:
            params = WorkspaceFilesParams.model_validate(raw)
            owner_module = __import__("tui_gateway.collective_hub_owner", fromlist=["_active_binding"])
            binding = owner_module._active_binding.get()
            transport = current_transport()
            if (binding is None or binding.phase != "full" or binding.profile != params.profile
                    or binding.transport is not transport or str(binding.home) != str(Path(binding.home).resolve())):
                return server._err(rid, 4030, "Workspace files require current full profile ownership.")
            if server._effective_terminal_backend() != "local":
                return server._err(rid, 4030, "Workspace files are unavailable for non-local terminal sessions.")
            attached_transport, session = server._current_session_steer_authority(params.session_id)
            if attached_transport is not transport or session is None:
                return server._err(rid, 4030, "Workspace files require the attached native session.")
            # Native background turns claim running under history_lock. Hold the
            # same lock from the idle check through all workspace access.
            with session["history_lock"]:
                if (server._session_live_status(params.session_id, session) != "idle"
                        or server._inflight_snapshot(session) or server._queued_prompt_snapshot(session)
                        or server._session_has_active_delegations(params.session_id, session)):
                    return server._err(rid, 4090, "Finish this native turn before browsing its workspace.")
                root_info = _project_root(server, params.profile, session)
                if root_info is None:
                    return server._ok(rid, WorkspaceFilesResult(available=False, action=params.action, path=".").model_dump())
                workspace_id, project_name, root, _cwd_relative = root_info
                if params.workspace_id is not None and params.workspace_id != workspace_id:
                    return server._err(rid, 4030, "The approved workspace changed; refresh the native workspace list.")
                parts = _relative_parts(params.path)
                if parts is None:
                    return server._err(rid, 4000, "Choose a safe root-relative workspace path.")
                if params.action == "list":
                    entries, truncated = _list(root, parts)
                    result = WorkspaceFilesResult(available=True, workspace_id=workspace_id,
                        project_name=project_name, action="list", path="/".join(parts) or ".",
                        entries=entries, truncated=truncated)
                    return server._ok(rid, result.model_dump())
                content = _read(root, parts)
                result = WorkspaceFilesResult(available=True, workspace_id=workspace_id,
                    project_name=project_name, action="read", path="/".join(parts), content=content)
                return server._ok(rid, result.model_dump())
        except ValueError as exc:
            # Contract/domain messages are deliberately generic; never echo paths or native exceptions.
            return server._err(rid, 4000, str(exc) if str(exc) in {"A file path is required.", "This file is not an eligible small text file."} else "Invalid workspace file request.")
        except (OSError, sqlite3.Error, RuntimeError, UnicodeDecodeError):
            return server._err(rid, 4030, "Workspace file access is unavailable; no path was opened.")

    method("collective.workspace.files", params=WorkspaceFilesParams, result=WorkspaceFilesResult,
        doc="Explicit opt-in native read-only project workspace browser. No arbitrary filesystem path access.")
    server.register_method("collective.workspace.files", handle)
    server._LONG_HANDLERS = server._LONG_HANDLERS | frozenset({"collective.workspace.files"})
    from tui_gateway import rpc_dispatch
    rpc_dispatch._LONG_HANDLERS = rpc_dispatch._LONG_HANDLERS | frozenset({"collective.workspace.files"})
    server._collective_workspace_files = handle
    return handle
