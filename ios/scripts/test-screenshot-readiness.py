"""Portable checks for screenshot export; native UI readiness still needs Xcode."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "screenshot_export", Path(__file__).with_name("export-research-screenshots.py"),
)
EXPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXPORT)


class ScreenshotExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.attachments = self.root / "attachments"
        self.attachments.mkdir()
        self.output = self.root / "output"
        self.manifest = [{"testIdentifier": EXPORT.TEST_ID, "attachments": []}]
        for index, name in enumerate(EXPORT.NAMES):
            filename = f"export-{index}.png"
            (self.attachments / filename).write_bytes(EXPORT.PNG_HEADER + name.encode())
            self.manifest[0]["attachments"].append({
                "suggestedHumanReadableName": f"{name}_0_00000000.png",
                "exportedFileName": filename,
                "isAssociatedWithFailure": False,
            })

    def export(self):
        (self.attachments / "manifest.json").write_text(json.dumps(self.manifest))
        EXPORT.export_screenshots(self.attachments, self.output)

    def assert_rejected_without_publishing(self):
        with self.assertRaises(ValueError):
            self.export()
        self.assertFalse(self.output.exists())

    def test_both_named_pngs_are_copied_without_changes(self):
        self.export()
        self.assertEqual({p.name for p in self.output.iterdir()},
                         {name + ".png" for name in EXPORT.NAMES})
        for name in EXPORT.NAMES:
            self.assertEqual((self.output / (name + ".png")).read_bytes(),
                             EXPORT.PNG_HEADER + name.encode())

    def test_missing_second_capture_does_not_publish_the_first(self):
        self.manifest[0]["attachments"].pop()
        self.assert_rejected_without_publishing()

    def test_duplicate_capture_is_rejected(self):
        self.manifest[0]["attachments"].append(self.manifest[0]["attachments"][0].copy())
        self.assert_rejected_without_publishing()

    def test_failure_attachment_is_not_accepted_as_readiness_evidence(self):
        self.manifest[0]["attachments"][1]["isAssociatedWithFailure"] = True
        self.assert_rejected_without_publishing()

    def test_other_tests_cannot_supply_the_captures(self):
        self.manifest[0]["testIdentifier"] = "Unrelated/testHome()"
        self.assert_rejected_without_publishing()

    def test_empty_png_is_rejected(self):
        (self.attachments / "export-1.png").write_bytes(b"")
        self.assert_rejected_without_publishing()

    def test_missing_exported_file_is_rejected(self):
        (self.attachments / "export-1.png").unlink()
        self.assert_rejected_without_publishing()

    def test_export_cannot_read_outside_attachment_directory(self):
        (self.root / "outside.png").write_bytes(EXPORT.PNG_HEADER)
        self.manifest[0]["attachments"][1]["exportedFileName"] = "../outside.png"
        self.assert_rejected_without_publishing()


if __name__ == "__main__":
    unittest.main()
