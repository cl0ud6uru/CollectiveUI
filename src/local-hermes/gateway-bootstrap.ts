/** Fixed, controller-owned extension for the pinned Hermes stdio gateway. Never interpolate browser input. */
export const NATIVE_SETTLEMENT_INSTALL = String.raw`
import hermes_bootstrap
hermes_bootstrap.harden_import_path()
from tui_gateway import server as _collective_server

# The worker proof covers in-process native threads only. Refuse unsupported
# isolation at startup instead of admitting work that cannot later settle.
if _collective_server._turn_isolation_enabled():
    raise RuntimeError("Controller requires in-process native turn execution")

def _collective_session_settled(_rid, _params):
    # RPC dispatch reserves one retirement slot for this observer. Worker reservations
    # survive message.complete, running=False, settled-info, and all post-turn followups.
    # Counting a single slot proves there is no worker still able to dispatch a successor.
    import re
    if not isinstance(_params, dict) or set(_params) != {"session_id"}:
        return _collective_server._err(_rid, 4000, "Invalid controller settlement request")
    _sid = _params.get("session_id")
    if not isinstance(_sid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", _sid):
        return _collective_server._err(_rid, 4000, "Invalid controller session identity")
    _settled = False
    try:
        from hermes_cli.backend_retirement import retirement as _retirement
        _session = _collective_server._sessions.get(_sid)
        if isinstance(_session, dict):
            # Native _open_requests reacquires this non-reentrant history lock.
            # Read it before taking the lock; an arriving worker still reserves
            # retirement admission, so the count below prevents false settlement.
            _pending = _collective_server._open_requests(_sid)
            with _session["history_lock"]:
                # Compute-host completions have another parent callback lifetime; the
                # inline retirement proof must never be applied to that transport.
                _isolated = _collective_server._session_uses_compute_host(_session)
                _settled = bool(
                    _collective_server._sessions.get(_sid) is _session
                    and not _session.get("_closing")
                    and not _session.get("_finalized")
                    and not _isolated
                    and not _session.get("running")
                    and not _session.get("queued_prompt")
                    and not _session.get("queued_prompts")
                    and not _pending
                    and _retirement.active_count() == 1
                )
    except Exception:
        # Any missing/changed ledger is uncertain. Do not serialize native exceptions.
        _settled = False
    return _collective_server._ok(_rid, {"session_id": _sid, "settled": _settled})

if "collective.session.settled" in _collective_server._methods:
    raise RuntimeError("Controller settlement extension already installed")
_collective_server._methods["collective.session.settled"] = _collective_session_settled
`;

export const GATEWAY_BOOTSTRAP = `${NATIVE_SETTLEMENT_INSTALL}\nimport runpy\nrunpy.run_module("tui_gateway.entry", run_name="__main__")\n`;
