"""Execute the explicit protocol patch against an archive of the exact public pin.

No gateway, live profiles, inference, grants or deployment. Synthetic agent only;
all native admission, threads, queue, cancellation and history remain real.
"""
import contextlib
import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
PIN = "f97608f178d1ffeca59860195ab7da295f7c8e5f"
SOURCE = Path(os.environ["HERMES_SOURCE"]).resolve()
assert subprocess.check_output(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], text=True).strip() == PIN
assert not subprocess.check_output(["git", "-C", str(SOURCE), "status", "--porcelain", "--untracked-files=all"], text=True).strip()
TEMP = tempfile.TemporaryDirectory(prefix="collective-native-recovery-")
HOME = Path(TEMP.name).resolve()
COPY = HOME / "source"
COPY.mkdir()
archive = subprocess.Popen(["git", "-C", str(SOURCE), "archive", PIN], stdout=subprocess.PIPE)
with tarfile.open(fileobj=archive.stdout, mode="r|") as tar:
    tar.extractall(COPY, filter="data")
assert archive.wait() == 0
# Reproduce the missing capability on the actual unpatched native source first.
baseline = subprocess.run([sys.executable, "-B", "-c", "import sys; sys.path.insert(0, sys.argv[1]); from tui_gateway import server; assert server.handle_request({'jsonrpc':'2.0','id':1,'method':'collective.recovery.capabilities','params':{}})['error']['code'] == -32601", str(COPY)],
                          cwd=HOME, env={"HOME": str(HOME), "HERMES_HOME": str(HOME / "baseline"), "PATH": "/usr/bin:/bin", "PYTEST_CURRENT_TEST": "collective-native-recovery-baseline", "HERMES_DISABLE_LAZY_INSTALLS": "1"}, capture_output=True)
