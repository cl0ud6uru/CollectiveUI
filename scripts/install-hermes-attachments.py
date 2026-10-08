#!/usr/bin/env python3
"""Review-first, version-pinned installer. Never changes services or secrets."""
import argparse
import ast
import hashlib
from pathlib import Path
import subprocess
import tempfile
import os

PIN = "47676981f55de91231fdeef2f0eec47e7c209e78"
SOURCE = Path(__file__).resolve().parent.parent / "src/hermes-attachments/api_server_attachments.py"
API = "gateway/platforms/api_server.py"
RUNS = "gateway/platforms/api_server_runs.py"
MODULE = "gateway/platforms/api_server_attachments.py"


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError("The pinned Hermes source does not match the expected integration point.")
    return text.replace(old, new, 1)


def patched(api, runs):
    api = replace_once(api, "from gateway.platforms import api_server_runs as _api_runs",
                       "from gateway.platforms import api_server_runs as _api_runs\nfrom gateway.platforms import api_server_attachments as _api_attachments")
    api = replace_once(api, '            ("GET", "/v1/capabilities", self._handle_capabilities),',
                       '            ("GET", "/v1/capabilities", self._handle_capabilities),\n            ("POST", "/v1/attachments", self._handle_attachment_upload),')
    api = replace_once(api, '    ("responses", ("POST", "/v1/responses")), ("runs", ("POST", "/v1/runs")),',
                       '    ("responses", ("POST", "/v1/responses")), ("runs", ("POST", "/v1/runs")),\n    ("attachments", ("POST", "/v1/attachments")),')
    api = replace_once(api, '                **_STATIC_FEATURE_FLAGS,',
                       '                **_STATIC_FEATURE_FLAGS,\n                "run_attachments": _api_attachments.FEATURE,')
    api = replace_once(api, '    @_admit_api_agent_request\n    async def _handle_runs(',
                       '    @_require_auth\n    async def _handle_attachment_upload(self, request):\n'
                       '        return await _api_attachments.handle_upload(self, request, _api_request_profile.get() or "default")\n\n'
                       '    @_admit_api_agent_request\n    async def _handle_runs(')
    runs = replace_once(runs, '    if not user_message:\n        return _json_error(_openai_error, "No user message found in input", status=400)',
                        '    user_message, attachment_error = await _api_server._api_attachments.bind_run(\n'
                        '        self, request, body, user_message, _api_server._api_request_profile.get() or "default")\n'
                        '    if attachment_error is not None:\n        return attachment_error\n'
                        '    if not user_message:\n        return _json_error(_openai_error, "No user message found in input", status=400)')
    for text in (api, runs):
        ast.parse(text)
    return api, runs


def atomic_write(path, data):
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-source", type=Path, required=True)
    parser.add_argument("--apply", action="store_true", help="Apply the reviewed patch; default is read-only validation")
    args = parser.parse_args()
    root = args.hermes_source.resolve()
    head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if head != PIN:
        raise SystemExit("Unsupported Hermes revision. Review and port the adapter before installation.")
    dirty = subprocess.check_output(["git", "-C", str(root), "status", "--porcelain", "--", API, RUNS, MODULE], text=True)
    if dirty or (root / MODULE).exists():
        raise SystemExit("Target integration files have changes or the adapter is already installed. No files were changed.")
    originals = {API: (root / API).read_bytes(), RUNS: (root / RUNS).read_bytes()}
    api, runs = patched(originals[API].decode(), originals[RUNS].decode())
    module = SOURCE.read_bytes()
    ast.parse(module)
    print("Validated pinned source, authenticated profile upload route, capabilities, and Runs binding.")
    print("Adapter SHA-256: " + hashlib.sha256(module).hexdigest())
    if not args.apply:
        print("Read-only check complete. No source, configuration, or services were changed.")
        return
    backup = Path(tempfile.mkdtemp(prefix="collectiveui-attachment-backup-", dir=root))
    for name, data in originals.items():
        (backup / Path(name).name).write_bytes(data)
    try:
        atomic_write(root / MODULE, module)
        atomic_write(root / API, api.encode())
        atomic_write(root / RUNS, runs.encode())
    except BaseException:
        for name, data in originals.items():
            atomic_write(root / name, data)
        (root / MODULE).unlink(missing_ok=True)
        raise
    print("Source patch applied; backup directory: " + backup.name)
    print("No service was restarted. Run tests and arrange a gateway restart separately.")


if __name__ == "__main__":
    main()
