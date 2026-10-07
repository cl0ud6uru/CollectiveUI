"""Exact pinned gateway launcher for synthetic lifecycle tests, never an image substitute.

The production bridge/bootstrap, gateway dispatcher, native conversation loop and
learning tools run unchanged. Only container filesystem metadata, a private process
namespace and explicitly permitted loopback transport are supplied by this fixture.
Every other socket connect fails before network I/O. No ambient auth environment is
inherited. The launcher never changes the pinned source checkout.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys


REPO = Path(__file__).resolve().parents[2]
SOURCE = Path(os.environ["HERMES_SOURCE"]).resolve()
CONTRACT = json.loads((REPO / "src/local-hermes/team-candidate-contract.json").read_text())
MODE, ROOT_TEXT, NAME, PORT_TEXT = sys.argv[1:5]
ROOT = Path(ROOT_TEXT).resolve(strict=True)
PORT = int(PORT_TEXT)
if not 1 <= PORT <= 65535 or not ROOT.name.startswith("native-volume-"):
    raise RuntimeError("Use a disposable synthetic fixture volume and server")


def verify_source():
    if subprocess.check_output(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], text=True).strip() != CONTRACT["revision"]:
        raise RuntimeError("Use the exact pinned Hermes source")
    if subprocess.check_output(["git", "-C", str(SOURCE), "status", "--porcelain", "--untracked-files=all"], text=True).strip():
        raise RuntimeError("Use the clean pinned Hermes source")
    for filename, expected in CONTRACT["sourceHashes"].items():
        if hashlib.sha256((SOURCE / filename).read_bytes()).hexdigest() != expected:
            raise RuntimeError("Pinned source changed: " + filename)


verify_source()
os.environ.clear()
os.environ.update(PATH="/usr/bin:/bin", HOME=str(ROOT / "home"), HERMES_HOME=str(ROOT),
                  HERMES_DISABLE_LAZY_INSTALLS="1", PYTHONDONTWRITEBYTECODE="1",
                  HERMES_TUI_GATEWAY_SHUTDOWN_GRACE_S="0.2")
sys.path.insert(0, str(SOURCE))
connect = socket.socket.connect
connect_ex = socket.socket.connect_ex


def allowed(address):
    return isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1") and address[1] == PORT


def loopback_connect(self, address):
    if not allowed(address):
        raise AssertionError("External network forbidden in native lifecycle fixture")
    return connect(self, address)


def loopback_connect_ex(self, address):
    if not allowed(address):
        raise AssertionError("External network forbidden in native lifecycle fixture")
    return connect_ex(self, address)


socket.socket.connect = loopback_connect
socket.socket.connect_ex = loopback_connect_ex
spec = importlib.util.spec_from_file_location("collective_active_bridge", REPO / "src/docker-hermes/bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
bridge.ROOT = ROOT
bridge.SOURCE = SOURCE
# Source identity is verified above against real Git and every manifest hash. The
# official image's /opt/hermes/.hermes_build_sha marker does not exist in a checkout.
bridge.check_source = verify_source
sys.path.insert(0, str(SOURCE))
os.environ.update(HERMES_HOME=str(ROOT), HOME=str(ROOT / "home"))

if MODE in ("initialize", "prepare"):
    for filename, content in (("SOUL.md", "Synthetic personal root"), ("config.yaml", "{}\n")):
        if not (ROOT / filename).exists():
            (ROOT / filename).write_text(content)
    if MODE == "initialize":
        for folder in ("workspace", "home"):
            (ROOT / folder).mkdir(exist_ok=True, mode=0o700)
    print(json.dumps(bridge.create_team(NAME) if MODE == "prepare" else bridge.profiles()))
elif MODE == "profiles":
    print(json.dumps(bridge.profiles()))
elif MODE == "resources":
    print(json.dumps(bridge.resources(NAME, sys.argv[5])))
elif MODE in ("private-learning", "correct-team", "revise-working"):
    parts, identity = bridge.profile(NAME)
    if identity != sys.argv[5]:
        raise RuntimeError("Synthetic private native identity changed")
    home = ROOT.joinpath(*parts)
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools import skill_manager_tool, memory_tool
    token = set_hermes_home_override(home)
    try:
        if MODE == "private-learning":
            skill = "---\nname: private-notes\ndescription: Private member procedure.\n---\n\nPreserve my independently learned procedure.\n"
            created = json.loads(skill_manager_tool.skill_manage("create", "private-notes", content=skill))
            store = memory_tool.MemoryStore()
            store.load_from_disk()
            remembered = json.loads(memory_tool.memory_tool("add", content="Private member memory must survive Team updates.", store=store))
            if not created.get("success") or not remembered.get("success"):
                raise RuntimeError("Native private learning refused")
            print(json.dumps({"learned": True}))
        else:
            revised = "record my private correction" if MODE == "correct-team" else "record the approved team decision"
            result = json.loads(skill_manager_tool.skill_manage("patch", "learned-procedure",
                                old_string="record the reviewed decision", new_string=revised))
            if not result.get("success"):
                raise RuntimeError("Native skill improvement refused")
            print(json.dumps({"improved": True}))
    finally:
        reset_hermes_home_override(token)
elif MODE in ("gateway", "personal-gateway"):
    # The cloud host's /proc is outside this owned test namespace. Existing bridge
    # collision fixtures cover permitted/denied PID records; the real profile inode
    # lifetime lock still rejects two gateways for this same profile here.
    private_proc = ROOT / "fixture-proc"
    private_proc.mkdir(exist_ok=True)
    real_path = bridge.Path
    bridge.Path = lambda value: private_proc if value == "/proc" else real_path(value)
    install = bridge.install_candidate_bootstrap
    bridge.install_candidate_bootstrap = lambda payload: install(payload, allow_synthetic_loopback=True)
    sys.argv = [str(REPO / "src/docker-hermes/bridge.py"), "gateway-candidate" if MODE == "gateway" else "gateway", NAME, sys.argv[5]]
    bridge.main()
else:
    raise RuntimeError("Unsupported fixture operation")