assert baseline.returncode == 0, "Unpatched native capability baseline failed"
spec = importlib.util.spec_from_file_location("installer", ROOT / "scripts/install-hermes-recovery.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
originals = {name: (COPY / name).read_text() for name in installer.TARGETS}
for name, content in installer.patch_sources(originals).items():
    (COPY / name).write_text(content)
(COPY / installer.MODULE).write_bytes((ROOT / "src/hermes-recovery/native_recovery.py").read_bytes())
os.environ.clear()
os.environ.update(HOME=str(HOME), HERMES_HOME=str(HOME / "profile"), PATH="/usr/bin:/bin", HERMES_DISABLE_LAZY_INSTALLS="1", HERMES_ISO_CERTIFY_SYNTH_TURN="1", PYTEST_CURRENT_TEST="collective-native-recovery")
Path(os.environ["HERMES_HOME"]).mkdir()
Path(os.environ["HERMES_HOME"], "config.yaml").write_text("model:\n  default: synthetic-conformance\n  provider: synthetic\ndashboard:\n  process_isolation: false\n")
os.chdir(HOME)
socket.socket.connect = lambda *args, **kw: (_ for _ in ()).throw(AssertionError("External I/O forbidden"))
socket.socket.connect_ex = socket.socket.connect
socket.socket.sendto = socket.socket.connect
socket.getaddrinfo = lambda *args, **kw: (_ for _ in ()).throw(AssertionError("External DNS forbidden"))
_popen = subprocess.Popen

class LocalPopen(_popen):
    def __init__(self, argv, *args, **kwargs):
        if not isinstance(argv, (list, tuple)) or Path(argv[0]).name != "git" or any(word in argv for word in ("fetch", "pull", "push", "clone", "ls-remote")):
            raise AssertionError("Only local git inspection may spawn")
        super().__init__(argv, *args, **kwargs)

# Preserve the native type, including eagerly evaluated Popen | None annotations.
subprocess.Popen = LocalPopen
sys.path.insert(0, str(COPY))
from tui_gateway import server
from tui_gateway.synthetic_turn import SyntheticHeavyAgent
from hermes_cli import mcp_startup
mcp_startup.start_deferred_mcp_discovery_now = lambda: None
BUILD = threading.Event()
BUILD.set()
RELEASE = threading.Event()
TURNS = []


class FixtureAgent(SyntheticHeavyAgent):
    def run_conversation(self, message, *, conversation_history=None, **kwargs):
        TURNS.append(message)
        if "hold" in str(message):
            RELEASE.wait(5)  # Deliberately does not cooperate with interruption until released.
        return {"final_response": "Synthetic reply", "messages": [*(conversation_history or []), {"role": "user", "content": str(message)}, {"role": "assistant", "content": "Synthetic reply"}], "completed": True, "interrupted": self._interrupt.is_set(), "error": None}


def make_agent(sid, key, **kwargs):
    BUILD.wait(5)
    return FixtureAgent(key, model="synthetic-conformance")


server._make_agent = make_agent
type(server._stdio_transport).write = lambda self, frame: True
RPC_ID = 0


def rpc(method, params=None):
    global RPC_ID
    RPC_ID += 1
    return server.handle_request({"jsonrpc": "2.0", "id": RPC_ID, "method": method, "params": params or {}})


class RecoveryContract(unittest.TestCase):
    def setUp(self):
        BUILD.set()
        RELEASE.clear()
        created = rpc("session.create", {"profile": "default", "close_on_disconnect": False})
        self.assertNotIn("error", created)
        self.sid = created["result"]["session_id"]
        self.stored = created["result"]["stored_session_id"]
        self.body = {"profile": "default", "session_id": self.sid, "stored_session_id": self.stored,
                     "recovery_id": str(uuid.uuid4()), "reservation_ids": [str(uuid.uuid4())]}

    def tearDown(self):
        BUILD.set()
        RELEASE.set()
        for _ in range(100):
            if self.sid in server._collective_recovery.fences:
                result = rpc("collective.recovery.status", {"recovery_id": self.body["recovery_id"]})
                if result.get("result", {}).get("state") == "drained":
                    break
            time.sleep(.01)

    def submit(self, text, **extra):
        result = rpc("prompt.submit", {"session_id": self.sid, "profile": "default", "text": text, **extra})
        self.assertNotIn("error", result)
        return result["result"]

    def wait_turn(self, text):
        deadline = time.monotonic() + 4
        while text not in TURNS and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertIn(text, TURNS)

    def cancel(self):
        result = rpc("collective.recovery.cancel_and_drain", self.body)
        self.assertNotIn("error", result)
        return result["result"]

    def drained(self):
        for _ in range(200):
            result = rpc("collective.recovery.status", {"recovery_id": self.body["recovery_id"]})["result"]
            if result["state"] == "drained":
                return result
            time.sleep(.01)
        self.fail("Tracked native workers failed to drain")

    def test_explicit_versioned_capability_and_actual_admission(self):
        self.assertEqual(rpc("collective.recovery.capabilities")["result"], {"protocol": "collective.cancel-drain.v1", "scope": "inline_prompt_runtime", "durable": True})
        self.assertEqual(self.submit("hold-one")["status"], "streaming")
        for _ in range(100):
            if "hold-one" in TURNS:
                break
            time.sleep(.01)
        self.assertIn("hold-one", TURNS)
        self.submit("queued-must-not-run", queued=True)
        # Native interrupt replies while the deliberately noncooperative worker remains live.
        self.assertNotIn("error", rpc("session.interrupt", {"session_id": self.sid}))
        old_runtime = server._sessions[self.sid]
        old_runtime["running"] = False
        self.assertEqual(self.cancel()["state"], "pending")
        self.assertIn("error", rpc("prompt.submit", {"session_id": self.sid, "text": "must-not-run"}))
        self.assertIn("error", rpc("session.resume", {"session_id": self.stored, "profile": "default"}))
        self.assertIsNone(server._pop_session_by_id(self.sid))
        self.assertEqual(self.cancel()["state"], "pending")
        RELEASE.set()
        receipt = self.drained()
        self.assertEqual(receipt["reservation_ids"], self.body["reservation_ids"])
        self.assertNotIn("queued-must-not-run", TURNS)
        # Lost receipt/retry returns the retained durable result, not another interruption.
        self.assertEqual(self.cancel(), receipt)
        self.assertNotIn(self.sid, server._sessions)
        with patch.object(server, "_ensure_session_db_row", side_effect=AssertionError("Late old-runtime persistence")):
            self.assertFalse(server._run_prompt_submit(1, self.sid, old_runtime, "late-notification"))
        self.assertNotIn("error", rpc("session.resume", {"session_id": self.stored, "profile": "default", "close_on_disconnect": False}))

    def test_deferred_agent_build_cannot_be_mistaken_for_idle_completion(self):
        BUILD.clear()
        before = len(TURNS)
        self.submit("deferred-must-not-run")
        self.assertEqual(self.cancel()["state"], "pending")
        BUILD.set()
        self.drained()
        self.assertEqual(len(TURNS), before)

    def test_receipt_identity_and_principal_cannot_be_rebound(self):
        self.submit("hold-identity")
        self.cancel()
        different = {**self.body, "reservation_ids": ["another-operation"]}
        self.assertEqual(rpc("collective.recovery.cancel_and_drain", different)["error"]["code"], 4090)
        with patch.object(server._collective_recovery, "principal", return_value="another-owner"):
            self.assertEqual(rpc("collective.recovery.status", {"recovery_id": self.body["recovery_id"]})["error"]["code"], 4040)
        RELEASE.set()
        self.drained()

    def test_process_change_keeps_uncertainty_and_blocks_resume(self):
        self.submit("hold-restart")
        self.wait_turn("hold-restart")
        self.cancel()
        recovery = server._collective_recovery
        from tui_gateway.collective_recovery import Recovery
        restarted = Recovery(server)
        self.assertTrue(restarted.blocked(server._sessions[self.sid]))
        # Compression may have rotated stored identity before a crash. A new process
        # conservatively fences this profile, including an unknown descendant key.
        self.assertTrue(restarted.blocked({**server._sessions[self.sid], "_closing": False, "session_key": "rotated-after-admission"}))
        with patch.object(recovery, "boot", restarted.boot):
            receipt = restarted.status(1, {"recovery_id": self.body["recovery_id"]})["result"]
            self.assertEqual((receipt["state"], receipt["reason"]), ("pending", "process_changed"))
            self.assertIn("error", rpc("session.resume", {"session_id": self.stored, "profile": "default"}))
        RELEASE.set()
        self.drained()

    def test_wrong_runtime_binding_missing_runtime_and_isolated_child_refuse_evidence(self):
        with patch.object(server, "_session_uses_compute_host", return_value=True):
            self.assertEqual(rpc("collective.recovery.cancel_and_drain", self.body)["error"]["code"], 4090)
        self.assertEqual(rpc("collective.recovery.cancel_and_drain", {**self.body, "stored_session_id": "wrong"})["error"]["code"], 4030)
        self.assertEqual(rpc("collective.recovery.cancel_and_drain", {**self.body, "session_id": "missing"})["error"]["code"], 4001)

    def test_competing_recovery_ids_cannot_strand_a_second_pending_fence(self):
        self.submit("hold-duplicate-recovery")
        self.wait_turn("hold-duplicate-recovery")
        self.assertEqual(self.cancel()["state"], "pending")
        other = {**self.body, "recovery_id": str(uuid.uuid4())}
        self.assertEqual(rpc("collective.recovery.cancel_and_drain", other)["error"]["code"], 4090)
        self.assertEqual(rpc("collective.recovery.status", {"recovery_id": other["recovery_id"]})["error"]["code"], 4040)
        RELEASE.set()
        self.drained()
        self.assertNotIn("error", rpc("session.resume", {"session_id": self.stored, "profile": "default", "close_on_disconnect": False}))

    def test_cancel_cannot_overtake_a_native_handler_before_its_worker_is_published(self):
        entered, release_handler, cancelled = threading.Event(), threading.Event(), threading.Event()
        original_build = server._start_agent_build
        replies = []
        def held_build(sid, session):
            entered.set()
            release_handler.wait(2)
            original_build(sid, session)
        def cancel():
            replies.append(rpc("collective.recovery.cancel_and_drain", self.body))
            cancelled.set()
        with patch.object(server, "_start_agent_build", side_effect=held_build):
            submitter = threading.Thread(target=lambda: self.submit("hold-racing-admission"))
            submitter.start()
            self.assertTrue(entered.wait(1))
            canceller = threading.Thread(target=cancel)
            canceller.start()
            self.assertFalse(cancelled.wait(.05))
            release_handler.set()
            submitter.join(3)
            canceller.join(3)
            self.assertFalse(submitter.is_alive())
            self.assertFalse(canceller.is_alive())
        self.assertNotIn("error", replies[0])
        RELEASE.set()
        self.drained()

    def test_failed_journal_write_does_not_cancel_or_fence_the_runtime(self):
        recovery = server._collective_recovery
        with recovery.database() as db:
            db.execute("CREATE TRIGGER reject_recovery_insert BEFORE INSERT ON recovery BEGIN SELECT RAISE(ABORT,'synthetic journal failure'); END")
        try:
            with self.assertRaises(Exception):
                recovery.cancel(1, self.body)
            self.assertFalse(server._sessions[self.sid].get("_closing", False))
        finally:
            with recovery.database() as db:
                db.execute("DROP TRIGGER reject_recovery_insert")

    def test_auxiliary_worker_is_explicitly_tracked_by_the_patch(self):
        started = threading.Event()
        s = server._sessions[self.sid]
        def auxiliary():
            started.set()
            RELEASE.wait(5)
        server._collective_start_auxiliary_work(auxiliary, name="synthetic-auxiliary", session=s)
        self.assertTrue(started.wait(1))
        self.assertEqual(self.cancel()["state"], "pending")
        RELEASE.set()
        self.drained()


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        BUILD.set()
        RELEASE.set()
        server._shutdown_sessions()
        TEMP.cleanup()
