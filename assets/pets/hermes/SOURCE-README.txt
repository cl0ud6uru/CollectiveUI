HERMES — GREEN CODEX PET V2 FOR COLLECTIVEUI

Name: Hermes
Description: A black-and-green animated companion celebrating Hermes Agent and its integration with CollectiveUI.
Credit: Pet adaptation for CollectiveUI by @cl0ud6uru. Inspired by Hermes Agent from Nous Research. Unofficial community artwork; not affiliated with or endorsed by Nous Research.

ARTWORK PROVENANCE
This green adaptation was generated with OpenAI image generation on 2026-10-04 from the user-approved green Hermes concept, hermes-green-concept.png. That concept was an edit of the existing Hermes pet artwork, preserving its character, face, long black hair, headset and costume design. The user chose the green version for the CollectiveUI pet. The earlier gold design and Borg concept variants are not replaced by this package.

Nine animation pose sequences and a sixteen-direction gaze sheet were generated as edits of the approved green concept. Software was used for technical alpha cleanup, separating tiles, padding, consistent per-sequence resampling, atlas assembly, preview encoding, hashing and package validation. There are 73 distinct occupied frames; frames are not a repeated static portrait.

This attribution does not claim an MIT license for the artwork. No new third-party artwork license, endorsement or ownership claim is asserted. Any underlying third-party rights in the source character remain with their respective holders.

DELIVERABLE FORMAT
The import ZIP contains exactly pet.json and spritesheet.webp at its root, using ordinary ZIP deflate. The sprite is a static, lossless WebP atlas, 1536 by 2288 pixels with transparent alpha, eight columns by eleven rows, 192 by 208 pixels per cell.

Rows 0–8: idle 6; running-right 8; running-left 8; waving 4; jumping 5; failed 8; waiting 6; running (Working) 6; review 6.
Rows 9–10: sixteen clockwise screen-target gaze directions, 0 through 337.5 degrees in 22.5-degree steps. 0 is up, 90 is screen right, 180 is down, and 270 is screen left. All 15 unused cells are fully transparent.

The manifest uses the exact name, description and credit above, spriteVersionNumber 2, frameWidth 192, frameHeight 208, columns 8 and spritesheetPath spritesheet.webp. It has no custom states or animations maps. Credit length is 171 characters.

VALIDATION
Importer source inspected at CollectiveUI commit 96f8aceb1d6b239ee8f66b3a05947a5790cf081c:
https://github.com/cl0ud6uru/CollectiveUI/blob/96f8aceb1d6b239ee8f66b3a05947a5790cf081c/src/lib/pets/atlas.ts
https://github.com/cl0ud6uru/CollectiveUI/blob/96f8aceb1d6b239ee8f66b3a05947a5790cf081c/src/lib/pets/import.ts
https://github.com/cl0ud6uru/CollectiveUI/blob/96f8aceb1d6b239ee8f66b3a05947a5790cf081c/src/lib/pets/archive.ts

The actual readPetArchive, normalizePetSprite and validateV2Cells functions from that source were executed successfully against this package. This verifies ZIP structure, static raster dimensions, the normalized PNG size limit, required cells and unused transparent cells. Manifest field values and limits were checked independently. parsePetManifest and the complete multipart parsePetUpload wrapper were not executed here because this artifact workspace lacks the application's zod dependency; application-level import remains an integration check for the repository task.

All 73 frame hashes are distinct, and no occupied frame touches the outer edge of its final cell. Nine per-state GIFs use the exact canonical durations. The overview GIF samples the simultaneously animated states every 100 ms. Visual review covered every pose, gaze order, small avatar sizes and both light and dark backgrounds. The animations are portrait/bust performances: the running states show upper-body jogging with arm swing, and the jumping state shows a buoyant upper-body motion.

The standard CollectiveUI renderer currently plays its selected state rows; the supplied gaze cells complete the v2 asset but do not by themselves add cursor tracking to the application.

The original artwork and repository files were not changed by the asset-creation task. Repository integration and live application import are separate from these artifact checks.
