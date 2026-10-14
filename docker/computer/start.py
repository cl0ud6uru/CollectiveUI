#!/usr/bin/env python3
"""Supervise the desktop display, sandboxed GUI, and stock Codex app-server."""

import json
import os
import secrets
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path


DISPLAY = ":99"
AUTHORITY = Path("/tmp/collective-computer.Xauthority")
WORKSPACE = Path("/home/agent/workspace")
PROFILE = Path(os.environ.get("COMPUTER_PROFILE", str(WORKSPACE / ".computer-profile")))
SOCKET = Path("/tmp/.X11-unix/X99")
STATE_DIR = Path("/codex-home/computer-runtime-state")
STATE_FILE = STATE_DIR / "session.json"
APP_SERVER = "/opt/collective-computer/app-server.mjs"
BWRAP = "/opt/codex/codex-resources/bwrap"
CHILDREN: list[subprocess.Popen[bytes]] = []
STOP = False


def stop(_signum: int, _frame: object) -> None:
    global STOP
    STOP = True


def terminate_all() -> None:
    for child in reversed(CHILDREN):
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + 5
    for child in reversed(CHILDREN):
        remaining = max(0.0, deadline - time.monotonic())
        try:
            child.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()


def spawn(argv: list[str], env: dict[str, str], pass_fds: tuple[int, ...] = ()) -> subprocess.Popen[bytes]:
    child = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=None,
                             start_new_session=True, close_fds=True, pass_fds=pass_fds)
    CHILDREN.append(child)
    return child


def wait_for_display(server: subprocess.Popen[bytes], env: dict[str, str]) -> None:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if STOP:
            raise RuntimeError("startup cancelled")
        if server.poll() is not None:
            raise RuntimeError("display server exited")
        try:
            info = SOCKET.stat()
            if stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid():
                probe = subprocess.run(["/usr/bin/xdpyinfo", "-display", DISPLAY], env=env,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL, timeout=1, check=False)
                if probe.returncode == 0:
                    return
        except (FileNotFoundError, subprocess.SubprocessError):
            pass
        time.sleep(0.05)
    raise RuntimeError("display server did not become ready")


def prepare_directory(path: Path, mode: int = 0o700) -> None:
    try:
        path.mkdir(mode=mode)
    except FileExistsError:
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError("computer runtime directory is unsafe")
    path.chmod(mode)


def prepare_workspace() -> None:
    prepare_directory(PROFILE)
    metadata = WORKSPACE / ".codex"
    try:
        metadata.mkdir(mode=0o700)
    except FileExistsError:
        info = metadata.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError("workspace metadata path is unsafe")


def start_time(pid: int) -> int:
    raw = Path(f"/proc/{pid}/stat").read_text()
    fields = raw[raw.rfind(")") + 1:].split()
    return int(fields[19])


def write_session(server: subprocess.Popen[bytes]) -> None:
    prepare_directory(STATE_DIR)
    identity = {"pid": server.pid, "starttime": start_time(server.pid)}
    state = {"version": 1, "root": identity, "status": "running", "processes": [identity]}
    temporary = STATE_DIR / ".session.json.tmp"
    temporary.write_text(json.dumps(state, separators=(",", ":")))
    temporary.chmod(0o600)
    temporary.replace(STATE_FILE)


def bwrap_desktop_command(env: dict[str, str], authority_fd: int) -> list[str]:
    command = [
        BWRAP, "--die-with-parent", "--new-session", "--unshare-user", "--uid", "10001", "--gid", "10001",
        "--unshare-pid", "--unshare-ipc", "--ro-bind", "/", "/",
        "--proc", "/proc", "--dev", "/dev",
        "--tmpfs", "/codex-home", "--tmpfs", "/sys", "--tmpfs", "/run",
        # Stage only the mounted workspace and X socket under fresh /dev/shm
        # before replacing their parent paths with private mounts.
        "--dir", "/dev/shm/collective-x11", "--dir", "/dev/shm/collective-workspace",
        "--bind", "/tmp/.X11-unix", "/dev/shm/collective-x11",
        "--bind", str(WORKSPACE), "/dev/shm/collective-workspace",
        "--tmpfs", "/home/agent", "--dir", "/home/agent/workspace",
        "--bind", "/dev/shm/collective-workspace", str(WORKSPACE),
        "--tmpfs", "/tmp", "--dir", "/tmp/.X11-unix",
        "--dir", "/tmp/cache", "--dir", "/tmp/config",
        "--bind", "/dev/shm/collective-x11", "/tmp/.X11-unix",
        "--file", str(authority_fd), str(AUTHORITY),
        "--tmpfs", str(WORKSPACE / ".codex"),
        "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
        "--setenv", "LANG", "C.UTF-8",
        "--setenv", "HOME", str(WORKSPACE),
        "--setenv", "DISPLAY", DISPLAY,
        "--setenv", "XAUTHORITY", str(AUTHORITY),
        "--setenv", "COMPUTER_PROFILE", str(PROFILE),
        "--setenv", "XDG_CACHE_HOME", "/tmp/cache",
        "--setenv", "XDG_CONFIG_HOME", "/tmp/config",
        "--chdir", str(WORKSPACE), "--",
        "/usr/bin/python3", "/opt/collective-computer/start.py", "--desktop",
    ]
    command.insert(1, "--clearenv")
    env_flags: list[str] = []
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"):
        if env.get(key):
            env_flags.extend(["--setenv", key, env[key]])
    command[command.index("--chdir"):command.index("--chdir")] = env_flags
    return command


