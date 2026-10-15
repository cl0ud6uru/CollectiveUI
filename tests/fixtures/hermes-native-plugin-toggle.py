"""Exercise plugins.manage list/toggle through the pinned native RPC dispatcher.

This is an isolated temporary-profile conformance check. The only activation boundary is
stubbed; no gateway, external plugin, account, credential, or inference is involved.

HERMES_SOURCE=/path/to/pinned/hermes python tests/fixtures/hermes-native-plugin-toggle.py
"""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch


SOURCE = Path(os.environ["HERMES_SOURCE"])
COMMIT = "f97608f178d1ffeca59860195ab7da295f7c8e5f"
if subprocess.check_output(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], text=True).strip() != COMMIT:
    raise RuntimeError("Use the exact pinned Hermes source")


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="cui-native-plugin-toggle-") as temporary:
        root = Path(temporary)
        home = root / "home"
        launch_home = home / ".hermes"
        profile_home = launch_home / "profiles" / "fixture"
        plugin = profile_home / "plugins" / "obs" / "probe"
        plugin.mkdir(parents=True)
        home.mkdir(exist_ok=True)
        (launch_home / "profiles").mkdir(parents=True, exist_ok=True)
        (launch_home / "config.yaml").write_text("plugins:\n  enabled: []\n  disabled: []\n", encoding="utf-8")
        (profile_home / "config.yaml").write_text("plugins:\n  enabled: []\n  disabled: []\n", encoding="utf-8")
        (plugin / "plugin.yaml").write_text(
            "name: fixture-probe\nversion: '1.0'\ndescription: Synthetic fixture only\n",
            encoding="utf-8",
        )
        (plugin / "__init__.py").write_text("def register(ctx):\n    pass\n", encoding="utf-8")

        os.environ.update({
            "HOME": str(home),
            "HERMES_HOME": str(launch_home),
            "HERMES_DISABLE_LAZY_INSTALLS": "1",
        })
        sys.path.insert(0, str(SOURCE))

        # Avoid the server's optional startup version check while importing its real dispatcher.
        import hermes_cli.banner as banner
        banner.prefetch_update_check = lambda: None
        from tui_gateway import server
        import hermes_cli.profiles as profiles
        import hermes_cli.plugins_activation as activation
        import hermes_cli.plugins_cmd as plugins_cmd

        with patch.object(profiles, "get_profile_dir", lambda name: profile_home if name == "fixture" else None), \
             patch.object(activation, "activate_plugin_now", lambda key: {
                 "gateway_reloaded": False,
                 "restart_required": True,
                 "activation": {"name": key, "key": key},
             }):
            listed = server.handle_request({
                "id": "list",
                "method": "plugins.manage",
                "params": {"action": "list", "profile": "fixture"},
            })
            assert "result" in listed, listed
            rows = listed["result"]["plugins"]
            row = next(item for item in rows if item.get("key") == "obs/probe")
            assert row["name"] == "fixture-probe" and row["source"] == "user"

            enabled = server.handle_request({
                "id": "enable",
                "method": "plugins.manage",
                "params": {"action": "toggle", "profile": "fixture", "key": "obs/probe", "enable": True},
            })
            assert "result" in enabled, enabled
            result = enabled["result"]
            assert result["ok"] is True and result["name"] == "obs/probe", result
            assert result["plugin"]["key"] == "obs/probe"
            assert result["plugin"]["source"] == "user" and result["plugin"]["status"] == "enabled"
            assert result["gateway_reloaded"] is False and result["restart_required"] is True
            assert result["activation"] == {"name": "obs/probe", "key": "obs/probe"}

            disabled = server.handle_request({
                "id": "disable",
                "method": "plugins.manage",
                "params": {"action": "toggle", "profile": "fixture", "key": "obs/probe", "enable": False},
            })
            assert "result" in disabled, disabled
            result = disabled["result"]
            assert result["ok"] is True and result["name"] == "obs/probe", result
            assert result["plugin"]["source"] == "user" and result["plugin"]["status"] == "disabled"
            assert result["gateway_reloaded"] is False and result["restart_required"] is True

        # The exact pin's resolver matches either manifest name or canonical key
        # and returns the first discovery-order hit. Portal callers must reject
        # a requested user key that aliases another row's manifest name before
        # sending the mutating RPC.
        collision = [
            ("probe", "1.0", "bundled fixture", "bundled", None, "tools/probe"),
            ("probe", "1.0", "user fixture", "user", None, "probe"),
        ]
        with patch.object(plugins_cmd, "_discover_all_plugins", return_value=collision):
            assert plugins_cmd._resolve_plugin_key("probe") == "tools/probe"

        print("Pinned native plugins.manage list/toggle and ambiguous-key resolver conformance passed (synthetic profile).")


if __name__ == "__main__":
    main()
