#!/usr/bin/env bash
# Production portable files and their real XCTest suites, with no transport or crypto stubs.
# This deliberately excludes Apple-only URLSession streaming, CryptoKit, and app code.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/collectiveui-portable.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
python3 - "$ROOT" "$SCRATCH" <<'PY'
from pathlib import Path
import shutil
import sys
root, scratch = map(Path, sys.argv[1:])
sources = ['JSONValue', 'Models', 'MessagePart', 'UIMessageChunk', 'StreamReducer', 'SSEParser',
           'APIError', 'Markdown', 'IDs', 'MobileAuth', 'PetAppearance', 'LiveActivity', 'ComposerCommands',
           'ChatScrollPolicy', 'SettingsDestination']
tests = ['Decoding', 'StreamReducer', 'SSEParser', 'MarkdownParser', 'MobileAuth', 'PetAppearance',
         'LiveActivity', 'ComposerCommands', 'ChatScrollPolicy', 'SettingsDestination']
src = scratch / 'Sources/CollectiveKit'
dst = scratch / 'Tests/CollectiveKitTests'
src.mkdir(parents=True)
dst.mkdir(parents=True)
for name in sources:
    shutil.copyfile(root / f'ios/CollectiveKit/Sources/CollectiveKit/{name}.swift', src / f'{name}.swift')
for name in tests:
    shutil.copyfile(root / f'ios/CollectiveKit/Tests/CollectiveKitTests/{name}Tests.swift', dst / f'{name}Tests.swift')
(scratch / 'Package.swift').write_text('''// swift-tools-version: 5.10
import PackageDescription
let package = Package(name: "PortableCore", targets: [.target(name: "CollectiveKit"), .testTarget(name: "CollectiveKitTests", dependencies: ["CollectiveKit"])])
''')
PY
if command -v swift >/dev/null; then
    swift test --package-path "$SCRATCH"
else
    docker run --rm --network none --user "$(id -u):$(id -g)" -v "$SCRATCH:/package" -w /package swift:6.0 swift test
fi
