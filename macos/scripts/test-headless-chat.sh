#!/usr/bin/env bash
# macOS background regressions: unmodified app/model sources, no app entry point or window activation.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/collectiveui-headless.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
python3 - "$ROOT" "$SCRATCH" <<'PY'
from pathlib import Path
import json
import shutil
import sys
root, scratch = map(Path, sys.argv[1:])
sources = [
    'ios/CollectiveUI/App/AppModel.swift',
    'ios/CollectiveUI/Auth/KeychainStore.swift', 'ios/CollectiveUI/Auth/WebAuthenticator.swift',
    'ios/CollectiveUI/Chat/ChatModel.swift', 'ios/CollectiveUI/Chat/ConversationState.swift',
    'ios/CollectiveUI/Chat/PendingChatSubmission.swift', 'ios/CollectiveUI/Support/PortalTheme.swift',
    'ios/CollectiveUI/Support/AvatarView.swift',
    *[f'ios/CollectiveUI/Demo/{name}.swift' for name in
      ['DemoMode', 'DemoServer', 'DemoFixtures', 'DemoURLProtocol', 'DemoPetArt']],
    'macos/CollectiveUI/Chat/DesktopCommandResultView.swift',
]
tests = [
    *[f'ios/CollectiveUITests/{name}Tests.swift' for name in
      ['SessionAndDraft', 'ChatLifecycle', 'ChatRecovery', 'Authentication']],
    'macos/CollectiveUITests/DesktopIsolationTests.swift',
    'macos/CollectiveUITests/DesktopCommandResultLayoutTests.swift',
]
for target, files in [('Sources/CollectiveUI', sources), ('Tests/HeadlessChatTests', tests)]:
    directory = scratch / target
    directory.mkdir(parents=True)
    for relative in files:
        shutil.copyfile(root / relative, directory / Path(relative).name)
package_path = json.dumps(str(root / 'ios/CollectiveKit'))
(scratch / 'Package.swift').write_text('''// swift-tools-version: 5.10
import PackageDescription
let package = Package(name: "HeadlessChat", platforms: [.macOS(.v14)],
    dependencies: [.package(path: ''' + package_path + ''')], targets: [
        .target(name: "CollectiveUI", dependencies: ["CollectiveKit"], swiftSettings: [.define("DEBUG")]),
        .testTarget(name: "HeadlessChatTests", dependencies: ["CollectiveUI", "CollectiveKit"])
    ])
''')
PY
export CLANG_MODULE_CACHE_PATH="$SCRATCH/module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$SCRATCH/module-cache"
swift test --package-path "$SCRATCH" --cache-path "$SCRATCH/cache" --scratch-path "$SCRATCH/build" -j 2 "$@"
