"""Report only structured, nonsecret startup diagnostics; never raw exceptions."""
import json
from pathlib import Path
import re
import runpy
import sys

try:
    runpy.run_path(str(Path(__file__).with_name("remote-hermes-ticket-dashboard.py")), run_name="__main__")
except Exception as error:
    kind = type(error).__name__
    module = getattr(error, "name", "") if isinstance(error, ModuleNotFoundError) else ""
    if not re.fullmatch(r"[A-Za-z0-9_.]{1,120}", module):
        module = ""
    frame = error.__traceback__
    while frame and frame.tb_next:
        frame = frame.tb_next
    site = ""
    if frame:
        candidate = f"{Path(frame.tb_frame.f_code.co_filename).name}:{frame.tb_lineno}:{frame.tb_frame.f_code.co_name}"
        if re.fullmatch(r"[A-Za-z0-9_.:<>-]{1,160}", candidate):
            site = candidate
    print(json.dumps({"startupError": kind if re.fullmatch(r"[A-Za-z0-9_]{1,80}", kind) else "Exception", "missingModule": module, "startupSite": site}), file=sys.__stdout__, flush=True)
    raise SystemExit(1) from None
