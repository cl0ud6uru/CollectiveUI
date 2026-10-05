HERMES ASSIMILATED — CODEX PET V2 FOR COLLECTIVEUI

Name: Hermes Assimilated
Description: A cybernetic Hermes companion with emerald accents and Borg-inspired implants.
Credit: Pet adaptation for CollectiveUI by @cl0ud6uru. Inspired by Hermes Agent from Nous Research. Unofficial community artwork; not affiliated with or endorsed by Nous Research.

SEPARATE PET
This is a new, separate pet based on the user-selected Seven Echo concept, hermes-borg-01-seven-echo.png. It does not replace green Hermes. The previously delivered green Hermes ZIP remains byte-for-byte unchanged.

ARTWORK PROVENANCE
The Seven Echo concept was generated with OpenAI image generation as a Borg-inspired variation of the existing Hermes character. The user selected the first of five variations and chose the name Hermes Assimilated. On 2026-10-04, the selected concept was used directly as the image reference for this complete animated adaptation.

All nine animation sequences and sixteen clockwise gaze poses were generated with OpenAI image generation, preserving the black hair, friendly face, emerald cybernetic eye, headset, asymmetric arm/rib implants and leg hardware. The first release used full-body poses. After the user showed that these were too small in the application, the current revision was regenerated in the same close waist-up bust framing as green Hermes, with a larger readable face, cybernetic eye, shoulder, arm and rib implants. The idle pose has the hands gently clasped near the waist. The new pose sequences and gaze directions preserve this closer framing. Two hand-costume inconsistencies had been corrected in the original full-body release; the current revision likewise retains mechanical gloves. Software was used for technical alpha cleanup, tile separation, padding, consistent per-sequence resampling, atlas assembly, preview encoding and validation.

This is unofficial Star Trek Borg-inspired fan artwork. It is not affiliated with or endorsed by the owners of Star Trek or by Nous Research. This attribution does not assert an MIT license, other third-party artwork license, ownership transfer or endorsement.

IMPORT PACKAGE
The ZIP contains exactly pet.json and spritesheet.webp at its root, using ordinary ZIP deflate. The lossless WebP is a static transparent atlas, 1536 by 2288 pixels, with eight columns by eleven rows of 192 by 208 pixels.

Rows 0–8: idle 6; running-right 8; running-left 8; waving 4; jumping 5; failed 8; waiting 6; running (Working) 6; review 6.
Rows 9–10: sixteen screen-target gaze directions in clockwise order, 0 through 337.5 degrees, spaced by 22.5 degrees. Up is 0, screen right is 90, down is 180 and screen left is 270. There are 73 distinct occupied frames and 15 fully transparent unused cells.

The manifest uses spriteVersionNumber 2, frameWidth 192, frameHeight 208, columns 8 and spritesheetPath spritesheet.webp, with the exact name, description and credit above. No custom states or animations map is included.

VALIDATION
The actual CollectiveUI readPetArchive, normalizePetSprite and validateV2Cells functions were executed successfully against this package, using source pinned to commit 96f8aceb1d6b239ee8f66b3a05947a5790cf081c. The normalized PNG is 3,585,739 bytes, below the 4 MiB limit.

https://github.com/cl0ud6uru/CollectiveUI/blob/96f8aceb1d6b239ee8f66b3a05947a5790cf081c/src/lib/pets/atlas.ts
https://github.com/cl0ud6uru/CollectiveUI/blob/96f8aceb1d6b239ee8f66b3a05947a5790cf081c/src/lib/pets/import.ts
https://github.com/cl0ud6uru/CollectiveUI/blob/96f8aceb1d6b239ee8f66b3a05947a5790cf081c/src/lib/pets/archive.ts

Manifest fields and limits were also checked independently. parsePetManifest and the complete multipart parsePetUpload wrapper were not executed in the artifact workspace because it lacks the application's zod dependency. Application-level import and repository integration remain separate integration checks.

All 73 occupied frame hashes differ. All required GIF sequences contain their expected number of frames and nonzero changes between adjacent frames, including the loop boundary. Per-state GIFs use the canonical animation durations; the combined overview samples the simultaneous loops every 100 ms. Visual review covered the entire pose contact sheet, clockwise gazes, and light/dark avatar sizes. No final occupied frame touches the outer edge of its cell.

The supplied gaze cells complete the v2 asset; they do not by themselves add cursor tracking to the standard CollectiveUI renderer. No repository files, live application settings or installed pets were changed by this asset-creation task.

CLOSE-FRAMING REVISION
The source character was first edited with image generation into a close bust master using green Hermes as a framing/pose reference. All nine state sequences and sixteen gaze frames were generated from that master. The previous full-body working assets were retained until validation completed; the Library artifacts are updated as new versions of the same files. Original concept images and green Hermes remain unchanged.

The native-size comparison shows green Hermes, the previous standing Assimilated version and the revised bust at 28, 32, 56 and 84 pixels, plus a clearly labeled enlarged view of the 32-pixel rendering. Both light and dark backgrounds were reviewed. It is an artifact rendering comparison, not a claim that the live application has already been updated.

To meet the importer's decoded-PNG size limit without shrinking the face, final RGB channels are encoded in four-value intervals, changing each channel by at most 2 out of 255. Alpha is unchanged. The final lossless WebP and every preview use those same encoded pixels. The dimensions, pose layout and visible scale are retained.
