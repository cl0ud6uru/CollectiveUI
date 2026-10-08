#!/usr/bin/env bash
# Captures demo-mode screenshots and a short video of CollectiveUI in the iOS Simulator.
#
# Usage: ios/scripts/simulator-screenshots.sh <path/to/CollectiveUI.app> <output-dir>
#
# The app must be a Debug simulator build: demo mode (--demo) only exists in Debug.
set -euo pipefail

APP_PATH="${1:?path to CollectiveUI.app}"
OUT_DIR="${2:?output directory}"
BUNDLE_ID="io.collectiveui.app"
mkdir -p "$OUT_DIR"

log() { echo "==> $*"; }

# Prints the UDID of an available device: the preferred name if present, otherwise the first
# device whose name starts with the given prefix, newest iOS runtime first.
pick_device() {
  local preferred="$1" prefix="$2"
  xcrun simctl list devices available -j | python3 -c '
import json, re, sys
preferred, prefix = sys.argv[1], sys.argv[2]
data = json.load(sys.stdin)["devices"]
def version(runtime):
    match = re.search(r"iOS-(\d+)-(\d+)(?:-(\d+))?", runtime)
    return tuple(int(x or 0) for x in match.groups()) if match else (0, 0, 0)
runtimes = sorted((r for r in data if ".iOS-" in r), key=version, reverse=True)
devices = [d for r in runtimes for d in data[r] if d.get("isAvailable", True)]
for d in devices:
    if d["name"] == preferred:
        print(d["udid"]); sys.exit(0)
for d in devices:
    if d["name"].startswith(prefix):
        print(d["udid"]); sys.exit(0)
sys.exit(1)
' "$preferred" "$prefix"
}

prepare_device() {
  local udid="$1"
  xcrun simctl boot "$udid" >/dev/null 2>&1 || true
  xcrun simctl bootstatus "$udid" -b
  xcrun simctl status_bar "$udid" override --time 9:41 --batteryState charged --batteryLevel 100 \
    --cellularMode active --cellularBars 4 --wifiBars 3 || true
  xcrun simctl install "$udid" "$APP_PATH"
  # Warm-up launch so the first real scenario isn't slowed by a cold start.
  xcrun simctl launch "$udid" "$BUNDLE_ID" --demo >/dev/null 2>&1 || true
  sleep 6
  xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
}

# shot <udid> <light|dark> <name> <seconds> [launch args...]
shot() {
  local udid="$1" appearance="$2" name="$3" wait_seconds="$4"
  shift 4
  log "$name"
  xcrun simctl terminate "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
  xcrun simctl ui "$udid" appearance "$appearance" || true
  sleep 1
  xcrun simctl launch "$udid" "$BUNDLE_ID" --demo --demo-appearance "$appearance" "$@" >/dev/null || return 1
  sleep "$wait_seconds"
  xcrun simctl io "$udid" screenshot "$OUT_DIR/$name.png" >/dev/null || return 1
  test -s "$OUT_DIR/$name.png" || return 1
}

run() {
  "$@" || { echo "::error::Scenario failed: $*"; exit 1; }
}

IPHONE="$(pick_device "iPhone 16 Pro" "iPhone" || true)"
IPAD="$(pick_device "iPad Pro 13-inch (M4)" "iPad" || true)"
log "iPhone: ${IPHONE:-none}  iPad: ${IPAD:-none}"

if [ -n "$IPHONE" ]; then
  prepare_device "$IPHONE"

  run shot "$IPHONE" light iphone-01-home 6
  run shot "$IPHONE" light iphone-02-research-chat 7 --demo-open demo-research
  run shot "$IPHONE" light iphone-03-approval 7 --demo-open demo-approval
  run shot "$IPHONE" light iphone-04-image-chat 8 --demo-open demo-image
  run shot "$IPHONE" light iphone-05-new-chat 6 --demo-screen newchat
  run shot "$IPHONE" light iphone-06-inbox 6 --demo-screen inbox
  run shot "$IPHONE" light iphone-07-settings 6 --demo-screen settings
  run shot "$IPHONE" light iphone-12-welcome 6 --demo-screen welcome
  run shot "$IPHONE" light iphone-13-admin-settings 6 --demo-screen settings --demo-settings-section admin
  run shot "$IPHONE" light iphone-14-member-settings 6 --demo-screen settings --demo-role member
  run shot "$IPHONE" light iphone-08-search 7 --demo-screen search
  run shot "$IPHONE" light iphone-09-sign-in 5 --demo-screen signin
  run shot "$IPHONE" light iphone-10-setup 5 --demo-screen setup
  run shot "$IPHONE" dark iphone-dark-01-home 6
  run shot "$IPHONE" dark iphone-dark-02-research-chat 7 --demo-open demo-research

  log "video"
  xcrun simctl terminate "$IPHONE" "$BUNDLE_ID" >/dev/null 2>&1 || true
  xcrun simctl ui "$IPHONE" appearance light || true
  xcrun simctl io "$IPHONE" recordVideo --codec=h264 --force "$OUT_DIR/demo-streaming.mp4" &
  RECORDER=$!
  sleep 2
  xcrun simctl launch "$IPHONE" "$BUNDLE_ID" --demo --demo-appearance light --demo-open home-bot-atlas \
    --demo-send "How do I enable the iOS app on our server?" >/dev/null || echo "::warning::Video launch failed"
  sleep 16
  xcrun simctl io "$IPHONE" screenshot "$OUT_DIR/iphone-11-streamed-reply.png" >/dev/null || true
  kill -INT "$RECORDER" 2>/dev/null || true
  wait "$RECORDER" 2>/dev/null || true
else
  echo "::error::No iPhone simulator available"; exit 1
fi

if [ -n "$IPAD" ]; then
  prepare_device "$IPAD"
  run shot "$IPAD" light ipad-01-research-chat 8 --demo-open demo-research
  run shot "$IPAD" dark ipad-dark-01-research-chat 8 --demo-open demo-research
  run shot "$IPAD" light ipad-02-image-chat 8 --demo-open demo-image
  run shot "$IPAD" light ipad-03-welcome 6 --demo-screen welcome
  run shot "$IPAD" dark ipad-04-admin-settings 6 --demo-screen settings --demo-settings-section admin
else
  echo "::error::No iPad simulator available"; exit 1
fi

for udid in "$IPHONE" "$IPAD"; do
  if [ -n "$udid" ]; then
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  fi
done

ls -la "$OUT_DIR"
count=$(find "$OUT_DIR" -name '*.png' | wc -l | tr -d ' ')
log "$count screenshots captured"
if [ "$count" -eq 0 ]; then
  echo "::error::No screenshots were captured"
  exit 1
fi
