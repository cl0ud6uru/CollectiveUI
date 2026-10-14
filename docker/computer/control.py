#!/usr/bin/env python3
"""Bounded, local-only desktop capture and input for an Xvfb display."""

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


MAX_INPUT_BYTES = 16 * 1024
MAX_TEXT_CHARS = 4000
MAX_SCREENSHOT_BYTES = 512 * 1024
WIDTH = 1280
HEIGHT = 800
DISPLAY = ":99"
AUTHORITY = "/tmp/collective-computer.Xauthority"
STATE_DIR = Path("/codex-home/computer-runtime-state")
STATE_FILE = STATE_DIR / "session.json"
TIMEOUT_SECONDS = 10
KEYS = {
    "Enter": "Return", "Tab": "Tab", "Escape": "Escape", "Backspace": "BackSpace",
    "ArrowUp": "Up", "ArrowDown": "Down", "ArrowLeft": "Left", "ArrowRight": "Right",
    "Control+a": "ctrl+a", "Control+c": "ctrl+c", "Control+v": "ctrl+v",
}


class InputError(ValueError):
    pass


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 2


def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise InputError("duplicate JSON key")
        result[key] = value
    return result


def read_action() -> dict[str, object]:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise InputError("input exceeds the size limit")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InputError("input must be one JSON object") from error
    if not isinstance(value, dict):
        raise InputError("input must be one JSON object")
    return value


def exact_keys(action: dict[str, object], required: set[str], optional: set[str] = set()) -> None:
    keys = set(action)
    if not required <= keys or keys - required - optional:
        raise InputError("input has unsupported fields")


def command_for(action: dict[str, object]) -> tuple[list[str], bytes | None]:
    kind = action.get("kind")
    if kind == "click":
        exact_keys(action, {"kind", "x", "y"}, {"button"})
        x, y = action.get("x"), action.get("y")
        if type(x) is not int or type(y) is not int or not (0 <= x < WIDTH and 0 <= y < HEIGHT):
            raise InputError("click coordinates are outside the display")
        button = action.get("button", "left")
        buttons = {"left": "1", "middle": "2", "right": "3"}
        if button not in buttons:
            raise InputError("unsupported mouse button")
        return ["/usr/bin/xdotool", "mousemove", "--sync", str(x), str(y),
                "click", "--clearmodifiers", buttons[button]], None
    if kind == "type":
        exact_keys(action, {"kind", "text"})
        value = action.get("text")
        if not isinstance(value, str) or len(value) > MAX_TEXT_CHARS or "\x00" in value:
            raise InputError("text must be a string of at most 4000 characters")
        if any(ord(char) < 32 or 127 <= ord(char) < 160 for char in value):
            raise InputError("text cannot contain control characters")
        return ["/usr/bin/xdotool", "type", "--clearmodifiers", "--delay", "0", "--file", "-"], value.encode("utf-8")
    if kind == "key":
        exact_keys(action, {"kind", "key"})
        key = action.get("key")
        if not isinstance(key, str) or key not in KEYS:
            raise InputError("unsupported key")
        return ["/usr/bin/xdotool", "key", "--clearmodifiers", KEYS[key]], None
    if kind == "scroll":
        exact_keys(action, {"kind", "direction", "amount"})
        direction, amount = action.get("direction"), action.get("amount")
        if direction not in ("up", "down") or type(amount) is not int or not 1 <= amount <= 10:
            raise InputError("scroll direction or amount is invalid")
        button = "4" if direction == "up" else "5"
        return ["/usr/bin/xdotool", "click", "--repeat", str(amount), "--delay", "40", button], None
    raise InputError("unsupported input kind")


