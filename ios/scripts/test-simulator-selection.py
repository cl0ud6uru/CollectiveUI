"""Portable behavior checks for the regression simulator selection policy."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest


SELECTOR_PATH = Path(__file__).with_name("select-regression-simulator.py")
SPEC = importlib.util.spec_from_file_location("simulator_selection", SELECTOR_PATH)
SELECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SELECTOR)


def runtime(version):
    return f"com.apple.CoreSimulator.SimRuntime.iOS-{version}"


def device(udid, name="iPhone 18 Pro", **overrides):
    return {"name": name, "udid": udid, "isAvailable": True, **overrides}


class SimulatorSelectionTests(unittest.TestCase):
    def select(self, devices):
        return SELECTOR.select_device({"devices": devices})

    def run_selector(self, inventory):
        return subprocess.run(
            [sys.executable, "-B", str(SELECTOR_PATH)],
            input=json.dumps(inventory), text=True, capture_output=True, check=False,
        )

    def test_standard_model_wins_over_newer_runtime_with_only_duo(self):
        selected_runtime, selected = self.select({
            runtime("27-1"): [device("DUO", name="iPhone Duo")],
            runtime("27-0"): [device("STANDARD")],
        })
        self.assertEqual(selected_runtime, runtime("27-0"))
        self.assertEqual(selected["udid"], "STANDARD")

    def test_runtime_and_device_inventory_order_does_not_change_selection(self):
        entries = [
            (runtime("27-1"), [device("DUO", name="iPhone Duo")]),
            (runtime("27-0"), [device("Z"), device("A")]),
        ]
        reversed_entries = [(key, list(reversed(value))) for key, value in reversed(entries)]
        self.assertEqual(self.select(dict(entries)), self.select(dict(reversed_entries)))
        self.assertEqual(self.select(dict(entries))[1]["udid"], "A")

    def test_newest_matching_runtime_is_compared_numerically(self):
        selected_runtime, _ = self.select({
            runtime("27-2"): [device("A")],
            runtime("27-10"): [device("Z")],
            runtime("27-9"): [device("B")],
        })
        self.assertEqual(selected_runtime, runtime("27-10"))

    def test_patch_runtime_is_newer_than_minor_runtime(self):
        selected_runtime, _ = self.select({
            runtime("27-1"): [device("A")],
            runtime("27-1-1"): [device("Z")],
        })
        self.assertEqual(selected_runtime, runtime("27-1-1"))

    def test_type_identifier_accepts_renamed_standard_model(self):
        _, selected = self.select({runtime("27-0"): [device(
            "AUDIT", name="CollectiveUI audit", deviceTypeIdentifier=SELECTOR.MODEL_TYPE,
        )]})
        self.assertEqual(selected["udid"], "AUDIT")

    def test_present_type_identifier_overrides_matching_name(self):
        with self.assertRaisesRegex(ValueError, "No available iPhone 18 Pro"):
            self.select({runtime("27-0"): [device(
                "OTHER", deviceTypeIdentifier="com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
            )]})

    def test_name_fallback_is_exact_when_type_identifier_is_absent(self):
        _, selected = self.select({runtime("27-0"): [
            device("MAX", name="iPhone 18 Pro Max"), device("STANDARD"),
        ]})
        self.assertEqual(selected["udid"], "STANDARD")

    def test_unavailable_old_and_non_ios_devices_are_excluded(self):
        with self.assertRaisesRegex(ValueError, "No available iPhone 18 Pro"):
            self.select({
                runtime("27-1"): [device("UNAVAILABLE", isAvailable=False)],
                runtime("26-9"): [device("OLD")],
                "com.apple.CoreSimulator.SimRuntime.tvOS-27-0": [device("TV")],
            })

    def test_cli_logs_model_runtime_and_udid_without_contaminating_stdout(self):
        result = self.run_selector({"devices": {runtime("27-0"): [device("STANDARD")]}})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "STANDARD\n")
        self.assertIn("iPhone 18 Pro", result.stderr)
        self.assertIn(runtime("27-0"), result.stderr)
        self.assertIn("UDID=STANDARD", result.stderr)

    def test_missing_model_fails_with_creation_and_override_guidance(self):
        result = self.run_selector({"devices": {runtime("27-1"): [device("DUO", name="iPhone Duo")]}})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("Create that simulator in Xcode", result.stderr)
        self.assertIn("third argument to simulator-regressions.sh", result.stderr)

    def test_invalid_inventory_fails_without_a_selected_udid(self):
        result = self.run_selector({})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("Simulator selection failed:", result.stderr)


if __name__ == "__main__":
    unittest.main()
