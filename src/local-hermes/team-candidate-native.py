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

PURPOSES = ("reply", "learning", "utility", "subagent")


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
                "tools/mcp_tool_config.py", "tools/mcp_tool.py", "tools/mcp_tool_transport.py", "hermes_cli/config.py")
    source = Path(source)
    if not expected_sources or any(file not in expected_sources or hashlib.sha256((source / file).read_bytes()).hexdigest() != expected_sources[file] for file in required):
        raise RuntimeError("Native Team construction hooks do not match the pinned source")
    clients = CandidateNativeClients(config, allow_synthetic_loopback=allow_synthetic_loopback)
    import run_agent
    from agent import auxiliary_client, background_review
    from tools import delegate_tool, delegate_tool_config, mcp_tool_config
    from hermes_cli import runtime_provider, config as native_config
    if getattr(run_agent.AIAgent, "_collective_team_candidate", False):
        raise RuntimeError("A native Team context is already installed in this process")
    purpose_context = ContextVar("collective_native_purpose", default="reply")
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
                          enabled_toolsets=["memory", "skills", "delegation", "mcp-collective_team"], disabled_toolsets=None)
            # Failure escapes construction. No standard agent or credential-pool fallback is attempted.
            super().__init__(**kwargs)

        def _create_openai_client(self, client_kwargs, *, reason, shared):
            return clients.primary(self, self._collective_team_purpose)

        def switch_model(self, *args, **kwargs):
            raise RuntimeError("Native Team model changes require a new server-owned context")

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
        value.update(mcp_servers={"collective_team": clients.mcp_configuration()}, fallback_providers=[], fallback_model=None)
        return value
    native_config.load_config = team_config
    # The MCP module's config accessor is dynamic in the pin. Force its sole connection
    # directly as well, so cached CLI config cannot expose a personal/company server list.
    if not hasattr(mcp_tool_config, "_load_mcp_config"):
        raise RuntimeError("Unsupported native MCP configuration hook")
    mcp_tool_config._load_mcp_config = lambda: {"collective_team": clients.mcp_configuration()}
    return TeamAgent
