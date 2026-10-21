#!/usr/bin/env python3
"""Add a private control-state mask without replacing stock Codex requirements."""

import sys
import tomllib
from pathlib import Path


TABLE = "[permissions.collective-personal.filesystem]"
MASKS = [
    '"/codex-home/computer-runtime-state" = "deny"',
    '"/codex-home/computer-runtime.sock" = "deny"',
    '"/tmp/.X11-unix" = "deny"',
    '"/tmp/collective-computer.Xauthority" = "deny"',
]
SIWC_SOCKET = "/codex-home/.collective-codex-siwc.sock"


def validate_siwc_requirements(text: str) -> None:
    try:
        config = tomllib.loads(text)
        # The trusted supervisor selects native ChatGPT or SIWC at runtime.
        # Validate the SIWC definition even when native mode is the default.
        provider_name = config.get("model_provider", "openai")
        provider = config.get("model_providers", {}).get("openai_chatgpt_plan", {})
        permissions = config.get("permissions", {}).get("filesystem", {})
        shell = config.get("shell_environment_policy", {})
        valid = (
            provider_name in ("openai", "openai_chatgpt_plan")
            and provider.get("env_key") == "ACCESS_TOKEN"
            and provider.get("base_url") == "https://api.openai.com/v1"
            and provider.get("wire_api") == "responses"
            and provider.get("requires_openai_auth") is False
            and shell.get("inherit") == "none"
            and shell.get("filters", {}).get("ACCESS_TOKEN") == "exclude"
            and SIWC_SOCKET in permissions.get("deny_read", [])
        )
    except (tomllib.TOMLDecodeError, AttributeError, TypeError):
        valid = False
    if not valid:
        raise SystemExit("stock Codex requirements lack unified SIWC protections; refusing to derive computer image")


def main(path: str) -> None:
    target = Path(path)
    text = target.read_text()
    validate_siwc_requirements(text)
    if text.count(TABLE) != 1 or '"/codex-home/auth.json"' not in text or '"/home/agent/workspace/.codex" = "deny"' not in text:
        raise SystemExit("unexpected stock Codex requirements; refusing to derive computer image")
    if any(mask in text for mask in MASKS):
        raise SystemExit("computer runtime masks are already present")
    start = text.index(TABLE) + len(TABLE)
    newline = text.find("\n", start)
    if newline < 0:
        raise SystemExit("malformed stock Codex requirements")
    text = text[:newline + 1] + "\n".join(MASKS) + "\n" + text[newline + 1:]
    target.write_text(text)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch-requirements.py requirements.toml")
    main(sys.argv[1])
