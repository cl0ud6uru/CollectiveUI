#!/usr/bin/env python3
"""Add a private control-state mask without replacing stock Codex requirements."""

import sys
from pathlib import Path


TABLE = "[permissions.collective-personal.filesystem]"
MASKS = [
    '"/codex-home/computer-runtime-state" = "deny"',
    '"/codex-home/computer-runtime.sock" = "deny"',
    '"/tmp/.X11-unix" = "deny"',
    '"/tmp/collective-computer.Xauthority" = "deny"',
]


def main(path: str) -> None:
    target = Path(path)
    text = target.read_text()
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
