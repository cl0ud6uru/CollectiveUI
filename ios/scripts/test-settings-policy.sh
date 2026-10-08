#!/usr/bin/env bash
# Execute the production Foundation-only settings policy on Linux without replacing
# Apple-only CryptoKit/URLSession APIs elsewhere in CollectiveKit with mocks.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRATCH="${TMPDIR:?Set TMPDIR to a scratch directory}/collectiveui-settings-policy"
mkdir -p "$SCRATCH/Sources/CollectiveKit" "$SCRATCH/Tests/CollectiveKitTests"
python3 - "$ROOT" "$SCRATCH" <<'PY'
from pathlib import Path
import sys
root, scratch = map(Path, sys.argv[1:])
(scratch / 'Package.swift').write_text('''// swift-tools-version: 5.10
import PackageDescription
let package = Package(name: "SettingsPolicy", targets: [.target(name: "CollectiveKit"), .testTarget(name: "CollectiveKitTests", dependencies: ["CollectiveKit"])])
''')
source = root / 'ios/CollectiveKit/Sources/CollectiveKit/SettingsDestination.swift'
(scratch / 'Sources/CollectiveKit/SettingsDestination.swift').write_text(source.read_text() if source.exists() else 'import Foundation\n')
(scratch / 'Tests/CollectiveKitTests/SettingsDestinationTests.swift').write_text((root / 'ios/CollectiveKit/Tests/CollectiveKitTests/SettingsDestinationTests.swift').read_text())
PY
docker run --rm -v "$SCRATCH:/package" -w /package swift:6.0 swift test
