"""Exact serving/parking functions from NousResearch/hermes-agent f97608f178d1ffeca59860195ab7da295f7c8e5f.
Source: hermes_cli/profiles.py SHA256 47d01aff498b302905ce887e4b0a90907f107f32cbcdff380cf1ed5f01e3e23b.
Only native-independent function bodies are retained; tests supply directory/active-profile readers.

MIT License
Copyright (c) 2025 Nous Research
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
"""
import logging
from pathlib import Path
from typing import List, Tuple
logger = logging.getLogger(__name__)


def parked_marker_path(home: Path) -> Path:
    return Path(home) / "gateway.parked"


def profile_is_parked(home: Path) -> bool:
    """Marker contents are deliberately irrelevant, including for provisioning."""
    return parked_marker_path(home).exists()


_parked_default_warned: set[Path] = set()


def profiles_to_serve(multiplex: bool, *, include_standalone: bool = False,
                      include_parked: bool = False) -> List[Tuple[str, Path]]:
    """``(profile_name, hermes_home)`` pairs a gateway should serve — the single chokepoint
    for "which profiles does the inbound gateway handle".

    ``multiplex=False``: exactly one entry for the *active* profile (byte-for-byte the
    historical single-profile behavior; name is ``"default"`` or the named profile's id).
    ``multiplex=True``: default plus every live named profile under ``profiles/`` (tombstoned
    and parked profiles skipped). Pure directory read: never creates a profile dir (#94590).

    Named profiles that authored ``gateway.standalone: true`` are skipped because they opted
    out of the host multiplexer; a ``gateway.parked`` marker (``hermes -p X gateway stop``) skips
    a profile the host would otherwise serve. Callers enumerating INSTALLED profiles pass
    ``include_standalone=True, include_parked=True``; serving/ticking callers pass neither."""
    active = get_active_profile_name() or "default"
    default = _get_default_hermes_home()
    if profile_is_parked(default) and default not in _parked_default_warned:
        logger.warning("Ignoring gateway.parked for the default profile; stop the host gateway instead")
        _parked_default_warned.add(default)
    if not multiplex:
        return [(active, get_profile_dir(active))]
    serve: List[Tuple[str, Path]] = [("default", default)]
    serve.extend((entry.name, entry) for entry in _iter_named_profile_dirs()
                 if (include_standalone or not profile_is_standalone(entry))
                 and (include_parked or not profile_is_parked(entry)))
    return serve
