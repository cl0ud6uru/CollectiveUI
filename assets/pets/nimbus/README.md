# Nimbus v2

A rounded charcoal cloud companion with a crimson rim, one expressive eye, and
three circuit tendrils. The user supplied the CollectiveUI brand reference and
selected the rounded toy concept. The artwork was generated with OpenAI ImageGen;
the reference, selected concept, and animation prompt templates are preserved in
`source/`.

Nine animation strips were generated separately against the selected concept.
Generated poses were extracted, fitted with a shared scale per row, and registered
to a common resting baseline. The jump preserves its vertical displacement.
Four approved cardinal gaze anchors grounded two coherent eight-pose gaze strips;
those strips share a single scale and lower-body registration. A final edge-local
cyan spill cleanup preserved the alpha channel. No character pixels were drawn
procedurally.

The runtime sheet contains 73 distinct occupied frames and 15 transparent unused
cells in the standard Codex Pet v2 layout: 1536 × 2288, eight columns, eleven rows,
192 × 208 cells. It has nine animation states and sixteen clockwise gaze poses.
The normalized PNG is 2,522,145 bytes, within CollectiveUI's 4 MiB limit.

Normal migrations and worker startup publish the missing `builtin-nimbus-v2`
catalog entry. Choose Nimbus in pet avatar settings or Admin → Pets. Installation
uses the existing bundle validator and preserves saved selections and unpublication.
No existing bot default is changed.

The [v2 ZIP](nimbus-v2.zip) contains only `pet.json` and `spritesheet.webp` at its
root, for manual import. It uses the Codex Pet v2 format; it has not been installed
or tested in the Codex desktop pet picker.

See [all nine animations](previews/all-states.gif), the
[contact sheet](previews/contact-sheet.png), and the
[clockwise look loop](previews/look-loop.gif), rendered from the packaged sheet.
Some neighboring diagonal gazes differ subtly. A secondary creation-tool heuristic
flagged transparent gaps between circuit tendrils as interior holes; a flood-fill
check found zero enclosed transparent pixels in all sixteen gaze cells. That
heuristic did not pass; the app's structural validation and import/export checks
are the acceptance gates for this bundle.

| Artifact | SHA-256 |
| --- | --- |
| `v2/spritesheet.webp` | `de72a1ea5ab66a2f5815c647f376c2c54b2d530cfe750341dc626a632f63ce31` |
| Normalized runtime PNG | `e69db846aeea8aaa74551e7bdf24a10e972f3830f0f97fe15e360f71d8682d11` |

Credit: Created for CollectiveUI from a user-supplied reference; artwork generated
with OpenAI ImageGen.

Validation: `npm test -- --project unit bundled-pets` covers the actual artwork,
normalized hash, multipart import, ZIP export/reimport, transparent cell edges,
and distinct frames. The existing opt-in database and browser suites include Nimbus.
