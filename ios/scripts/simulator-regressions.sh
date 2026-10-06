#!/usr/bin/env bash
# Runs fixture-only UI checks against a separate QA app installation.
# Usage: simulator-regressions.sh <CollectiveUI.app built as io.collectiveui.qa> <output-dir> [simulator-udid]
set -euo pipefail

APP_PATH="${1:?path to QA CollectiveUI.app}"
OUT_DIR="${2:?output directory}"
DEVICE_ID="${3:-}"
IOS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$APP_PATH/Info.plist")"
if [ "$BUNDLE_ID" != "io.collectiveui.qa" ]; then
  echo "Build the fixture test app with QA_APP_BUNDLE_IDENTIFIER=io.collectiveui.qa." >&2
  exit 1
fi

if [ -z "$DEVICE_ID" ]; then
  DEVICE_ID="$(xcrun simctl list devices available -j | python3 -c '
import json, re, sys
devices = json.load(sys.stdin)["devices"]
def version(runtime):
    return tuple(map(int, re.findall(r"\d+", runtime.split("iOS-")[-1])))
for runtime in sorted((r for r in devices if ".iOS-" in r), key=version, reverse=True):
    for device in devices[runtime]:
        if device.get("isAvailable", True) and device["name"].startswith("iPhone"):
            print(device["udid"])
            sys.exit(0)
sys.exit("No available iPhone simulator")
')"
fi

xcrun simctl boot "$DEVICE_ID" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$DEVICE_ID" -b
xcrun simctl install "$DEVICE_ID" "$APP_PATH"

# Restore the host preference even on a failing test. Never change the user's main app.
KEYBOARD_PREFERENCE="$(defaults read com.apple.iphonesimulator ConnectHardwareKeyboard 2>/dev/null || true)"
restore_keyboard() {
  if [ -z "$KEYBOARD_PREFERENCE" ]; then
    defaults delete com.apple.iphonesimulator ConnectHardwareKeyboard >/dev/null 2>&1 || true
  else
    defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool "$KEYBOARD_PREFERENCE"
  fi
}
trap restore_keyboard EXIT
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false

xcodebuild test \
  -project "$IOS_DIR/UITests/CollectiveUIRegression.xcodeproj" \
  -scheme CollectiveUIRegression \
  -destination "platform=iOS Simulator,id=$DEVICE_ID" \
  -parallel-testing-enabled NO \
  -derivedDataPath "$OUT_DIR/DerivedData" \
  -resultBundlePath "$OUT_DIR/Regression.xcresult" \
  CODE_SIGNING_ALLOWED=NO 2>&1 | tee "$OUT_DIR/regressions.log"
