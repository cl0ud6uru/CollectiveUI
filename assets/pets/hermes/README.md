# Hermes v2 — green concept preparation

A black-and-green animated companion celebrating Hermes Agent and its integration with CollectiveUI.

Pet adaptation for CollectiveUI by @cl0ud6uru. Inspired by Hermes Agent from Nous Research. Unofficial community artwork; not affiliated with or endorsed by Nous Research.

## Status

The user selected `hermes-green-concept.png`, an image-generated edit of the
earlier reference-inspired Hermes pet, as the design for this adaptation. The
concept could not yet be transferred into the development workspace. No pixels
have been inspected, no animation frames have been generated, and no runtime
sprite is included here. The manifest and installer are preparation only; startup
does not call the installer. The previous black-and-gold artwork is not included.

## Artwork notice

Complete provenance and third-party licensing permissions for the underlying
reference artwork have not been established. The credit above is attribution,
not a license grant. CollectiveUI's MIT license applies to the application code;
it does not license Hermes artwork or grant rights in the underlying reference.
No original ownership of the reference or official endorsement is claimed.
Preserve any source notices supplied with the finished artwork.

## Integration contract

The planned stable catalog ID is `builtin-hermes-v2`. The installer validates
the manifest, decodes and normalizes the static raster through the app's importer,
and checks all required v2 cells before inserting a published catalog entry.
Insertion is idempotent and concurrency-safe. Existing catalog rows, administrator
unpublication, bot defaults, personal choices, Off, and private imports are retained.

The finished atlas must contain the nine canonical animation rows (6, 8, 8, 4, 5,
8, 6, 6, 6 frames) and sixteen clockwise gaze poses in rows 9 and 10. Its dimensions
must be 1536 × 2288, with 192 × 208 cells and eight columns. All unused cells must
remain transparent. Structural validation does not establish distinct motion,
gaze semantics, faithful character identity, or visual quality; those require
inspection of the actual artwork and browser rendering.

Before publishing: finish and visually inspect the selected green artwork, record
its source and atlas hashes, test actual file/ZIP import and rendering, wire the
installer after migrations, include this asset directory in the worker image,
update the root and served artwork notices, and verify a clean installation.
Synthetic fixture tests exercise only the installer mechanics, not Hermes pixels.
