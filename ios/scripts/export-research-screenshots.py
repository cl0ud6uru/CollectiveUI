"""Copy the two named XCTest PNG attachments, rejecting incomplete evidence."""
import json
from pathlib import Path
import shutil
import sys


NAMES = ("ipad-01-research-chat", "ipad-dark-01-research-chat")
TEST_ID = "CollectiveUIScreenshots/testIPadResearchScreenshots()"
PNG_HEADER = b"\x89PNG\r\n\x1a\n"


def export_screenshots(attachments_dir, output_dir):
    attachments_dir = Path(attachments_dir).resolve()
    output_dir = Path(output_dir)
    manifest = json.loads((attachments_dir / "manifest.json").read_text())
    attachments = [attachment for test in manifest if test["testIdentifier"] == TEST_ID
                   for attachment in test["attachments"]]
    sources = []
    for name in NAMES:
        matches = [item for item in attachments
                   if item["suggestedHumanReadableName"].startswith(name + "_")
                   and item["suggestedHumanReadableName"].endswith(".png")
                   and not item.get("isAssociatedWithFailure", False)]
        if len(matches) != 1:
            raise ValueError(f"Expected exactly one successful {name} attachment, found {len(matches)}")
        source = (attachments_dir / matches[0]["exportedFileName"]).resolve()
        if source.parent != attachments_dir or not source.is_file():
            raise ValueError(f"Invalid exported file for {name}")
        with source.open("rb") as image:
            if image.read(len(PNG_HEADER)) != PNG_HEADER:
                raise ValueError(f"Missing PNG content for {name}")
        sources.append((source, output_dir / (name + ".png")))
    # Validate both before publishing either under the expected screenshot names.
    output_dir.mkdir(parents=True, exist_ok=True)
    for source, destination in sources:
        shutil.copyfile(source, destination)


if __name__ == "__main__":
    try:
        export_screenshots(sys.argv[1], sys.argv[2])
    except (IndexError, KeyError, OSError, TypeError, ValueError) as error:
        sys.exit(f"Research screenshot export failed: {error}")
