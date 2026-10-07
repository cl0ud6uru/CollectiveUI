"""Unregistered native adapter candidate, for the exact pinned OpenAI/MCP client contracts.

Only trusted startup supplies this in-memory configuration. Installing this candidate
does not remove CollectiveUI's Team chat/model admission gates. It does not discover
credentials, mutate native config files, or turn on a provider fallback.
"""
from urllib.parse import urlsplit
from contextvars import ContextVar
from functools import wraps
from pathlib import Path
import hashlib
import uuid
import json
import math
import re

PURPOSES = ("reply", "learning", "utility", "subagent")


def bounded_learning_snapshot(value):
    keys = {"version", "messagesSnapshot", "reviewMemory", "reviewSkills", "focus", "explicit", "memoryEnabled", "userProfileEnabled"}
    if not isinstance(value, dict) or set(value) != keys or type(value["version"]) is not int or value["version"] != 1:
        raise ValueError("Invalid native learning snapshot")
    if not isinstance(value["messagesSnapshot"], list) or not 1 <= len(value["messagesSnapshot"]) <= 256 or not all(isinstance(v, dict) for v in value["messagesSnapshot"]):
        raise ValueError("Invalid native learning history")
    if any(type(value[k]) is not bool for k in keys - {"version", "messagesSnapshot", "focus"}) or not (value["reviewMemory"] or value["reviewSkills"]):
        raise ValueError("Invalid native learning scope")
    if value["focus"] is not None and (not isinstance(value["focus"], str) or len(value["focus"].encode("utf-16-le")) // 2 > 2000):
        raise ValueError("Invalid native learning focus")
    nodes = 0
    def check(item, depth=0):
        nonlocal nodes
        nodes += 1
        if depth > 20 or nodes > 10000:
            raise ValueError("Oversized native learning structure")
        if isinstance(item, dict):
            if not all(isinstance(k, str) for k in item):
                raise ValueError("Invalid native learning keys")
            for child in item.values():
                check(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                check(child, depth + 1)
        elif item is not None and type(item) not in (str, bool, int, float):
            raise ValueError("Invalid native learning JSON")
        elif isinstance(item, float) and not math.isfinite(item):
            raise ValueError("Invalid native learning number")
    check(value)
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(encoded) > 64000:
        raise ValueError("Oversized native learning snapshot")
    return json.loads(encoded)


class CandidateNativeClients:
    def __init__(self, config, *, allow_synthetic_loopback=False):
        self._config = config
        for purpose in PURPOSES:
            self._check_url(config["modelBaseUrls"][purpose], allow_synthetic_loopback)
        self._check_url(config["toolUrl"], allow_synthetic_loopback)
        self.model = config["model"]

    @staticmethod
    def _check_url(value, synthetic):
        url = urlsplit(value)
        loopback = synthetic and url.scheme == "http" and url.hostname == "127.0.0.1"
        if (url.scheme != "https" and not loopback) or url.username or url.password or url.query or url.fragment:
            raise ValueError("A fixed Team gateway URL is required")

    def primary(self, agent, purpose):
        if purpose not in PURPOSES:
            raise ValueError("Unknown native Team model purpose")
        import httpx
        from agent.agent_runtime_helpers import create_openai_client
        # Explicit transport excludes environment proxy credentials and SDK retry duplication.
        return create_openai_client(agent, {
            "api_key": self._config["modelTokens"][purpose],
            "base_url": self._config["modelBaseUrls"][purpose],
            "max_retries": 0,
            "timeout": 45,
            "http_client": httpx.Client(trust_env=False, follow_redirects=False,
                                        event_hooks={"request": [lambda request: request.headers.__setitem__("x-collective-request-id", str(uuid.uuid4()))]}),
        }, reason="collective_team_candidate", shared=False)

    def auxiliary(self, purpose="utility"):
        if purpose not in ("utility", "learning"):
            raise ValueError("Invalid auxiliary Team purpose")
        import httpx
        from agent.auxiliary_client import _create_openai_client
        return _create_openai_client(
            api_key=self._config["modelTokens"][purpose],
            base_url=self._config["modelBaseUrls"][purpose],
            max_retries=0, timeout=45,
            http_client=httpx.Client(trust_env=False, follow_redirects=False,
                                     event_hooks={"request": [lambda request: request.headers.__setitem__("x-collective-request-id", str(uuid.uuid4()))]}),
        )

    def mcp_configuration(self):
        return {"url": self._config["toolUrl"], "headers": {"Authorization": "Bearer " + self._config["toolToken"]},
                "transport": "http", "strict_redirect_headers": True, "connect_timeout": 5}


def install_candidate_process(config, source, expected_sources, *, allow_synthetic_loopback=False):
    """Pin-specific trusted bootstrap, installed once in a dedicated Team gateway process.

    ProviderProfile.create_client cannot enforce this boundary: the pin swallows
    plugin exceptions and continues through its standard provider fallback. These
    construction seams therefore guard the whole Team process before gateway import.
    """
    required = ("run_agent.py", "agent/agent_runtime_helpers.py", "agent/agent_init.py", "agent/auxiliary_client.py",
                "agent/background_review.py", "tools/delegate_tool.py", "tools/delegate_tool_config.py", "hermes_cli/runtime_provider.py",
                "tools/mcp_tool_config.py", "tools/mcp_tool.py", "tools/mcp_tool_transport.py", "hermes_cli/config.py", "hermes_cli/mcp_startup.py",
                "tui_gateway/server.py", "tui_gateway/rpc_dispatch.py", "tui_gateway/method_ctx.py", "hermes_cli/backend_retirement.py", "agent/conversation_loop.py")
    source = Path(source)
    if not expected_sources or any(file not in expected_sources or hashlib.sha256((source / file).read_bytes()).hexdigest() != expected_sources[file] for file in required):
        raise RuntimeError("Native Team construction hooks do not match the pinned source")
    clients = CandidateNativeClients(config, allow_synthetic_loopback=allow_synthetic_loopback)
    import run_agent
    from agent import auxiliary_client, background_review
    from tools import delegate_tool, delegate_tool_config, mcp_tool_config
    from hermes_cli import runtime_provider, config as native_config, mcp_startup
    if getattr(run_agent.AIAgent, "_collective_team_candidate", False):
        raise RuntimeError("A native Team context is already installed in this process")
    learning = config.get("runPurpose", "chat") == "learning"
    snapshot = bounded_learning_snapshot(config.get("learningSnapshot")) if learning else None
    if learning and (config.get("learningToken") or config.get("learningUrl")):
        raise RuntimeError("Native learning children cannot capture recursive work")
    if config.get("learningUrl"):
        clients._check_url(config["learningUrl"], allow_synthetic_loopback)
        if not re.fullmatch(r"[a-f0-9]{64}", config.get("learningToken", "")):
            raise RuntimeError("Invalid learning capture grant")
    purpose_context = ContextVar("collective_native_purpose", default="learning" if learning else "reply")
    original_agent = run_agent.AIAgent
    api_mode = "chat_completions" if config["adapterId"] == "collective-openai-chat-v1" else "responses"

    def runtime(purpose):
        return {"provider": "custom", "model": clients.model, "api_key": config["modelTokens"][purpose],
                "base_url": config["modelBaseUrls"][purpose], "api_mode": api_mode, "credential_pool": None}

    class TeamAgent(original_agent):
        _collective_team_candidate = True

        def __init__(self, *args, **kwargs):
            if args:
                raise RuntimeError("Unsupported positional native Team construction")
            self._collective_team_purpose = purpose_context.get()
            kwargs.update(runtime(self._collective_team_purpose))
            kwargs.update(fallback_model=[], max_tokens=256, request_overrides={},
                          enabled_toolsets=["memory", "skills"] if learning else ["memory", "skills", "delegation", "mcp-collective_team"], disabled_toolsets=None)
            # Failure escapes construction. No standard agent or credential-pool fallback is attempted.
            super().__init__(**kwargs)

        def _create_openai_client(self, client_kwargs, *, reason, shared):
            return clients.primary(self, self._collective_team_purpose)

        def switch_model(self, *args, **kwargs):
            raise RuntimeError("Native Team model changes require a new server-owned context")

        def run_conversation(self, *args, **kwargs):
            result = super().run_conversation(*args, **kwargs)
            if self._collective_team_purpose == "learning" and (not isinstance(result, dict) or result.get("completed") is not True or result.get("failed") or result.get("partial") or result.get("error")):
                raise RuntimeError("Native Team learning did not complete")
            return result

        def _emit_auxiliary_failure(self, task, exc):
            # Never return raw native errors, which may contain credentials or private history.
            self._collective_learning_failed = True

        def _spawn_background_review_now(self, messages_snapshot, review_memory=False, review_skills=False, focus=None, task_cfg=None, _requeue_attempts=0, explicit=False):
            if learning or self._collective_team_purpose != "reply":
                return
            if not config.get("learningUrl") or not config.get("learningToken"):
                raise RuntimeError("Native Team learning requires a durable handoff")
            captured = bounded_learning_snapshot({"version": 1, "messagesSnapshot": messages_snapshot,
                "reviewMemory": review_memory, "reviewSkills": review_skills, "focus": focus, "explicit": explicit,
                "memoryEnabled": bool(self._memory_enabled), "userProfileEnabled": bool(self._user_profile_enabled)})
            import httpx
            # Exactly one dispatch. An uncertain acknowledgement is not retried or run locally.
            with httpx.Client(trust_env=False, follow_redirects=False, timeout=10) as capture:
                response = capture.post(config["learningUrl"], headers={"Authorization": "Bearer " + config["learningToken"]},
                                        json={"reviewId": str(uuid.uuid4()), "snapshot": captured})
                if response.status_code not in (200, 201, 202) or len(response.content) > 4096:
                    raise RuntimeError("Native learning handoff was not acknowledged")
                ack = response.json()
                if not isinstance(ack, dict) or ack.get("captured") is not True:
                    raise RuntimeError("Native learning handoff was not retained")

        @staticmethod
        def _collective_install_learning_rpc(server):
            if not learning:
                return
            claimed = False
            import threading
            claim_lock = threading.Lock()
            def review(rid, params):
                nonlocal claimed
                if not isinstance(params, dict) or set(params) != {"session_id"} or not isinstance(params["session_id"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", params["session_id"]):
                    return server._err(rid, 4000, "Invalid native learning session")
                with claim_lock:
                    if claimed:
                        return server._err(rid, 4090, "Native learning was already admitted")
                    claimed = True
                session = server._sessions.get(params["session_id"])
                if not isinstance(session, dict) or server._wait_agent(session, rid, timeout=30):
                    return server._err(rid, 4090, "Native learning parent unavailable")
                agent = session.get("agent")
                if not isinstance(agent, TeamAgent) or session.get("running") or session.get("_closing"):
                    return server._err(rid, 4090, "Native learning parent not idle")
                agent._memory_enabled = snapshot["memoryEnabled"]
                agent._user_profile_enabled = snapshot["userProfileEnabled"]
                agent._collective_learning_failed = False
                review_run = background_review.prepare_background_review_run(agent)
                if review_run is None:
                    return server._err(rid, 4090, "Native learning parent has unfinished review")
                try:
                    target, _ = background_review.spawn_background_review_thread(agent, snapshot["messagesSnapshot"],
                        review_memory=snapshot["reviewMemory"], review_skills=snapshot["reviewSkills"], focus=snapshot["focus"],
                        explicit=snapshot["explicit"], task_cfg={"max_input_tokens":16000}, review_run=review_run)
                    target()
                    completed = review_run.request_done.is_set() and not review_run.cancel_requested.is_set() and not agent._collective_learning_failed
                    return server._ok(rid, {"finished": bool(completed)})
                except Exception:
                    return server._err(rid, 4090, "Native learning did not confirm completion")
                finally:
                    background_review.finish_background_review_run(agent, review_run)
            if "collective.learning.run" in server._methods:
                raise RuntimeError("Native learning extension already installed")
            server._methods["collective.learning.run"] = review
            server._LONG_HANDLERS = server._LONG_HANDLERS | {"collective.learning.run"}

    def under(purpose, function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            token = purpose_context.set(purpose)
            try:
                return function(*args, **kwargs)
            finally:
                purpose_context.reset(token)
        return wrapped

    # Child construction is synchronous before workers start; the immutable agent field
    # then retains the correct actor/purpose even when the worker does not inherit ContextVars.
    background_review.build_cache_parity_fork = under("learning", background_review.build_cache_parity_fork)
    delegate_tool._build_child_agent = under("subagent", delegate_tool._build_child_agent)
    delegate_tool_config._resolve_child_runtime = lambda *args, **kwargs: runtime("subagent")
    delegate_tool._resolve_child_runtime = delegate_tool_config._resolve_child_runtime
    background_review._resolve_review_runtime = lambda *args, **kwargs: {**runtime("learning"), "routed": True}
    runtime_provider.resolve_runtime_provider = lambda *args, **kwargs: runtime(purpose_context.get())
    auxiliary_client.resolve_provider_client = lambda *args, **kwargs: (clients.auxiliary("utility"), clients.model)
    run_agent.AIAgent = TeamAgent
    # Existing aliases can exist when a controller imports gateway helpers before installing the shim.
    import sys
    for name in ("tui_gateway.server", "tui_gateway.methods_prompt"):
        module = sys.modules.get(name)
        if module is not None and getattr(module, "AIAgent", None) is original_agent:
            module.AIAgent = TeamAgent
    load_config = native_config.load_config
    @wraps(load_config)
    def team_config(*args, **kwargs):
        value = dict(load_config(*args, **kwargs))
        value.update(mcp_servers={} if learning else {"collective_team": clients.mcp_configuration()}, fallback_providers=[], fallback_model=None)
        return value
    native_config.load_config = team_config
    # The MCP module's config accessor is dynamic in the pin. Force its sole connection
    # directly as well, so cached CLI config cannot expose a personal/company server list.
    if not hasattr(mcp_tool_config, "_load_mcp_config"):
        raise RuntimeError("Unsupported native MCP configuration hook")
    mcp_tool_config._load_mcp_config = lambda: {} if learning else {"collective_team": clients.mcp_configuration()}
    # The pin probes raw on-disk config before starting discovery. Blank Team profiles
    # deliberately have no MCP settings there. Override only this presence gate;
    # native discovery/registration still consumes the fixed accessor above. Never
    # inject the opaque tool grant into read_raw_config(), whose callers may save it.
    if not hasattr(mcp_startup, "_has_configured_mcp_servers"):
        raise RuntimeError("Unsupported native MCP discovery hook")
    mcp_startup._has_configured_mcp_servers = lambda: not learning
    return TeamAgent
