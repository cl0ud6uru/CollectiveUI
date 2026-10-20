"""Opt-in, profile-scoped hub ownership fence for the reviewed Hermes gateway pin.

This adapter is intentionally separate from Hermes upstream. Portal lease epochs are not
compared across accounts: the native gateway allocates its own durable profile epoch by CAS.
"""
from __future__ import annotations

import contextlib
import sqlite3
import threading
import time
import contextvars
from pathlib import Path
from typing import Literal

from pydantic import Field
from tui_gateway.contracts.base import Params, Result
from tui_gateway.contracts.registry import method
from tui_gateway.transport import current_transport
from tui_gateway.ws import WSTransport

PROTOCOL = "collective.native-hub-owner.v1"
BUSY = 4091
_active_binding = contextvars.ContextVar("collective_native_hub_owner_binding", default=None)


class Empty(Params):
    pass


class CapabilityResult(Result):
    protocol: Literal["collective.native-hub-owner.v1"] = PROTOCOL
    durable: bool = True
    scope: Literal["profile_dispatch_and_server_request_answers"] = "profile_dispatch_and_server_request_answers"
    atomic_execution_fence: bool = True


class ProfileParams(Params):
    profile: str = Field(min_length=1, max_length=100)


class CurrentResult(Result):
    protocol: Literal["collective.native-hub-owner.v1"] = PROTOCOL
    profile: str
    native_generation: int = Field(ge=0)
    portal_connection_id: str | None = None
    portal_instance_id: str | None = None
    portal_generation: int | None = None
    portal_socket_epoch: int | None = None
    phase: Literal["full", "recovery"] | None = None
    recovery_id: str | None = None
    recovery_session_id: str | None = None
    recovery_stored_session_id: str | None = None
    transport_bound: bool = False


class ClaimParams(ProfileParams):
    portal_connection_id: str = Field(min_length=1, max_length=200)
    portal_instance_id: str = Field(min_length=1, max_length=200)
    portal_generation: int = Field(gt=0, le=2**53 - 1)
    portal_socket_epoch: int = Field(gt=0, le=2**53 - 1)
    expected_native_generation: int = Field(ge=0, le=2**53 - 1)
    phase: Literal["full", "recovery"] = "full"
    recovery_id: str | None = Field(default=None, min_length=1, max_length=200)
    recovery_session_id: str | None = Field(default=None, min_length=1, max_length=200)
    recovery_stored_session_id: str | None = Field(default=None, min_length=1, max_length=200)


class ClaimResult(Result):
    protocol: Literal["collective.native-hub-owner.v1"] = PROTOCOL
    accepted: bool
    portal_connection_id: str
    portal_instance_id: str
    profile: str
    portal_generation: int
    portal_socket_epoch: int
    native_generation: int
    phase: Literal["full", "recovery"]
    recovery_id: str | None = None
    recovery_session_id: str | None = None
    recovery_stored_session_id: str | None = None
    transport_bound: bool
    durable: bool


class Binding:
    __slots__ = ("profile", "home", "transport", "connection_id", "instance_id", "portal_generation", "socket_epoch", "native_generation", "phase", "recovery_id", "recovery_session_id", "recovery_stored_session_id")

    def __init__(self, profile, home, transport, connection_id, instance_id, portal_generation, socket_epoch, native_generation, phase, recovery_id, recovery_session_id, recovery_stored_session_id):
        self.profile = profile
        self.home = home
        self.transport = transport
        self.connection_id = connection_id
        self.instance_id = instance_id
        self.portal_generation = portal_generation
        self.socket_epoch = socket_epoch
        self.native_generation = native_generation
        self.phase = phase
        self.recovery_id = recovery_id
        self.recovery_session_id = recovery_session_id
        self.recovery_stored_session_id = recovery_stored_session_id

    def same_claim(self, other):
        return (other is not None and self.profile == other.profile and self.home == other.home
                and self.transport is other.transport and self.connection_id == other.connection_id
                and self.instance_id == other.instance_id and self.portal_generation == other.portal_generation
                and self.socket_epoch == other.socket_epoch and self.native_generation == other.native_generation
                and self.phase == other.phase and self.recovery_id == other.recovery_id
                and self.recovery_session_id == other.recovery_session_id and self.recovery_stored_session_id == other.recovery_stored_session_id)


