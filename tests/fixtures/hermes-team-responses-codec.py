"""Actual pinned constructor/codec check. All sockets are forbidden; no model/auth use."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile

repo = Path.cwd()
source = Path(os.environ["HERMES_SOURCE"])
contract = json.loads((repo / "src/local-hermes/team-candidate-contract.json").read_text())
assert subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip() == contract["revision"]
assert not subprocess.check_output(["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"], text=True).strip()
for file, expected in contract["sourceHashes"].items():
    assert hashlib.sha256((source / file).read_bytes()).hexdigest() == expected, file

def forbidden(*_args, **_kwargs):
    raise AssertionError("Network is forbidden in this codec fixture")
socket.socket.connect = forbidden
socket.socket.connect_ex = forbidden
socket.create_connection = forbidden
os.environ.clear()
os.environ["PATH"] = "/usr/bin:/bin"
os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
sys.path.insert(0, str(source))
with tempfile.TemporaryDirectory(prefix="collective-responses-codec-") as home:
    os.environ["HERMES_HOME"] = home
    config = {"adapterId": sys.argv[1], "model": "synthetic-model", "runPurpose": "learning",
              "modelBaseUrls": {p: "https://fixture.invalid/" + p for p in ("reply", "learning", "utility", "subagent")},
              "modelTokens": {p: "a" * 64 for p in ("reply", "learning", "utility", "subagent")},
              "toolUrl": "https://fixture.invalid/mcp", "toolToken": "b" * 64,
              "learningSnapshot": {"version": 1, "messagesSnapshot": [{"role": "user", "content": "Synthetic procedure"}],
                                   "reviewMemory": True, "reviewSkills": True, "focus": None, "explicit": False,
                                   "memoryEnabled": True, "userProfileEnabled": True}}
    spec = importlib.util.spec_from_file_location("collective_candidate", repo / "src/local-hermes/team-candidate-native.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    TeamAgent = module.install_candidate_process(config, source, contract["sourceHashes"])
    parent = TeamAgent(model="forbidden-model", provider="anthropic", api_key="forbidden-key", quiet_mode=True,
                       cwd=home, max_iterations=1, skip_context_files=True)
    assert parent.api_mode == "codex_responses"
    assert type(parent._get_transport()).__name__ == "ResponsesApiTransport"
    assert parent.provider == "custom" and parent.base_url == config["modelBaseUrls"]["learning"]
    from agent import background_review
    from tools import delegate_tool
    review, _, _ = background_review.build_cache_parity_fork(parent, {}, max_iterations=1)
    child = delegate_tool._build_child_agent(0, "synthetic", "", ["memory"], None, 1, 1, parent)
    for agent, purpose in ((review, "learning"), (child, "subagent")):
        assert agent.api_mode == "codex_responses" and type(agent._get_transport()).__name__ == "ResponsesApiTransport"
        assert agent.provider == "custom" and agent.base_url == config["modelBaseUrls"][purpose]
    from hermes_cli import mcp_startup
    assert mcp_startup._has_configured_mcp_servers() is False
    print(json.dumps({"codec": "codex_responses", "authentication": "custom_server_gateway", "externalCalls": 0}))
