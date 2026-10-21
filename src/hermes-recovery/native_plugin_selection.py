"""Native owned-session RPC for a selection sidecar; never activates plugins."""
from __future__ import annotations
from pathlib import Path
from typing import Literal
from pydantic import Field, StrictBool
from tui_gateway.contracts.base import Params, Result
from tui_gateway.contracts.registry import method
from tui_gateway.transport import current_transport
from hermes_cli import collective_plugin_selection as store
from hermes_cli.collective_plugin_selection import PROTOCOL, KEY, VERSION, IDENTITY, _eligible, _locked, _state, _select

class SelectionParams(Params):
    profile: str = Field(min_length=1, max_length=200)
    session_id: str = Field(min_length=1, max_length=200)
    action: Literal["inspect", "select"] = "inspect"
    key: Literal["teams_pipeline"] = KEY
    expected_identity: str | None = None
    expected_revision: str | None = None
    enabled: StrictBool | None = None


class SelectionResult(Result):
    protocol: str = PROTOCOL
    key: str = KEY
    name: str = KEY
    version: str = VERSION
    identity_revision: str = IDENTITY
    revision: str
    selected: StrictBool | None = None
    operator_selected: StrictBool | None = None
    startup_selected: StrictBool | None = None
    loaded_state: str = "unreported"
    requires_local_operator_confirmation: bool = True


def install(server):
    if getattr(server, "_collective_plugin_selection", None) is not None:
        raise RuntimeError("plugin selection already installed")
    def handle(rid, raw):
        try:
            params = SelectionParams.model_validate(raw)
            if (params.key != KEY or params.action not in {"inspect", "select"} or
                    (params.action == "inspect" and any(value is not None for value in
                     (params.enabled, params.expected_identity, params.expected_revision)))):
                raise ValueError("invalid selection request")
            owner_module = __import__("tui_gateway.collective_hub_owner", fromlist=["_active_binding"])
            binding = owner_module._active_binding.get()
            transport = current_transport()
            if (binding is None or binding.phase != "full" or binding.profile != params.profile
                    or binding.transport is not transport):
                return server._err(rid, 4030, "Plugin selection requires current full profile ownership.")
            home = Path(binding.home).resolve(strict=True)
            if str(home) not in store._startup:
                return server._err(rid, 4090, "This profile was not included in the bounded process-start selection snapshot.")
            attached, session = server._current_session_steer_authority(params.session_id)
            if attached is not transport or session is None or Path(server._session_home(session)).resolve() != home:
                return server._err(rid, 4030, "Plugin selection requires the attached native profile session.")
            # The owner wrapper holds the profile lock. Keep profile -> history ->
            # sidecar order and reject work in every session of this profile.
            owner = server._collective_hub_owner
            if owner._profile_has_native_work(home):
                return server._err(rid, 4090, "Finish all native profile work before reviewing plugin selection.")
            with session["history_lock"]:
                if (server._session_live_status(params.session_id, session) != "idle" or
                        server._inflight_snapshot(session) or server._queued_prompt_snapshot(session)):
                    return server._err(rid, 4090, "Finish native work before reviewing plugin selection.")
                _eligible(Path(__file__).resolve().parents[1])
                if params.action == "select":
                    if params.expected_identity != IDENTITY or params.enabled is None:
                        raise ValueError("plugin identity changed")
                    revision, selected, _generation, committed = _select(home, params.expected_revision, params.enabled)
                else:
                    with _locked(home) as fd:
                        revision, selected, _generation, committed = _state(fd, home)
                return server._ok(rid, SelectionResult(revision=revision, selected=selected, operator_selected=committed,
                    startup_selected=store._startup.get(str(home))).model_dump())
        except (OSError, ValueError, TypeError, RuntimeError):
            return server._err(rid, 4090, "Plugin selection is unavailable or changed; refresh before reviewing it.")

    method("collective.plugins.selection.v1", params=SelectionParams, result=SelectionResult,
        doc="Ordinary plugin selection sidecar only; never activates, reloads or writes shared configuration.")
    server.register_method("collective.plugins.selection.v1", handle)
    server._LONG_HANDLERS = server._LONG_HANDLERS | frozenset({"collective.plugins.selection.v1"})
    server._collective_plugin_selection = handle