class HubOwner:
    _LOCK_WAIT_SECONDS = 2.0

    def __init__(self, server):
        self.server = server
        self._guard = threading.Lock()
        self._profile_locks = {}
        self._owners = {}  # resolved profile home -> active process-local WSTransport binding
        self._transports = {}  # transport -> resolved profile home -> binding; stale claims stay fenced
        self._active_workers = {}  # resolved profile home -> count of already-started native workers

    def _home(self, profile):
        name = profile.strip()
        if not name:
            raise ValueError("profile is required")
        home = self.server._profile_home(name) or self.server._hermes_home
        path = Path(home).resolve()
        if not path.is_dir() or not (path / "state.db").is_file():
            raise ValueError("profile state store is unavailable")
        return name, path

    def _lock_for(self, home):
        key = str(home)
        with self._guard:
            return self._profile_locks.setdefault(key, threading.RLock())

    @contextlib.contextmanager
    def _locked(self, home, *, wait=None):
        lock = self._lock_for(home)
        if wait is None:
            acquired = lock.acquire()
        else:
            acquired = lock.acquire(timeout=wait)
        if not acquired:
            raise TimeoutError("profile owner is busy")
        try:
            yield
        finally:
            lock.release()

    @contextlib.contextmanager
    def _database(self, home, *, immediate=False):
        path = Path(home) / "state.db"
        uri = path.as_uri() + "?mode=rw"
        db = sqlite3.connect(uri, uri=True, timeout=2.0)
        try:
            db.execute("CREATE TABLE IF NOT EXISTS collective_hub_owner (profile TEXT PRIMARY KEY, native_generation INTEGER NOT NULL CHECK(native_generation >= 0), portal_connection_id TEXT NOT NULL, portal_instance_id TEXT NOT NULL, portal_generation INTEGER NOT NULL, portal_socket_epoch INTEGER NOT NULL, phase TEXT NOT NULL DEFAULT 'full', recovery_id TEXT, recovery_session_id TEXT, recovery_stored_session_id TEXT, updated_at INTEGER NOT NULL)")
            columns = {row[1] for row in db.execute("PRAGMA table_info(collective_hub_owner)")}
            if "phase" not in columns:
                db.execute("ALTER TABLE collective_hub_owner ADD COLUMN phase TEXT NOT NULL DEFAULT 'full'")
            if "recovery_id" not in columns:
                db.execute("ALTER TABLE collective_hub_owner ADD COLUMN recovery_id TEXT")
            if "recovery_session_id" not in columns:
                db.execute("ALTER TABLE collective_hub_owner ADD COLUMN recovery_session_id TEXT")
            if "recovery_stored_session_id" not in columns:
                db.execute("ALTER TABLE collective_hub_owner ADD COLUMN recovery_stored_session_id TEXT")
            if immediate:
                db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def _current_row(self, profile, home):
        with self._database(home) as db:
            row = self._row_for_home(db, home)
        return row[1:] if row else None

    def _row_for_home(self, db, home):
        """Find the single durable owner row for a resolved profile home.

        Hermes accepts profile aliases that can resolve to the same directory. The
        durable ledger must therefore be keyed by that directory, while legacy
        rows keyed by a profile name remain discoverable until the next claim
        atomically canonicalizes them.
        """
        resolved = Path(home).resolve()
        matches = []
        rows = db.execute("SELECT profile, native_generation, portal_connection_id, portal_instance_id, portal_generation, portal_socket_epoch, phase, recovery_id, recovery_session_id, recovery_stored_session_id FROM collective_hub_owner").fetchall()
        for row in rows:
            key = row[0]
            same_home = key == str(resolved)
            if not same_home:
                try:
                    candidate = self.server._profile_home(key) or self.server._hermes_home
                    same_home = Path(candidate).resolve() == resolved
                except (OSError, TypeError, ValueError):
                    same_home = False
            if same_home:
                matches.append(row)
        if len(matches) > 1:
            raise ValueError("multiple native owner rows resolve to the same profile home")
        if not matches:
            return None
        return matches[0]

    def _durably_current(self, binding):
        try:
            row = self._current_row(binding.profile, Path(binding.home))
            return bool(row and (int(row[0]), row[1], row[2], int(row[3]), int(row[4]), row[5], row[6], row[7], row[8]) ==
                (binding.native_generation, binding.connection_id, binding.instance_id, binding.portal_generation,
                 binding.socket_epoch, binding.phase, binding.recovery_id, binding.recovery_session_id, binding.recovery_stored_session_id))
        except (OSError, sqlite3.Error, ValueError, TypeError):
            return False

    def _drained_recovery(self, profile, home, recovery_id, session_id, stored_session_id):
        recovery = getattr(self.server, "_collective_recovery", None)
        if recovery is None or not recovery_id or not session_id or not stored_session_id:
            return False
        try:
            with recovery.database() as db:
                row = db.execute("SELECT principal,boot,home,body,state FROM recovery WHERE id=?", (recovery_id,)).fetchone()
            if row is None:
                return False
            principal, boot, receipt_home, encoded, state = row
            body = __import__("json").loads(encoded)
            return (principal == recovery.principal() and boot == recovery.boot and receipt_home == str(home)
                    and state == "drained" and body.get("recovery_id") == recovery_id
                    and body.get("session_id") == session_id and body.get("stored_session_id") == stored_session_id
                    and (self.server._profile_home(profile) or self.server._hermes_home).resolve() == Path(receipt_home).resolve())
        except (OSError, sqlite3.Error, ValueError, TypeError):
            return False

    def _recovery_target_matches(self, transport, profile, home, session_id, stored_session_id):
        """A first recovery fence may only bind the authenticated native runtime it will drain.

        Exact retries are handled from the durable retained tuple and deliberately do not need
        the runtime to remain in `_sessions` after a successful drain.
        """
        try:
            with self.server._sessions_lock:
                session = self.server._sessions.get(session_id)
            if session is None:
                return False
            principal = self.server._transport_auth_user_id(transport) or "local-stdio"
            if (session.get("auth_user_id") or "local-stdio") != principal:
                return False
            actual_home = Path(self.server._session_home(session)).resolve()
            expected_home = Path(self.server._profile_home(profile) or self.server._hermes_home).resolve()
            if actual_home != Path(home).resolve() or actual_home != expected_home:
                return False
            if str(self.server._session_lookup_key(session)) != stored_session_id:
                return False
            if self.server._session_uses_compute_host(session) or session.get("slash_worker"):
                return False
            return True
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            return False

    def _err(self, rid, message, code=BUSY):
        return self.server._err(rid, code, message)

    def capabilities(self, rid, _params):
        return self.server._ok(rid, CapabilityResult().model_dump())

    def current(self, rid, raw):
        try:
            p = ProfileParams.model_validate(raw)
            profile, home = self._home(p.profile)
            with self._locked(home, wait=self._LOCK_WAIT_SECONDS):
                row = self._current_row(profile, home)
                transport = current_transport()
                with self._guard:
                    binding = self._transports.get(transport, {}).get(str(home))
                    owner = self._owners.get(str(home))
            generation = int(row[0]) if row else 0
            result = CurrentResult(profile=profile, native_generation=generation,
                portal_connection_id=row[1] if row else None, portal_instance_id=row[2] if row else None,
                portal_generation=int(row[3]) if row else None, portal_socket_epoch=int(row[4]) if row else None,
                phase=row[5] if row else None, recovery_id=row[6] if row else None,
                recovery_session_id=row[7] if row else None, recovery_stored_session_id=row[8] if row else None,
                transport_bound=binding is not None and binding.same_claim(owner) and binding.transport is transport and self._durably_current(binding))
            return self.server._ok(rid, result.model_dump())
        except TimeoutError:
            return self._err(rid, "Profile ownership is busy; no operation was sent.")
        except (OSError, sqlite3.Error, ValueError):
            return self._err(rid, "Profile ownership state is unavailable; no operation was sent.", 5031)

    def claim(self, rid, raw):
        try:
            p = ClaimParams.model_validate(raw)
            profile, home = self._home(p.profile)
            transport = current_transport()
            if not isinstance(transport, WSTransport):
                return self._err(rid, "Native hub ownership can only be claimed by a dashboard WebSocket.", 4030)
            if p.phase == "recovery":
                if not p.recovery_id or not p.recovery_session_id or not p.recovery_stored_session_id or getattr(self.server, "_collective_recovery", None) is None:
                    return self._err(rid, "Native recovery capability is unavailable; ownership was not changed.", 5010)
            elif bool(p.recovery_id) != bool(p.recovery_session_id) or bool(p.recovery_id) != bool(p.recovery_stored_session_id):
                return self._err(rid, "A full recovery handoff requires its complete identity.", 4000)
            with self._locked(home, wait=self._LOCK_WAIT_SECONDS):
                with self._guard:
                    active = self._active_workers.get(str(home), 0)
                    current_binding = self._owners.get(str(home))
                # A normal claim cannot cross a live worker. A recovery claim first fences all
                # old sockets and is admitted only for the exact native recovery receipt below.
                if active and p.phase == "full":
                    if current_binding is None or current_binding.phase != "recovery" or current_binding.recovery_id != p.recovery_id:
                        return self._err(rid, "A native profile worker is still active; use the confirmed native recovery flow.")
                with self._database(home, immediate=True) as db:
                    row = self._row_for_home(db, home)
                    row_key = row[0] if row else None
                    if row:
                        row = row[1:]
                    old = int(row[0]) if row else 0
                    if p.phase == "recovery" and row and row[5] == "recovery" and (
                        p.recovery_id, p.recovery_session_id, p.recovery_stored_session_id
                    ) != (row[6], row[7], row[8]):
                        return self._err(rid, "A native recovery is already retained; continue its exact identity before preparing another.")
                    if row and (row[1], row[2], int(row[3]), int(row[4]), row[5], row[6], row[7], row[8]) == (
                        p.portal_connection_id, p.portal_instance_id, p.portal_generation, p.portal_socket_epoch, p.phase, p.recovery_id, p.recovery_session_id, p.recovery_stored_session_id) and current_binding is not None and current_binding.transport is transport:
                        # Exact retries on the same native transport are idempotent.
                        native_generation = old
                    else:
                        if p.phase == "recovery" and not self._recovery_target_matches(
                            transport, profile, home, p.recovery_session_id, p.recovery_stored_session_id
                        ):
                            return self._err(rid, "Recovery does not match an authenticated inline native runtime; ownership was not changed.", 4030)
                        if old != p.expected_native_generation:
                            return self._err(rid, "Native owner generation changed; read current ownership and retry.")
                        if p.phase == "full" and p.recovery_id:
                            if not row or (p.recovery_id, p.recovery_session_id, p.recovery_stored_session_id) != (row[6], row[7], row[8]):
                                return self._err(rid, "Full recovery ownership must retain its exact recovery identity.")
                            if row[5] == "full" and not self._drained_recovery(profile, home, p.recovery_id, p.recovery_session_id, p.recovery_stored_session_id):
                                return self._err(rid, "Full recovery ownership requires the retained exact current-boot drained receipt.")
                            if row[5] not in {"recovery", "full"}:
                                return self._err(rid, "Full recovery ownership cannot replace an unproven native owner.")
                        if p.phase == "full" and row and row[5] == "recovery":
                            if current_binding is None or current_binding.transport is not transport or not current_binding.same_claim(self._owners.get(str(home))):
                                return self._err(rid, "Only the current recovery transport can complete its ownership handoff.")
                            if p.recovery_id != row[6] or p.recovery_session_id != row[7] or p.recovery_stored_session_id != row[8]:
                                return self._err(rid, "Full ownership must cite the original recovery identity.")
                            if not self._drained_recovery(profile, home, row[6], row[7], row[8]):
                                return self._err(rid, "The exact native recovery receipt is not drained in this process; full ownership remains fenced.")
                            if active:
                                return self._err(rid, "Native recovery workers are still active; full ownership remains fenced.")
                        elif p.phase == "full" and active:
                            return self._err(rid, "A native profile worker is still active; ownership was not changed.")
                        native_generation = old + 1
                        if row_key is not None and row_key != str(home):
                            db.execute("DELETE FROM collective_hub_owner WHERE profile=?", (row_key,))
                        db.execute("INSERT INTO collective_hub_owner (profile,native_generation,portal_connection_id,portal_instance_id,portal_generation,portal_socket_epoch,phase,recovery_id,recovery_session_id,recovery_stored_session_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile) DO UPDATE SET native_generation=excluded.native_generation, portal_connection_id=excluded.portal_connection_id, portal_instance_id=excluded.portal_instance_id, portal_generation=excluded.portal_generation, portal_socket_epoch=excluded.portal_socket_epoch, phase=excluded.phase, recovery_id=excluded.recovery_id, recovery_session_id=excluded.recovery_session_id, recovery_stored_session_id=excluded.recovery_stored_session_id, updated_at=excluded.updated_at",
                                   (str(home), native_generation, p.portal_connection_id, p.portal_instance_id, p.portal_generation, p.portal_socket_epoch, p.phase, p.recovery_id, p.recovery_session_id, p.recovery_stored_session_id, time.time_ns()))
                binding = Binding(profile, str(home), transport, p.portal_connection_id, p.portal_instance_id,
                                  p.portal_generation, p.portal_socket_epoch, native_generation, p.phase, p.recovery_id, p.recovery_session_id, p.recovery_stored_session_id)
                with self._guard:
                    self._owners[str(home)] = binding
                    self._transports.setdefault(transport, {})[str(home)] = binding
                if p.phase == "recovery":
                    self._stop_profile_notification_pollers(home)
                result = ClaimResult(accepted=True, portal_connection_id=p.portal_connection_id,
                    portal_instance_id=p.portal_instance_id, profile=profile, portal_generation=p.portal_generation,
                    portal_socket_epoch=p.portal_socket_epoch, native_generation=native_generation,
                    phase=p.phase, recovery_id=p.recovery_id, recovery_session_id=p.recovery_session_id,
                    recovery_stored_session_id=p.recovery_stored_session_id, transport_bound=True, durable=True)
                return self.server._ok(rid, result.model_dump())
        except TimeoutError:
            return self._err(rid, "Profile ownership is busy; no operation was sent.")
        except (OSError, sqlite3.Error, ValueError):
            return self._err(rid, "Profile ownership state is unavailable; no operation was sent.", 5031)

    def _stop_profile_notification_pollers(self, home):
        """Stop this profile's long-lived pollers after recovery-only ownership is durable.

        Pollers are counted as workers until their loops exit, so a recovery can never promote
        while one might still publish. Other profiles keep their independent pollers running.
        """
        with self.server._sessions_lock:
            sessions = list(self.server._sessions.values())
            for session in sessions:
                try:
                    session_home = Path(self.server._session_home(session)).resolve()
                except (OSError, TypeError, ValueError):
                    continue
                if session_home != Path(home).resolve():
                    continue
                stop = session.get("_notif_stop")
                if hasattr(stop, "set"):
                    stop.set()

    def _profile_for_request(self, params):
        requested = self._home(params["profile"]) if isinstance(params.get("profile"), str) and params["profile"].strip() else None
        recovery_id = params.get("recovery_id")
        if isinstance(recovery_id, str):
            transport = current_transport()
            with self._guard:
                matches = [binding for binding in self._transports.get(transport, {}).values()
                           if binding.recovery_id == recovery_id]
            if len(matches) == 1:
                binding = matches[0]
                if requested is not None and Path(requested[1]).resolve() != Path(binding.home).resolve():
                    return None, None
                return binding.profile, Path(binding.home)
        sid = params.get("session_id")
        if sid is None:
            return requested if requested is not None else (None, None)
        with self.server._sessions_lock:
            session = self.server._sessions.get(str(sid))
        if session is None:
            return requested if requested is not None else (None, None)
        home = Path(self.server._session_home(session)).resolve()
        if requested is not None and Path(requested[1]).resolve() != home:
            return None, None
        with self._guard:
            owner = self._owners.get(str(home))
        return (owner.profile, Path(owner.home)) if owner else (requested if requested is not None else (None, home))

    def _request_answer_params(self, params):
        """Resolve the session behind Hermes' exact `{id, result}` request.answer contract."""
        request_id = params.get("id")
        if not isinstance(request_id, str) or not request_id:
            return None
        requests = self.server._server_requests
        with requests._lock:
            req = requests._open.get(request_id)
            if req is None:
                return None
            return {"session_id": req.sid}

    def _durable_owner_exists(self, home):
        """A non-WS transport may use a profile only before any portal owner fenced it.

        Query the durable profile store, not just this process's transport map: after a
        gateway restart the old row still blocks stdio until a new owner is established.
        """
        try:
            with self._database(Path(home)) as db:
                return db.execute("SELECT 1 FROM collective_hub_owner LIMIT 1").fetchone() is not None
        except (OSError, sqlite3.Error, ValueError):
            return True  # Cannot establish absence of a fence, so deny the other transport.

    def _matching_binding(self, transport, profile, home):
        with self._guard:
            bindings = self._transports.get(transport, {})
            binding = bindings.get(str(home)) if home is not None else None
            owner = self._owners.get(str(home)) if home is not None else None
        if not bindings:
            return None
        if binding is None or profile is None or home is None or binding.home != str(home) or not binding.same_claim(owner):
            return False
        return binding

    def _owner_for_request(self, transport, params):
        with self._guard:
            known_bindings = bool(self._transports.get(transport))
        if not known_bindings:
            return None
        try:
            profile, home = self._profile_for_request(params)
        except Exception:
            return False
        return self._matching_binding(transport, profile, home)

    def _transport_owns_any_profile(self, transport):
        with self._guard:
            bindings = [(binding, self._owners.get(binding.home))
                        for binding in self._transports.get(transport, {}).values()]
        return any(binding.same_claim(owner) and self._durably_current(binding) for binding, owner in bindings)

    def guard_method(self, name, handler):
        def guarded(rid, params):
            transport = current_transport()
            # These exact negotiation methods do not execute profile work.
            # A socket may retain several independent profile claims.
            if name in {"ping", "client.capabilities", "collective.recovery.capabilities"}:
                with self._guard:
                    known_bindings = bool(self._transports.get(transport))
                if not known_bindings or self._transport_owns_any_profile(transport):
                    return handler(rid, params)
                return self._err(rid, "This dashboard socket no longer owns a native profile.")
            scoped_params = params
            if name == "request.answer":
                scoped_params = self._request_answer_params(params)
                if scoped_params is None:
                    return self._err(rid, "This server request is no longer open or cannot be scoped to a native session.")
            binding = self._owner_for_request(transport, scoped_params)
            if binding is False:
                return self._err(rid, "This dashboard socket no longer owns the native profile.")
            if binding is None:
                if isinstance(transport, WSTransport) and name not in {
                    "ping", "client.capabilities", "collective.hub_owner.capabilities",
                    "collective.hub_owner.current", "collective.hub_owner.claim",
                    "collective.recovery.capabilities",
                }:
                    return self._err(rid, "This dashboard socket must claim a native profile owner fence before using Hermes.")
                if not isinstance(transport, WSTransport):
                    active = _active_binding.get()
                    if active is not None:
                        try:
                            with self._locked(Path(active.home), wait=self._LOCK_WAIT_SECONDS):
                                if not active.same_claim(self._current_owner(active.home)) or not self._durably_current(active):
                                    return self._err(rid, "This native worker no longer owns the profile.")
                                if active.phase != "full":
                                    return self._err(rid, "This native worker is fenced by recovery-only ownership.")
                                return handler(rid, params)
                        except (OSError, ValueError, TimeoutError):
                            return self._err(rid, "This Hermes profile is owned or unavailable; no operation was sent.")
                    try:
                        _profile, home = self._profile_for_request(params)
                        if home is not None:
                            with self._locked(home, wait=self._LOCK_WAIT_SECONDS):
                                if self._durable_owner_exists(home):
                                    return self._err(rid, "This Hermes profile is owned by a fenced dashboard socket.")
                        elif name not in {"ping", "client.capabilities", "collective.hub_owner.capabilities"}:
                            return self._err(rid, "This transport cannot prove the Hermes profile is unowned.")
                    except (OSError, ValueError, TimeoutError):
                        return self._err(rid, "This Hermes profile is owned or unavailable; no operation was sent.")
                return handler(rid, params)
            recovery_method = name in {"collective.recovery.capabilities", "collective.recovery.status", "collective.recovery.cancel_and_drain"}
            if binding.phase == "recovery":
                if not recovery_method:
                    return self._err(rid, "This dashboard socket has recovery-only native ownership; ordinary session operations are fenced.")
                if name != "collective.recovery.capabilities" and params.get("recovery_id") != binding.recovery_id:
                    return self._err(rid, "This dashboard socket may only continue its exact recovery identity.")
                if name == "collective.recovery.cancel_and_drain" and (
                    params.get("session_id") != binding.recovery_session_id or
                    params.get("stored_session_id") != binding.recovery_stored_session_id or
                    params.get("profile") != binding.profile
                ):
                    return self._err(rid, "This recovery request does not match its fenced native session identity.")
            elif recovery_method and name != "collective.recovery.capabilities":
                if params.get("recovery_id") != binding.recovery_id or not binding.recovery_id:
                    return self._err(rid, "This dashboard socket may only inspect its exact recovery identity.")
            try:
                with self._locked(Path(binding.home), wait=self._LOCK_WAIT_SECONDS):
                    if not binding.same_claim(self._current_owner(binding.home)) or not self._durably_current(binding):
                        return self._err(rid, "This dashboard socket no longer owns the native profile.")
                    token = _active_binding.set(binding)
                    try:
                        return handler(rid, params)
                    finally:
                        _active_binding.reset(token)
            except TimeoutError:
                return self._err(rid, "Profile ownership is busy; no operation was sent.")
        guarded.__name__ = getattr(handler, "__name__", f"collective_owner_{name.replace('.', '_')}")
        return guarded

    def _current_owner(self, home):
        with self._guard:
            return self._owners.get(str(home))

    def protect_worker(self, target, session):
        try:
            home = Path(self.server._session_home(session)).resolve()
        except (OSError, ValueError, TypeError):
            return lambda *args, **kwargs: None
        binding = _active_binding.get()
        if binding is None:
            with self._guard:
                binding = self._owners.get(str(home))
        def guarded_target(*args, **kwargs):
            with self._locked(home, wait=self._LOCK_WAIT_SECONDS):
                current = self._current_owner(str(home))
                if binding is None:
                    # Work queued before a portal claim may run only while the
                    # profile still has no durable or in-process owner.
                    if current is not None or self._durable_owner_exists(home):
                        return None
                elif not binding.same_claim(current) or not self._durably_current(binding):
                    return None  # stale queued/deferred work never begins
                elif binding.phase != "full":
                    return None  # recovery-only ownership never starts ordinary background work
                with self._guard:
                    self._active_workers[str(home)] = self._active_workers.get(str(home), 0) + 1
            token = _active_binding.set(binding) if binding is not None else None
            try:
                return target(*args, **kwargs)
            finally:
                if token is not None:
                    _active_binding.reset(token)
                with self._guard:
                    remaining = self._active_workers.get(str(home), 0) - 1
                    if remaining > 0:
                        self._active_workers[str(home)] = remaining
                    else:
                        self._active_workers.pop(str(home), None)
        return guarded_target

    def start_resume_thread(self, target, session, name):
        guarded = self.protect_worker(target, session) if session is not None else target
        thread = threading.Thread(target=guarded, daemon=True, name=name)
        if session is not None:
            session["_collective_resume_thread"] = thread
            recovery = getattr(self.server, "_collective_recovery", None)
            if recovery is not None:
                recovery.remember(session, thread)
        thread.start()
        return thread

    def guard_answer(self, frame, transport, resolve):
        with self.server._server_requests._lock:
            req = self.server._server_requests._open.get(str(frame.get("id")))
            sid = req.sid if req is not None else None
        if req is None:
            return False
        with self.server._sessions_lock:
            session = self.server._sessions.get(sid)
        if session is None:
            # A request that outlived its runtime cannot be safely attributed to
            # a profile or socket generation. Keep it unresolved rather than
            # accepting an answer from an unscoped transport.
            return False
        home = Path(self.server._session_home(session)).resolve()
        with self._guard:
            binding = self._transports.get(transport, {}).get(str(home))
            owner = self._owners.get(str(home))
        if binding is None:
            if transport is None or isinstance(transport, WSTransport):
                return False
            try:
                with self._locked(home, wait=self._LOCK_WAIT_SECONDS):
                    if self._durable_owner_exists(home):
                        return False
                    return resolve(frame)
            except (OSError, ValueError, TimeoutError):
                return False
        if binding.home != str(home) or not binding.same_claim(owner) or not self._durably_current(binding) or binding.phase != "full":
            return False
        try:
            with self._locked(home, wait=self._LOCK_WAIT_SECONDS):
                if not binding.same_claim(self._current_owner(str(home))) or not self._durably_current(binding):
                    return False
                return resolve(frame)
        except TimeoutError:
            return False

    def install(self):
        if getattr(self.server, "_collective_hub_owner", None) is not None:
            raise RuntimeError("Native hub owner adapter already installed")
        self.server._collective_hub_owner = self
        original_start = self.server._start_session_work
        def start(target, *, name, session=None):
            guarded = self.protect_worker(target, session) if session is not None else target
            return original_start(guarded, name=name, session=session) if session is not None else original_start(guarded, name=name)
        self.server._start_session_work = start
        original_auxiliary = getattr(self.server, "_collective_start_auxiliary_work", None)
        if original_auxiliary is not None:
            def auxiliary(target, *, name, session):
                try:
                    home = Path(self.server._session_home(session)).resolve()
                    with self._locked(home, wait=self._LOCK_WAIT_SECONDS):
                        with self.server._sessions_lock:
                            # `_sessions` is keyed by runtime id while
                            # `_session_lookup_key` prefers the stored id. Verify
                            # object membership directly instead of conflating them.
                            if sum(candidate is session for candidate in self.server._sessions.values()) != 1 or session.get("_closing"):
                                return None
                        active = _active_binding.get()
                        with self._guard:
                            owner = self._owners.get(str(home))
                        if active is not None:
                            if active.home != str(home) or not active.same_claim(owner) or not self._durably_current(active) or active.phase != "full":
                                return None
                        elif owner is not None or self._durable_owner_exists(home):
                            # An owner-bound caller must carry its exact request
                            # context; never let stale async work inherit a new claim.
                            return None
                        guarded = self.protect_worker(target, session)
                        return original_auxiliary(guarded, name=name, session=session)
                except (OSError, TypeError, ValueError, TimeoutError):
                    return None
            self.server._collective_start_auxiliary_work = auxiliary
        for name, handler in list(self.server._methods.items()):
            if name in {"collective.hub_owner.capabilities", "collective.hub_owner.current", "collective.hub_owner.claim"}:
                continue
            self.server._methods[name] = self.guard_method(name, handler)
        self.server._collective_hub_owner = self
        for name, params, result, handler in (
            ("collective.hub_owner.capabilities", Empty, CapabilityResult, self.capabilities),
            ("collective.hub_owner.current", ProfileParams, CurrentResult, self.current),
            ("collective.hub_owner.claim", ClaimParams, ClaimResult, self.claim),
        ):
            method(name, params=params, result=result, doc="Explicit opt-in CollectiveUI native hub fencing adapter v1; not upstream Hermes.")
            self.server.register_method(name, handler)
        original_resolve = self.server._server_requests.resolve_response
        def resolve(frame):
            return self.guard_answer(frame, current_transport(), original_resolve)
        self.server._server_requests.resolve_response = resolve
        long_handlers = self.server._LONG_HANDLERS | frozenset({"collective.hub_owner.current", "collective.hub_owner.claim"})
        self.server._LONG_HANDLERS = long_handlers
        self.server._rpc_dispatch._LONG_HANDLERS = long_handlers
        return self


def install(server):
    return HubOwner(server).install()
