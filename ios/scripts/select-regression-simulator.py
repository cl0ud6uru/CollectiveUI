"""Select the standard iPhone used for regression validation from simctl JSON."""
import json
import re
import sys


MODEL_NAME = "iPhone 18 Pro"
MODEL_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro"
MINIMUM_IOS = 27


def select_device(inventory):
    candidates = []
    for runtime, devices in inventory["devices"].items():
        match = re.search(r"\.iOS-(\d+)-(\d+)(?:-(\d+))?$", runtime)
        if not match:
            continue
        version = tuple(int(part or 0) for part in match.groups())
        if version[0] < MINIMUM_IOS:
            continue
        for device in devices:
            device_type = device.get("deviceTypeIdentifier")
            matches_model = (
                device_type == MODEL_TYPE
                if device_type is not None
                else device.get("name") == MODEL_NAME
            )
            if device.get("isAvailable", True) and matches_model:
                candidates.append((version, runtime, device))

    if not candidates:
        raise ValueError(
            f"No available {MODEL_NAME} simulator with iOS {MINIMUM_IOS} or later. "
            "Create that simulator in Xcode, or pass an explicit simulator UDID "
            "as the third argument to simulator-regressions.sh."
        )

    # Prefer the newest runtime containing the chosen model, then a stable UDID.
    # A newer runtime containing only another iPhone model must not change the target.
    _, runtime, device = min(
        candidates,
        key=lambda candidate: (
            tuple(-part for part in candidate[0]), candidate[2]["udid"]
        ),
    )
    return runtime, device


def main():
    try:
        runtime, device = select_device(json.load(sys.stdin))
    except (KeyError, TypeError, ValueError) as error:
        print(f"Simulator selection failed: {error}", file=sys.stderr)
        return 1
    print(
        f"Regression simulator: {MODEL_NAME} ({device['name']}); "
        f"runtime={runtime}; UDID={device['udid']}",
        file=sys.stderr,
    )
    print(device["udid"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