def desktop_main() -> int:
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
           "DISPLAY": DISPLAY, "XAUTHORITY": str(AUTHORITY),
           "HOME": str(WORKSPACE), "COMPUTER_PROFILE": str(PROFILE),
           "XDG_CACHE_HOME": "/tmp/cache", "XDG_CONFIG_HOME": "/tmp/config"}
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"):
        value = os.environ.get(key)
        if value:
            env[key] = value
    try:
        fluxbox = spawn(["/usr/bin/fluxbox", "-display", DISPLAY], env)
        time.sleep(0.15)
        if fluxbox.poll() is not None:
            raise RuntimeError("window manager exited")
        chromium = spawn(["/usr/bin/chromium", "--user-data-dir=" + str(PROFILE),
                          "--window-size=1280,800", "--window-position=0,0", "--start-maximized",
                          "--no-first-run", "--no-default-browser-check", "about:blank"], env)
        time.sleep(0.25)
        if chromium.poll() is not None:
            raise RuntimeError("browser exited")
        while not STOP:
            for child in CHILDREN:
                if child.poll() is not None:
                    return child.returncode or 1
            time.sleep(0.1)
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"computer desktop sandbox failed to start: {error}", file=sys.stderr)
        return 1
    finally:
        terminate_all()


def main() -> int:
    if sys.argv[1:] == ["--desktop"]:
        return desktop_main()
    if sys.argv[1:]:
        print("computer runtime failed to start", file=sys.stderr)
        return 1
    for name in ("/usr/bin/Xvfb", "/usr/bin/xdpyinfo", "/usr/bin/xauth", "/usr/bin/python3",
                 "/usr/local/bin/node", BWRAP, "/usr/local/bin/codex", APP_SERVER,
                 "/usr/bin/chromium", "/usr/bin/fluxbox"):
        if not Path(name).exists():
            print("computer runtime is missing a required executable", file=sys.stderr)
            return 1
    if os.getuid() != 10001:
        print("computer runtime must run as the stock non-root user", file=sys.stderr)
        return 1

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    outer_env = os.environ.copy()
    xenv = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
            "DISPLAY": DISPLAY, "XAUTHORITY": str(AUTHORITY)}
    try:
        prepare_workspace()
        prepare_directory(STATE_DIR)
        AUTHORITY.unlink(missing_ok=True)
        cookie = secrets.token_hex(16)
        subprocess.run(["/usr/bin/xauth", "-f", str(AUTHORITY), "add", DISPLAY, ".", cookie],
                       check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, env=xenv, timeout=5)
        AUTHORITY.chmod(0o600)

        xvfb = spawn(["/usr/bin/Xvfb", DISPLAY, "-screen", "0", "1280x800x24",
                      "-nolisten", "tcp", "-noreset", "-auth", str(AUTHORITY)], xenv)
        wait_for_display(xvfb, xenv)
        with AUTHORITY.open("rb") as authority_file:
            desktop = spawn(bwrap_desktop_command(outer_env, authority_file.fileno()), outer_env,
                            pass_fds=(authority_file.fileno(),))
        app_env = outer_env.copy()
        app_env.pop("DISPLAY", None)
        app_env.pop("XAUTHORITY", None)
        app_env.pop("COMPUTER_PROFILE", None)
        server = spawn(["/usr/local/bin/node", APP_SERVER], app_env)
        write_session(server)

        while not STOP:
            for child in CHILDREN:
                if child.poll() is not None:
                    return child.returncode or 1
            time.sleep(0.1)
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"computer runtime failed to start: {error}", file=sys.stderr)
        return 1
    finally:
        terminate_all()
        STATE_FILE.unlink(missing_ok=True)
        AUTHORITY.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