def jpeg_dimensions(data: bytes) -> tuple[int, int] | None:
    if len(data) < 4 or data[:2] != b"\xff\xd8" or data[-2:] != b"\xff\xd9":
        return None
    offset = 2
    sof = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    while offset + 3 < len(data):
        if data[offset] != 0xFF:
            return None
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            return None
        marker = data[offset]
        offset += 1
        if marker in (0xD9, 0xDA):
            return None
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            continue
        if offset + 1 >= len(data):
            return None
        segment_length = int.from_bytes(data[offset:offset + 2], "big")
        if segment_length < 2 or offset + segment_length > len(data):
            return None
        if marker in sof:
            if segment_length < 8:
                return None
            height = int.from_bytes(data[offset + 3:offset + 5], "big")
            width = int.from_bytes(data[offset + 5:offset + 7], "big")
            return width, height
        offset += segment_length
    return None


def process_identity(pid: int) -> dict[str, int | str] | None:
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
        fields = raw[raw.rfind(")") + 1:].split()
        return {"pid": pid, "state": fields[0], "ppid": int(fields[1]), "starttime": int(fields[19])}
    except (FileNotFoundError, PermissionError, ValueError, IndexError):
        return None


def read_state() -> dict[str, object]:
    try:
        state = json.loads(STATE_FILE.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise InputError("computer session state is unavailable") from error
    if (not isinstance(state, dict) or state.get("version") != 1 or state.get("status") not in ("running", "pausing", "paused") or
            not isinstance(state.get("root"), dict) or not isinstance(state.get("processes"), list)):
        raise InputError("computer session state is invalid")
    return state


def write_state(state: dict[str, object]) -> None:
    temporary = STATE_DIR / ".session.json.tmp"
    temporary.write_text(json.dumps(state, separators=(",", ":")))
    temporary.chmod(0o600)
    temporary.replace(STATE_FILE)


def root_identity(state: dict[str, object]) -> tuple[int, int]:
    root = state["root"]
    if not isinstance(root, dict) or type(root.get("pid")) is not int or type(root.get("starttime")) is not int:
        raise InputError("computer session root is invalid")
    pid, starttime = root["pid"], root["starttime"]
    current = process_identity(pid)
    if not current or current["starttime"] != starttime:
        raise InputError("computer session has ended")
    cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\x00", b" ")
    if b"/opt/collective-computer/app-server.mjs" not in cmdline:
        raise InputError("computer session root does not match")
    return pid, starttime


def process_tree(root_pid: int, root_starttime: int) -> list[dict[str, int]]:
    table: dict[int, dict[str, int | str]] = {}
    try:
        entries = Path("/proc").iterdir()
        for entry in entries:
            if entry.name.isdigit():
                identity = process_identity(int(entry.name))
                if identity:
                    table[int(entry.name)] = identity
    except OSError as error:
        raise InputError("cannot inspect computer process tree") from error
    root = table.get(root_pid)
    if not root or root["starttime"] != root_starttime:
        raise InputError("computer session has ended")
    children: dict[int, list[int]] = {}
    for pid, identity in table.items():
        children.setdefault(int(identity["ppid"]), []).append(pid)
    ordered: list[dict[str, int]] = []
    queue = [root_pid]
    seen: set[int] = set()
    while queue:
        pid = queue.pop(0)
        if pid in seen:
            continue
        seen.add(pid)
        identity = table.get(pid)
        if not identity:
            continue
        ordered.append({"pid": pid, "starttime": int(identity["starttime"])})
        queue.extend(children.get(pid, []))
    return ordered


def signal_identity(identity: dict[str, int], sig: int, require_stopped: bool = False) -> bool:
    current = process_identity(identity["pid"])
    if not current or current["starttime"] != identity["starttime"]:
        return False
    if require_stopped and current["state"] not in ("T", "t"):
        return False
    try:
        os.kill(identity["pid"], sig)
        return True
    except ProcessLookupError:
        return False


def pause_session() -> int:
    try:
        state = read_state()
        if state["status"] == "paused":
            return 0
        root_pid, root_starttime = root_identity(state)
        tracked = [item for item in state["processes"] if isinstance(item, dict) and
                   type(item.get("pid")) is int and type(item.get("starttime")) is int]
        tracked_ids = {(item["pid"], item["starttime"]) for item in tracked}
        state["status"] = "pausing"
        write_state(state)
        signal_identity({"pid": root_pid, "starttime": root_starttime}, signal.SIGSTOP)
        root_deadline = time.monotonic() + 2
        while time.monotonic() < root_deadline:
            current_root = process_identity(root_pid)
            if not current_root or current_root["starttime"] != root_starttime:
                raise InputError("computer session has ended")
            if current_root["state"] in ("T", "t"):
                break
            time.sleep(0.01)
        else:
            raise InputError("computer session could not be paused")
        for _ in range(10):
            current_tree = process_tree(root_pid, root_starttime)
            new_items = [item for item in current_tree if (item["pid"], item["starttime"]) not in tracked_ids]
            if not new_items:
                # Two empty scans allow a child already running during the first scan to settle.
                time.sleep(0.05)
                if not [item for item in process_tree(root_pid, root_starttime)
                        if (item["pid"], item["starttime"]) not in tracked_ids]:
                    still_running = []
                    for item in tracked:
                        current = process_identity(item["pid"])
                        if current and current["starttime"] == item["starttime"] and current["state"] not in ("T", "t"):
                            signal_identity(item, signal.SIGSTOP)
                            still_running.append(item)
                    if still_running:
                        continue
                    state["status"] = "paused"
                    state["processes"] = tracked
                    write_state(state)
                    return 0
                continue
            for item in new_items:
                signal_identity(item, signal.SIGSTOP)
                tracked.append(item)
                tracked_ids.add((item["pid"], item["starttime"]))
                state["processes"] = tracked
                write_state(state)
        raise InputError("computer process tree did not settle")
    except InputError as error:
        # Keep the app-server and every process already recorded stopped. The broker
        # can retry pause or explicitly resume after a failed handoff.
        return fail(str(error))


def resume_session() -> int:
    try:
        state = read_state()
        root_identity(state)
        if state["status"] == "running":
            return 0
        tracked = state["processes"]
        if not isinstance(tracked, list):
            raise InputError("computer process list is invalid")
        # Children resume before the app-server root, so no new subprocess can race the walk.
        for item in reversed(tracked):
            if isinstance(item, dict) and type(item.get("pid")) is int and type(item.get("starttime")) is int:
                signal_identity(item, signal.SIGCONT, require_stopped=True)
        state["status"] = "running"
        root = state["root"]
        state["processes"] = [root]
        write_state(state)
        return 0
    except InputError as error:
        return fail(str(error))


def screenshot() -> int:
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "DISPLAY": DISPLAY,
           "XAUTHORITY": AUTHORITY}
    try:
        result = subprocess.run(["/usr/bin/import", "-display", DISPLAY, "-window", "root",
                                 "-resize", f"{WIDTH}x{HEIGHT}!", "-quality", "70",
                                 "-define", f"jpeg:extent={MAX_SCREENSHOT_BYTES}B", "jpeg:-"],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, env=env, timeout=TIMEOUT_SECONDS,
                                check=False)
    except (OSError, subprocess.SubprocessError):
        return fail("screenshot failed")
    data = result.stdout
    if result.returncode != 0 or len(data) > MAX_SCREENSHOT_BYTES or jpeg_dimensions(data) != (WIDTH, HEIGHT):
        return fail("screenshot failed validation")
    sys.stdout.buffer.write(data)
    return 0


def input_action() -> int:
    try:
        action = read_action()
        argv, payload = command_for(action)
    except (InputError, TypeError) as error:
        return fail(str(error))
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "DISPLAY": DISPLAY,
           "XAUTHORITY": AUTHORITY}
    try:
        subprocess.run(argv, input=payload, stdin=None if payload is not None else subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env,
                       timeout=TIMEOUT_SECONDS, check=True)
    except (OSError, subprocess.SubprocessError):
        return fail("input action failed")
    print("OK")
    return 0


def main(argv: list[str]) -> int:
    if argv == ["screenshot"]:
        return screenshot()
    if argv == ["input"]:
        return input_action()
    if argv == ["pause"]:
        return pause_session()
    if argv == ["resume"]:
        return resume_session()
    return fail("usage: computer screenshot | computer input | pause | resume")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
