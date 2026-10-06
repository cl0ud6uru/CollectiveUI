"""Actual pinned native SDK clients -> local production handlers, with synthetic upstreams only."""
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
from types import SimpleNamespace

repo = Path(__file__).resolve().parents[2]
source = Path(os.environ["HERMES_SOURCE"])
manifest = json.loads((repo / "tests/fixtures/hermes-team-source-contract.json").read_text())
assert subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip() == manifest["revision"]
assert not subprocess.check_output(["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"], text=True).strip()
for file in ("agent/agent_runtime_helpers.py", "agent/process_bootstrap.py", "agent/auxiliary_client.py", "tools/mcp_tool.py", "tools/mcp_tool_transport.py"):
    assert hashlib.sha256((source / file).read_bytes()).hexdigest() == manifest["sourceHashes"][file], file
sys.path.insert(0, str(source))
os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
synthetic_home = tempfile.TemporaryDirectory(prefix="collective-candidate-native-")
os.environ["HERMES_HOME"] = synthetic_home.name
config = json.load(sys.stdin)
config["adapterId"] = "collective-openai-chat-v1"
connect = socket.socket.connect
def loopback_only(self, address):
    if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
        raise AssertionError("External network is forbidden in this fixture")
    return connect(self, address)
socket.socket.connect = loopback_only
spec = importlib.util.spec_from_file_location("collective_candidate", repo / "src/local-hermes/team-candidate-native.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
clients = module.CandidateNativeClients(config, allow_synthetic_loopback=True)
agent = SimpleNamespace(provider="custom", model=config["model"], api_mode="chat_completions", base_url=config["modelBaseUrls"]["reply"],
                        _client_log_context=lambda: "synthetic Team candidate", _build_keepalive_http_client=lambda *args, **kwargs: None)

async def native_mcp():
    from tools import mcp_tool as native
    native._ensure_mcp_sdk()
    task = native.MCPServerTask("collective_candidate")
    task._http_rejection = {}
    cfg = clients.mcp_configuration()
    transport = task._streamable_http_transport(cfg["url"], cfg["headers"], 5, True, None, None, True, {"authorization"})
    async with transport as streams:
        async with native.ClientSession(streams[0], streams[1]) as session:
            await session.initialize()
            listed = await session.list_tools()
            assert len(listed.tools) == 1
            result = await session.call_tool(listed.tools[0].name, {"resourceId": "document-a"})
            assert result.content[0].text == "synthetic document"
# The full pinned construction functions now consume the same in-memory run context.
try:
    module.install_candidate_process(config, source, {})
except RuntimeError:
    pass
else:
    raise AssertionError("Changed source evidence was accepted")
# Consume the same fixed bundle through the production bridge bootstrap entry.
bridge_spec = importlib.util.spec_from_file_location("collective_bridge", repo / "src/docker-hermes/bridge.py")
bridge = importlib.util.module_from_spec(bridge_spec)
bridge_spec.loader.exec_module(bridge)
bridge.SOURCE = source
os.environ["HERMES_HOME"] = synthetic_home.name
config["expiresAt"] = 4102444800000
code = (repo / "src/local-hermes/team-candidate-native.py").read_text()
payload = {"config": config, "code": code, "codeHash": hashlib.sha256(code.encode()).hexdigest(), "contract": manifest}
try:
    bridge.install_candidate_bootstrap({**payload, "codeHash": "0" * 64})
except ValueError:
    pass
else:
    raise AssertionError("Tampered broker bootstrap was accepted")
TeamAgent = bridge.install_candidate_bootstrap(payload, allow_synthetic_loopback=True)
from tools import mcp_tool_config
assert mcp_tool_config._load_mcp_config() == {"collective_team": clients.mcp_configuration()}
asyncio.run(native_mcp())
parent = TeamAgent(model="forbidden-model", provider="anthropic", api_key="forbidden-provider-token",
                   base_url="https://forbidden.test.invalid", enabled_toolsets=["memory", "skills"], quiet_mode=True,
                   cwd=synthetic_home.name, max_iterations=1, skip_context_files=True)
assert parent.model == config["model"] and parent._collective_team_purpose == "reply"
assert parent.enabled_toolsets == ["memory", "skills", "delegation", "mcp-collective_team"]
assert "terminal" not in parent.valid_tool_names and "manage_connections" not in parent.valid_tool_names
from agent import background_review, auxiliary_client
from tools import delegate_tool
review, _, _ = background_review.build_cache_parity_fork(parent, {}, max_iterations=1)
assert review._collective_team_purpose == "learning"
child = delegate_tool._build_child_agent(0, "synthetic task", "", ["memory"], None, 1, 1, parent)
assert child._collective_team_purpose == "subagent"
for purpose, native_agent in (("reply", parent), ("learning", review), ("subagent", child)):
    # Actual pinned constructors use this client. Streaming and identical legitimate
    # calls get fresh trusted nonces; unresolved receipts fence outer-loop retries.
    for _ in range(2):
        result = native_agent.client.chat.completions.create(model=config["model"], messages=[{"role": "user", "content": "hook " + purpose}], max_tokens=16, stream=True, stream_options={"include_usage": True})
        text = "".join(chunk.choices[0].delta.content or "" for chunk in result if chunk.choices)
        assert text == "safe reply"
    native_agent.client.close()
utility, model = auxiliary_client.resolve_provider_client(provider="anthropic", model="forbidden-model", explicit_api_key="forbidden-provider-token")
assert model == config["model"]
for _ in range(2):
    stream = utility.chat.completions.create(model=model, messages=[{"role": "user", "content": "hook utility"}], max_tokens=16, stream=True, stream_options={"include_usage": True})
    assert "".join(chunk.choices[0].delta.content or "" for chunk in stream if chunk.choices) == "safe reply"
utility.close()
try:
    TeamAgent("unsupported positional input")
except RuntimeError:
    pass
else:
    raise AssertionError("Unsupported construction fell back to a standard agent")
print(json.dumps({"nativePrimary": 2, "nativeAuxiliary": 2, "nativeMcp": 1, "nativeConstructionHooks": 4, "externalCalls": 0}))
synthetic_home.cleanup()
