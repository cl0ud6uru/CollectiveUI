"""Opt-in v1 cancel/drain protocol for the exact reviewed Hermes dashboard pin.

This is an adapter surface, not an API claimed to exist in unpatched Hermes.
Install before serving requests. No inference, credentials, or policy changes.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import threading
from typing import Literal
import uuid

from pydantic import Field
from tui_gateway.contracts.base import Params, Result
from tui_gateway.contracts.registry import method

PROTOCOL = "collective.cancel-drain.v1"


class Empty(Params):
    pass


class Capabilities(Result):
    protocol: Literal["collective.cancel-drain.v1"] = PROTOCOL
    scope: Literal["inline_prompt_runtime"] = "inline_prompt_runtime"
    durable: bool = True


class CancelParams(Params):
    session_id: str = Field(min_length=1, max_length=200)
    stored_session_id: str = Field(min_length=1, max_length=200)
    recovery_id: str = Field(min_length=1, max_length=200)
    reservation_ids: list[str] = Field(min_length=1, max_length=100)
    profile: str = Field(default="default", min_length=1, max_length=100)


class StatusParams(Params):
    recovery_id: str = Field(min_length=1, max_length=200)


class Receipt(Result):
    protocol: Literal["collective.cancel-drain.v1"] = PROTOCOL
    recovery_id: str
    session_id: str
    stored_session_id: str
    reservation_ids: list[str]
    state: Literal["pending", "drained"]
    reason: Literal["workers_pending", "process_changed", "drained"]


class Recovery:
    def __init__(self, server):
        self.server = server
        self.boot = str(uuid.uuid4())
        self.admission_lock = threading.RLock()
        self.work_lock = threading.RLock()
        self.work = {}  # id(session) -> all worker handles; never infer from running=False.
        self.fences = {}  # runtime -> exact in-memory generation captured before cancellation.
        self.path = Path(server._hermes_home) / "collective-recovery.sqlite"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600) if not self.path.exists() else None
        if fd is not None:
            os.close(fd)
        with self.database() as db:
            db.execute("CREATE TABLE IF NOT EXISTS recovery (id TEXT PRIMARY KEY, principal TEXT NOT NULL, digest TEXT NOT NULL, boot TEXT NOT NULL, home TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL)")
            db.execute("CREATE UNIQUE INDEX IF NOT EXISTS one_pending_runtime ON recovery(home,json_extract(body,'$.session_id')) WHERE state='pending'")

    @contextlib.contextmanager
    def database(self):
        db = sqlite3.connect(self.path, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def principal(self):
        return self.server._transport_auth_user_id(self.server.current_transport()) or "local-stdio"

    def remember(self, session, thread):
        if thread is not None:
            with self.work_lock:
                self.work.setdefault(id(session), set()).add(thread)
        return thread

    def blocked(self, session):
        if session.get("_closing"):
            return True
        home = str(self.server._session_home(session).resolve())
        key = str(self.server._session_lookup_key(session))
        with self.database() as db:
            # An earlier process cannot prove that its accepted work drained.
            rows = db.execute("SELECT boot,body FROM recovery WHERE home=? AND state='pending'", (home,)).fetchall()
        return any(row[0] != self.boot or json.loads(row[1])["stored_session_id"] == key for row in rows)

    def cancel(self, rid, raw):
        try:
            p = CancelParams.model_validate(raw)
            uuid.UUID(p.recovery_id)
            ids = sorted(set(p.reservation_ids))
            if len(ids) != len(p.reservation_ids) or any(not item or len(item) > 200 for item in ids):
                raise ValueError()
        except (ValueError, TypeError):
            return self.server._err(rid, 4000, "Invalid cancel/drain request")
        body = dict(recovery_id=p.recovery_id, session_id=p.session_id,
                    stored_session_id=p.stored_session_id, reservation_ids=ids)
        digest = hashlib.sha256(json.dumps([self.principal(), p.profile, body], sort_keys=True).encode()).hexdigest()
        with self.admission_lock:
            with self.database() as db:
                row = db.execute("SELECT principal,digest FROM recovery WHERE id=?", (p.recovery_id,)).fetchone()
            if row:
                if row != (self.principal(), digest):
                    return self.server._err(rid, 4090, "Recovery identity conflicts with its retained receipt")
                return self.status(rid, {"recovery_id": p.recovery_id})
            s, error = self.server._sess_nowait({"session_id": p.session_id}, rid)
            if error:
                return error  # Missing runtime is not evidence of drained work.
            expected_home = self.server._profile_home(p.profile) or self.server._hermes_home
            home = self.server._session_home(s).resolve()
            actual_principal = s.get("auth_user_id") or "local-stdio"
            if actual_principal != self.principal() or home != Path(expected_home).resolve() or str(self.server._session_lookup_key(s)) != p.stored_session_id:
                return self.server._err(rid, 4030, "Recovery does not match the native session identity")
            if self.server._session_uses_compute_host(s) or s.get("slash_worker"):
                return self.server._err(rid, 4090, "This runtime cannot provide inline prompt drain evidence")
            with self.database() as db:
                pending = db.execute("SELECT id FROM recovery WHERE home=? AND state='pending' AND json_extract(body,'$.session_id')=?", (str(home), p.session_id)).fetchone()
            if pending:
                return self.server._err(rid, 4090, "Recovery already pending; reuse its original recovery identity")
            # Write before touching runtime state: a lost response retains the exact binding.
            with self.database() as db:
                db.execute("INSERT INTO recovery VALUES (?,?,?,?,?,?,?)", (p.recovery_id, self.principal(), digest, self.boot, str(home), json.dumps(body), "pending"))
            with self.server._sessions_lock:
                if self.server._sessions.get(p.session_id) is not s:
                    return self.status(rid, {"recovery_id": p.recovery_id})
                s["_closing"] = True  # Native final publication and queued-turn gates reject this generation.
                self.fences[p.session_id] = s
            self.remember(s, s.get("_run_thread"))
            self.remember(s, s.get("_agent_build_thread"))
            if (stop := s.get("_notif_stop")) is not None:
                stop.set()
            self.server._interrupt_session_turn(p.session_id, s)
            return self.status(rid, {"recovery_id": p.recovery_id})

    def status(self, rid, raw):
        try:
            p = StatusParams.model_validate(raw)
        except ValueError:
            return self.server._err(rid, 4000, "Invalid recovery status request")
        with self.admission_lock:
            with self.database() as db:
                row = db.execute("SELECT principal,boot,body,state FROM recovery WHERE id=?", (p.recovery_id,)).fetchone()
            if row is None or row[0] != self.principal():
                return self.server._err(rid, 4040, "Recovery receipt not found")
            principal, boot, encoded, state = row
            body = json.loads(encoded)
            reason = "drained" if state == "drained" else ("workers_pending" if boot == self.boot else "process_changed")
            if state == "pending" and boot == self.boot:
                sid = body["session_id"]
                s = self.fences.get(sid)
                if s is not None:
                    self.remember(s, s.get("_run_thread"))
                    self.remember(s, s.get("_agent_build_thread"))
                    with self.work_lock:
                        alive = any(t.is_alive() for t in self.work.get(id(s), ()))
                    # The close flag prevents successor publication. Delegations are separately owned;
                    # their failure/unknown query is conservative in the native implementation.
                    if not alive and not s.get("_compute_host_turn_id") and not s.get("slash_worker") and not self.server._session_has_active_delegations(sid, s):
                        with self.server._sessions_lock:
                            same = self.server._sessions.get(sid) is s and s.get("_closing")
                            if same:
                                self.server._sessions.pop(sid)
                                s["_sid"] = sid
                        if same:
                            # Call close only AFTER proof; its grace timeout is never the proof.
                            self.server._teardown_popped_session(s, end_reason="collective_cancel_drain")
                            with self.database() as db:
                                db.execute("UPDATE recovery SET state='drained' WHERE id=? AND principal=? AND boot=?", (p.recovery_id, principal, self.boot))
                            state = reason = "drained"
            return self.server._ok(rid, dict(protocol=PROTOCOL, **body, state=state, reason=reason))


def install(server):
    if getattr(server, "_collective_recovery", None) is not None:
        raise RuntimeError("Recovery protocol already installed")
    recovery = Recovery(server)
    server._collective_recovery = recovery
    original_work = server._start_session_work

    def start_work(target, *, name, session=None):
        # Native launch sites hold _sessions_lock and enforce _closing. Preserve that lock order.
        if session is not None and session.get("_closing"):
            return None
        return recovery.remember(session, original_work(target, name=name, session=session)) if session is not None else original_work(target, name=name)

    server._start_session_work = start_work
    original_build = server._start_agent_build

    def build(sid, session):
        with server._sessions_lock:
            if session.get("_closing"):
                return
            original_build(sid, session)
            recovery.remember(session, session.get("_agent_build_thread"))

    server._start_agent_build = build
    original_turn = server._run_prompt_submit

    def run_turn(rid, sid, session, text, **kwargs):
        # Internal queue/notification/deferred paths also cross this barrier BEFORE
        # the native helper can persist a row or publish its successor worker.
        with recovery.admission_lock:
            if server._sessions.get(sid) is not session or recovery.blocked(session):
                return False
            return original_turn(rid, sid, session, text, **kwargs)

    server._run_prompt_submit = run_turn
    original_poller = server._start_notification_poller

    def poller(sid, session):
        with server._sessions_lock:
            if session.get("_closing"):
                stopped = threading.Event()
                stopped.set()
                return stopped
            stop = original_poller(sid, session)
            for event, thread in server._notification_pollers:
                if event is stop:
                    recovery.remember(session, thread)
            return stop

    server._start_notification_poller = poller

    def auxiliary(target, *, name, session):
        with server._sessions_lock:
            if session.get("_closing"):
                return None
            return recovery.remember(session, original_work(target, name=name))

    server._collective_start_auxiliary_work = auxiliary
    original_pop = server._pop_session_by_id

    def pop(sid):
        if sid in recovery.fences:
            return None  # A reaper/close acknowledgement cannot retire our pending proof.
        return original_pop(sid)

    server._pop_session_by_id = pop
    for name, handler in list(server._methods.items()):
        def guarded(rid, params, handler=handler, name=name):
            sid = str(params.get("session_id") or "")
            s = server._sessions.get(sid)
            if s is not None and recovery.blocked(s):
                return server._err(rid, 4090, "Native recovery is pending; no new work was admitted")
            if name in {"session.resume", "session.create"}:
                home = server._profile_home(params.get("profile") or "default") or server._hermes_home
                with recovery.database() as db:
                    rows = db.execute("SELECT boot,body FROM recovery WHERE home=? AND state='pending'", (str(Path(home).resolve()),)).fetchall()
                if any(row[0] != recovery.boot or json.loads(row[1])["stored_session_id"] == sid for row in rows):
                    return server._err(rid, 4090, "Native recovery is pending; no new runtime was admitted")
            result = handler(rid, params)
            if name == "prompt.submit" and s is not None:
                recovery.remember(s, s.get("_run_thread"))
                recovery.remember(s, s.get("_agent_build_thread"))
            return result
        def serialized(rid, params, guarded=guarded):
            # Include synchronous command/config handlers: one already inside its native
            # handler cannot publish a new worker after the drain fence is established.
            # V1 deliberately serializes RPC handlers in this opt-in backend.
            with recovery.admission_lock:
                return guarded(rid, params)
        server._methods[name] = serialized
    for name, params, result, handler in (
        ("collective.recovery.capabilities", Empty, Capabilities, lambda rid, p: server._ok(rid, Capabilities().model_dump())),
        ("collective.recovery.cancel_and_drain", CancelParams, Receipt, recovery.cancel),
        ("collective.recovery.status", StatusParams, Receipt, recovery.status),
    ):
        method(name, params=params, result=result, doc="Explicit opt-in CollectiveUI recovery adapter v1; not an upstream native method.")
        server.register_method(name, handler)
    server._LONG_HANDLERS = server._LONG_HANDLERS | frozenset({"collective.recovery.cancel_and_drain", "collective.recovery.status"})
    return recovery
