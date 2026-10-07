"""Execute real, pinned upstream registry/catalog/skill routing with isolated dependencies.

Usage: python tests/fixtures/remote-hermes-command-contract.py SOURCE REVISION
No gateway, provider, tools, credentials or profile is started. JSON is a reproducible wire fixture.
"""
import ast
import contextlib
import dataclasses
import hashlib
import json
import subprocess
import sys
import types

source, revision = sys.argv[1:]
assert revision in {"f97608f178d1ffeca59860195ab7da295f7c8e5f", "6fa88c19ac1dedbecd9809873b8c2cbea9ae0522"}
paths = ["hermes_cli/commands.py", "tui_gateway/methods_tools.py", "tui_gateway/server.py", "tui_gateway/methods_config_set.py"]
files = {p: subprocess.check_output(["git", "-C", source, "show", f"{revision}:{p}"], text=True) for p in paths}

def extract(path, names, ns, method=None):
    nodes = []
    for node in ast.parse(files[path]).body:
        targets = [node.target] if isinstance(node, ast.AnnAssign) else node.targets if isinstance(node, ast.Assign) else []
        if getattr(node, "name", None) in names or any(isinstance(t, ast.Name) and t.id in names for t in targets):
            nodes.append(node)
        elif method and isinstance(node, ast.FunctionDef) and any(isinstance(d, ast.Call) and d.args and isinstance(d.args[0], ast.Constant) and d.args[0].value == method for d in node.decorator_list):
            node.name = method.replace(".", "_")
            node.decorator_list = []
            nodes.append(node)
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), path, "exec"), ns)

registry = types.ModuleType("isolated_hermes_registry")
sys.modules[registry.__name__] = registry
registry.__dict__.update(dataclass=dataclasses.dataclass, t=lambda key, **kw: kw.get("description", key), INDICATOR_STYLES=("kaomoji", "emoji", "unicode", "ascii"))
extract(paths[0], {"CommandDef", "COMMAND_REGISTRY", "_localized", "_PROSE_HINTS", "infer_argument_mode", "command_desktop_meta", "_build_description"}, registry.__dict__)
ns = {"contextlib": contextlib, "_tools_mod": lambda name: registry, "_ok": lambda rid, result: {"jsonrpc": "2.0", "id": rid, "result": result},
      "_err": lambda rid, code, message: {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}}
extract(paths[2], {"_TUI_HIDDEN", "_TUI_EXTRA"}, ns)
extract(paths[1], {"_Catalog", "_catalog_registry"}, ns)
cat = ns["_Catalog"]()
ns["_catalog_registry"](cat)
catalog = {"pairs": cat.pairs, "sub": {f"/{c.name}": list(c.subcommands) for c in registry.COMMAND_REGISTRY if c.subcommands}, "canon": cat.canon,
           "commands": cat.commands, "categories": [{"name": k, "pairs": v} for k, v in cat.cat_map.items()], "skills": {}, "warning": ""}
# The real slash.exec pre-worker skill refusal contract. No worker is instantiated.
session = {"session_key": "synthetic-only"}
ns.update(_sess_nowait=lambda params, rid: (session, None), _live_slash_command_output=lambda *args: None,
          _WORKER_BLOCKED_COMMANDS=set(), _PENDING_INPUT_COMMANDS=set(), _bundle_key_for=lambda name: None,
          _session_home_scope=lambda session: contextlib.nullcontext(), _profile_skill_command=lambda session, name: True,
          _is_profile_skill_command=lambda session, name: True)
extract(paths[1], set(), ns, method="slash.exec")
refusal = ns["slash_exec"](1, {"session_id": "synthetic", "command": "fixture-skill task"})
assert refusal["error"]["code"] == 4018
skill_api = types.SimpleNamespace(get_skill_commands=lambda: {"/fixture-skill": {"name": "fixture-skill"}},
    get_interactive_skill_commands=lambda: {"/fixture-skill": {"name": "fixture-skill"}},
    split_stacked_skill_commands=lambda arg, **kw: ([], arg),
    build_skill_invocation_message=lambda key, arg, **kw: f"Synthetic skill instructions\n{arg}")
ns.update(_tools_mod=lambda name: skill_api, _skill_scaffold_projection=lambda message: "Synthetic skill loaded")
extract(paths[1], {"_dispatch_skill"}, ns)
dispatch = ns["_dispatch_skill"](2, {"session_id": "synthetic"}, session, "fixture-skill", "task")
assert dispatch["result"]["type"] == "skill"
# Execute the actual config dispatcher, stale-session guard and YOLO setter. Dependency boundaries
# are synthetic: no native process environment, profile configuration or tool is accessed.
enabled, writes = set(), []
approval = types.ModuleType("tools.approval")
approval.enable_session_yolo, approval.disable_session_yolo = enabled.add, enabled.discard
approval.is_session_yolo_enabled = lambda key: key in enabled
sys.modules["tools"] = types.ModuleType("tools")
sys.modules["tools.approval"] = approval
yns = {"os": types.SimpleNamespace(environ={}), "_BOOL_WORDS": {"on": True, "off": False}, "_ok": ns["_ok"], "_err": ns["_err"],
       "_cfgset_guarded": lambda fn: fn, "_write_config_key": lambda *args: writes.append(args), "_emit_session_info": lambda *args: None,
       "_sessions": {"live": {"session_key": "synthetic"}}, "_DISPLAY_TOGGLE_KEYS": set(), "logger": types.SimpleNamespace(warning=lambda *args: None),
       "_current_rpc_method": types.SimpleNamespace(get=lambda: "config.set")}
extract(paths[2], {"_sess_nowait", "DESKTOP_BACKEND_CONTRACT"}, yns)
extract(paths[3], {"_word", "_kv", "_set_yolo", "_SESSION_SCOPED_KEYS"}, yns, method="config.set")
yns["_CONFIG_SETTERS"] = {"yolo": yns["_set_yolo"]}
params = {"profile": "synthetic", "session_id": "live", "scope": "session", "key": "yolo", "value": "on"}
on = yns["config_set"](3, params)
assert on["result"] == {"key": "yolo", "value": "1", "scope": "session"} and enabled == {"synthetic"}
off = yns["config_set"](4, {**params, "value": "off"})
assert off["result"] == {"key": "yolo", "value": "0", "scope": "session"} and not enabled
stale = yns["config_set"](5, {**params, "session_id": "stale"})
assert stale["error"]["code"] == 4001 and not enabled and not writes and not yns["os"].environ
status = yns["config_set"](6, {**params, "value": "status"})
assert status["result"]["value"] == "1" and enabled == {"synthetic"}
yolo = {"desktop_contract": yns["DESKTOP_BACKEND_CONTRACT"], "on": on, "off": off, "stale": stale, "profile_writes": writes,
        "process_environment": yns["os"].environ, "status_mutates": True}
print(json.dumps({"revision": revision, "source_sha256": {p: hashlib.sha256(files[p].encode()).hexdigest() for p in paths},
                  "catalog": catalog, "skill_refusal": refusal, "skill_dispatch": dispatch, "yolo": yolo}, indent=2))
