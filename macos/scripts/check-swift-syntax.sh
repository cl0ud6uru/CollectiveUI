#!/usr/bin/env bash
# Parser-only checks for active Apple target branches. No Apple SDK or type checking.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mapfile -t SOURCES < <(python3 - "$ROOT" <<'PY'
from pathlib import Path
import re
import sys
root = Path(sys.argv[1])
text = (root / 'macos/CollectiveUI.xcodeproj/project.pbxproj').read_text()
for path in re.findall(r'lastKnownFileType = sourcecode.swift; path = "([^"]+)"', text):
    print((Path('macos') / path).as_posix())
PY
)
for TARGET in x86_64-apple-macosx14.0 arm64-apple-ios27.0; do
    if [[ "$TARGET" == *ios* ]]; then
        mapfile -t TARGET_SOURCES < <(python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
for base in ['ios/CollectiveUI', 'ios/CollectiveUITests']:
    for file in sorted((root / base).rglob('*.swift')):
        print(file.relative_to(root))
PY
)
    else
        TARGET_SOURCES=("${SOURCES[@]}")
    fi
    for CONFIGURATION in Debug Release; do
        FLAGS=()
        if [[ "$CONFIGURATION" == Debug ]]; then FLAGS=(-D DEBUG); fi
        if command -v swiftc >/dev/null; then
            (cd "$ROOT" && swiftc -frontend -parse -target "$TARGET" "${FLAGS[@]}" "${TARGET_SOURCES[@]}")
        else
            docker run --rm --network none -v "$ROOT:/repo:ro" -w /repo swift:6.0 \
                swiftc -frontend -parse -target "$TARGET" "${FLAGS[@]}" "${TARGET_SOURCES[@]}"
        fi
        echo "Swift syntax passed: $TARGET $CONFIGURATION (no SDK/type checking)"
    done
done
