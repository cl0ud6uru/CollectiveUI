THE QUEEN — COLLECTIVEUI PET V2

Name: The Queen
Suggested starter bot name: The Queen
Asset ID: the-queen

IMPORT
Choose pet.json and spritesheet.png in CollectiveUI's pet importer. If you
downloaded the ZIP, extract it first. CollectiveUI does not import ZIP files.
Do not select spritesheet.webp with the supplied pet.json: that optional
lossless alternative needs spritesheetPath changed to spritesheet.webp.

FORMAT
1536 × 2288 static transparent PNG, 8 columns × 11 rows, 192 × 208 cells.
Nine canonical animation rows: idle (6), running-right (8), running-left (8),
waving (4), jumping (5), failed (8), waiting (6), running (6), review (6).
Neutral look is row 0 / column 6. Rows 9–10 contain 16 distinct cursor-look
directions, clockwise from screen-up at 22.5-degree increments.
Unused animation cells contain the neutral pose. See animation-layout.json.

COLLECTIVEUI RUNTIME
Current CollectiveUI uses idle, working (running), approval (waiting),
attention (failed, still first frame), unavailable (still idle), and a waving
greeting on the sign-in page. Remaining rows and look cells are supplied for
format completeness; current CollectiveUI does not display them dynamically.
No application settings, starter bot or repository was changed by this asset
package. The integrating task must apply the selected pet and bot name.

ART AND PROVENANCE
The real Moss and Ember SVGs in src/components/pets/pet-art.tsx were rendered
and visually inspected before design. Their rounded body, inset face, cream
eyes, noodle arms, simple highlight and muted colors guide this counterpart.
Source snapshot: d45bf44ef61374efe777bc55a4c01c597daaf790.
The source repository's LICENSE grants MIT terms, retained in LICENSE.txt.
Moss/Ember geometry and palette form the base; the crown and nine animation
programs plus 16 gaze poses were authored for The Queen.

Built-in OpenAI image generation was used for concept exploration. The first
concept proposed a sage robot and gold crown. A generated full-sheet draft was
rejected for inconsistent exact palette, alignment and gaze semantics. Neither
generated raster was edited or used as production sprite pixels. Final art is
deterministic, repo-native vector artwork rendered with sharp. This matches
the existing SVG family and keeps all frames aligned and reproducible.
No Borg, Star Trek or other franchise art was used as a source or traced.
No legal exclusivity or non-infringement guarantee is made.

VALIDATION
The actual pinned CollectiveUI parsePetManifest and normalizePetSprite
functions passed against this manifest and both raster encodings in an
isolated harness. All 88 cells contain art and have transparent margins.
All 16 gaze frames are unique. Static-page, alpha, dimensions, and 4 MiB
pre/post-normalization limits pass. validation.json records sizes and SHA-256.
This is asset/importer validation, not a full-app or deployed-runtime test.
Previews show native 112, 64, 32 and 28-pixel placements and light/dark contrast.

SOURCE
queen.svg is the neutral native vector source. build-queen.cjs regenerates
the complete raster atlas and per-frame files with Node and sharp installed.
The included animation-layout.json is documentation, not a custom manifest
animation map (CollectiveUI deliberately rejects such maps).

FORMAT REFERENCES
Canonical state counts: crafter-station/petdex at
7e327034c27098bb7b701b834e34af81c2cfbdba, src/lib/pet-states.ts
Codex v2 layout: portons/codex-pet-share at
27996cafa42119c86db5472af852a3ef185723f4, README.md and cardinal semantics.

RECOMMENDED CREDIT
AI-assisted design; vector production artwork adapted from CollectiveUI's
original MIT-licensed Moss/Ember visual family.
