"""Standard-library regression tests; uses only synthetic files, profiles, and keys."""
import importlib.util
import io
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


attachments = load("attachments", ROOT / "src/hermes-attachments/api_server_attachments.py")
installer = load("installer", ROOT / "scripts/install-hermes-attachments.py")


class Files(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = attachments.AttachmentStore(self.temp.name)
        self.scope = attachments.scope_for("example", "synthetic-key", "example-session", "example-owner")

    def test_originals_persist_across_store_restarts_and_keep_extensions(self):
        for mime, extension in (("application/msword", ".doc"), ("application/pdf", ".pdf"), ("image/png", ".png")):
            original = b"synthetic original bytes\x00\xff"
            receipt = self.store.put(self.scope, "example-upload" + extension, "example" + extension, mime, original)
            self.assertNotIn("path", receipt)
            files = attachments.AttachmentStore(self.temp.name).resolve(self.scope, [receipt["id"]])
            self.assertEqual(Path(files[0]["path"]).read_bytes(), original)
            self.assertEqual(Path(files[0]["path"]).suffix, extension)

    def test_profile_session_owner_and_key_isolation(self):
        receipt = self.store.put(self.scope, "example-upload", "example.doc", "application/msword", b"synthetic")
        for args in (("other-profile", "synthetic-key", "example-session", "example-owner"),
                     ("example", "different-key", "example-session", "example-owner"),
                     ("example", "synthetic-key", "other-session", "example-owner"),
                     ("example", "synthetic-key", "example-session", "other-owner")):
            with self.assertRaises(attachments.AttachmentError):
                self.store.resolve(attachments.scope_for(*args), [receipt["id"]])

    def test_stable_receipts_and_conflicting_uploads(self):
        args = (self.scope, "example-upload", "example.pdf", "application/pdf", b"synthetic")
        self.assertEqual(self.store.put(*args), self.store.put(*args))
        with self.assertRaises(attachments.AttachmentError) as error:
            self.store.put(*args[:-1], b"different bytes")
        self.assertEqual(error.exception.status, 409)

    def test_filenames_are_metadata_and_reject_traversal_and_control_characters(self):
        for name in ("../escape", "a/b", "a\\b", "bad\nname", ".", "..", "a" * 201):
            with self.assertRaises(attachments.AttachmentError):
                self.store.put(self.scope, "example", name, "application/pdf", b"synthetic")
        receipt = self.store.put(self.scope, "unicode", "example résumé.pdf", "application/pdf", b"synthetic")
        self.assertNotIn("résumé", self.store.resolve(self.scope, [receipt["id"]])[0]["path"])

    def test_empty_missing_duplicate_and_malformed_ids_fail(self):
        for ids in ([], ["../file"], ["a" * 32], ["a" * 32] * 2, ["a" * 32] * 9, "a" * 32):
            with self.assertRaises(attachments.AttachmentError):
                self.store.resolve(self.scope, ids)

    def test_limits_and_mime_checks(self):
        with self.assertRaises(attachments.AttachmentError):
            self.store.put(self.scope, "empty", "empty.pdf", "application/pdf", b"")
        with self.assertRaises(attachments.AttachmentError):
            self.store.put(self.scope, "mime", "example.pdf", "invalid type", b"synthetic")
        with patch.object(attachments, "MAX_FILE_BYTES", 5):
            with self.assertRaises(attachments.AttachmentError):
                self.store.put(self.scope, "size", "example.pdf", "application/pdf", b"synthetic")
        with patch.object(attachments, "MAX_SESSION_BYTES", 5):
            with self.assertRaises(attachments.AttachmentError):
                self.store.put(self.scope, "quota", "example.pdf", "application/pdf", b"synthetic")
        ids = [self.store.put(self.scope, str(i), "example.pdf", "application/pdf", b"synthetic")["id"] for i in range(2)]
        with patch.object(attachments, "MAX_BATCH_BYTES", 10):
            with self.assertRaises(attachments.AttachmentError):
                self.store.resolve(self.scope, ids)

    def test_modified_original_and_symlink_are_rejected(self):
        receipt = self.store.put(self.scope, "example", "example.pdf", "application/pdf", b"synthetic")
        path = Path(self.store.resolve(self.scope, [receipt["id"]])[0]["path"])
        path.write_bytes(b"corrupted")
        with self.assertRaises(attachments.AttachmentError):
            self.store.resolve(self.scope, [receipt["id"]])
        path.unlink()
        path.symlink_to(ROOT / "package.json")
        with self.assertRaises(attachments.AttachmentError):
            self.store.resolve(self.scope, [receipt["id"]])

    def test_anonymous_and_unbounded_session_scopes_are_rejected(self):
        for key, session, owner in (("", "session", "owner"), ("key", "", "owner"), ("key", "session", ""),
                                    ("key", "../a\n", "owner"), ("key", "a" * 257, "owner")):
            with self.assertRaises(attachments.AttachmentError):
                attachments.scope_for("example", key, session, owner)

    def test_installer_rejects_changed_integration_points(self):
        with self.assertRaises(ValueError):
            installer.patched("not the pinned source", "not the pinned source")

    def test_other_original_file_types_remain_opaque_binary_data(self):
        receipt = self.store.put(self.scope, "archive", "example.zip", "application/zip", b"synthetic zip bytes")
        file = self.store.resolve(self.scope, [receipt["id"]])[0]
        self.assertEqual(file["media_type"], "application/zip")
        self.assertEqual(Path(file["path"]).read_bytes(), b"synthetic zip bytes")

    def test_installer_dry_run_and_apply_preserve_originals_and_never_restart_services(self):
        root = Path(self.temp.name) / "synthetic-install"
        for name in (installer.API, installer.RUNS):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("original = True\n")
        arguments = ["installer", "--hermes-source", str(root)]
        with patch.object(installer.subprocess, "check_output", side_effect=[installer.PIN + "\n", ""]) as commands, \
                patch.object(installer, "patched", return_value=("patched = True\n", "patched = True\n")), \
                patch.object(sys, "argv", arguments), redirect_stdout(io.StringIO()):
            installer.main()
            self.assertTrue(all(call.args[0][0] == "git" for call in commands.call_args_list))
        self.assertFalse((root / installer.MODULE).exists())
        self.assertEqual((root / installer.API).read_text(), "original = True\n")
        with patch.object(installer.subprocess, "check_output", side_effect=[installer.PIN + "\n", ""]), \
                patch.object(installer, "patched", return_value=("patched = True\n", "patched = True\n")), \
                patch.object(sys, "argv", arguments + ["--apply"]), redirect_stdout(io.StringIO()):
            installer.main()
        self.assertEqual((root / installer.MODULE).read_bytes(), installer.SOURCE.read_bytes())
        self.assertEqual((root / installer.API).read_text(), "patched = True\n")
        backup = next(root.glob("collectiveui-attachment-backup-*"))
        self.assertEqual((backup / "api_server.py").read_text(), "original = True\n")

    def test_installer_refuses_a_different_revision_or_dirty_targets_before_writing(self):
        arguments = ["installer", "--hermes-source", self.temp.name, "--apply"]
        for responses in (["different-revision\n"], [installer.PIN + "\n", "modified"]):
            with patch.object(installer.subprocess, "check_output", side_effect=responses), patch.object(sys, "argv", arguments):
                with self.assertRaises(SystemExit):
                    installer.main()
        self.assertFalse((Path(self.temp.name) / installer.MODULE).exists())


if __name__ == "__main__":
    unittest.main()
