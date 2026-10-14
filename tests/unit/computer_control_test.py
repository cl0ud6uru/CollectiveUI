"""No-credential unit coverage for the private desktop control contract."""

import importlib.util
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONTROL_PATH = ROOT / "docker/computer/control.py"
spec = importlib.util.spec_from_file_location("computer_control", CONTROL_PATH)
control = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(control)


class ComputerControlTests(unittest.TestCase):
    def test_valid_inputs_map_to_fixed_argv_and_reject_shell_payloads(self):
        argv, body = control.command_for({"kind": "click", "x": 1279, "y": 799, "button": "right"})
        self.assertEqual(argv[-1], "3")
        self.assertIsNone(body)

        argv, body = control.command_for({"kind": "type", "text": "hello $(touch /tmp/should-not-run)"})
        self.assertEqual(argv[-2:], ["--file", "-"])
        self.assertEqual(body, b"hello $(touch /tmp/should-not-run)")

        argv, _ = control.command_for({"kind": "key", "key": "Control+v"})
        self.assertEqual(argv[-1], "ctrl+v")
        argv, _ = control.command_for({"kind": "scroll", "direction": "down", "amount": 10})
        self.assertEqual(argv[-1], "5")
        for bad in (
            {"kind": "click", "x": True, "y": 1},
            {"kind": "click", "x": 1280, "y": 1},
            {"kind": "click", "x": 1, "y": 1, "command": "id"},
            {"kind": "type", "text": "x" * 4001},
            {"kind": "type", "text": "bad\ntext"},
            {"kind": "key", "key": "Delete"},
            {"kind": "scroll", "direction": "up", "amount": 11},
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(control.InputError):
                    control.command_for(bad)

    def test_validates_bounded_jpeg_dimensions(self):
        jpeg = (b"\xff\xd8\xff\xc0\x00\x0b\x08\x03\x20\x05\x00\x01\x01\x11\x00"
                b"\xff\xd9")
        self.assertEqual(control.jpeg_dimensions(jpeg), (1280, 800))
        self.assertIsNone(control.jpeg_dimensions(jpeg[:-2]))

    def test_pause_and_resume_use_tracked_process_start_times(self):
        with tempfile.TemporaryDirectory(prefix="computer-control-test-") as directory:
            state_dir = Path(directory)
            control.STATE_DIR = state_dir
            control.STATE_FILE = state_dir / "session.json"
            server = subprocess.Popen(
                ["/bin/bash", "-c", "exec -a /opt/collective-computer/app-server.mjs /bin/bash -c 'sleep 60 & wait'"],
                start_new_session=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            try:
                root = None
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    root = control.process_identity(server.pid)
                    if root and len(control.process_tree(server.pid, int(root["starttime"]))) >= 2:
                        break
                    time.sleep(0.02)
                self.assertIsNotNone(root)
                starttime = int(root["starttime"])
                control.write_state({
                    "version": 1,
                    "root": {"pid": server.pid, "starttime": starttime},
                    "status": "running",
                    "processes": [{"pid": server.pid, "starttime": starttime}],
                })
                self.assertEqual(control.pause_session(), 0)
                paused = control.read_state()
                self.assertEqual(paused["status"], "paused")
                self.assertGreaterEqual(len(paused["processes"]), 2)
                for item in paused["processes"]:
                    identity = control.process_identity(item["pid"])
                    self.assertIsNotNone(identity)
                    self.assertEqual(identity["starttime"], item["starttime"])
                    self.assertIn(identity["state"], ("T", "t"))

                # A recycled PID identity is skipped even while the exact root is resumed.
                child = next(item for item in paused["processes"] if item["pid"] != server.pid)
                child["starttime"] += 100
                control.write_state(paused)
                self.assertEqual(control.resume_session(), 0)
                identity = control.process_identity(child["pid"])
                if identity and identity["starttime"] != child["starttime"]:
                    self.assertIn(identity["state"], ("T", "t"))
                    os.kill(child["pid"], signal.SIGCONT)
            finally:
                try:
                    os.killpg(server.pid, signal.SIGCONT)
                    os.killpg(server.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    server.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


if __name__ == "__main__":
    unittest.main(verbosity=2, testRunner=unittest.TextTestRunner(stream=sys.stdout, verbosity=2))
