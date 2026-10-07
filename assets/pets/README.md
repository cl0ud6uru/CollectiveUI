# Bundled catalog pets

Normal `npm run db:migrate` (including worker startup) installs these four separate
published catalog options through the same manifest/raster/cell validation as imports:

| Display name | Stable catalog ID | Artwork and provenance |
| --- | --- | --- |
| Hermes | `builtin-hermes-v2` | [Green Hermes](hermes/README.md) |
| Hermes Assimilated | `builtin-hermes-assimilated-v2` | [Hermes Assimilated](hermes-assimilated/README.md) |
| The Queen | `builtin-the-queen-v2` | [The Queen](the-queen/README.md) |
| Nimbus | `builtin-nimbus-v2` | [CollectiveUI cloud companion](nimbus/README.md) |

Select them in Pet avatar settings, or assign a bot default through Admin → Pets.
Installation adds missing entries and upgrades only artwork from a known earlier
official release (listed in `BUNDLED_PETS[].releases`, such as the original standing
Hermes Assimilated raster) to the current bundle. It also adds a newly shipped HD
rendition to an untouched current release. Other artwork and revisions,
unpublication, bot defaults, personal selections, Off, and private imports are preserved.
Concurrent installers use conflict-safe inserts and an atomic revision/hash guard for
the artwork upgrade. Every needed bundle is validated before the transaction writes.
Built-ins can be unpublished, but not deleted through the app.
No private repository history or application code is imported with these assets.
The Queen's coordinator feature is separate; this bundle does not change it.

All runtime atlases have nine animation rows and sixteen clockwise gaze poses,
1536 × 2288 pixels in an 8 × 11 grid of 192 × 208 cells. Required row frame counts
are 6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8; the 15 unused cells are transparent.
Gaze rows complete the v2 format but do not add cursor tracking to the renderer.

## Optional HD rendition

A bundle may also ship `v2/spritesheet@2x.webp`: the same atlas at 3072 × 4576
(384 × 416 cells). It is a CollectiveUI extension, not part of Codex Pet v2.
`pet.json` never lists it, and imports and ZIP exports stay standard v2. It's
stored beside the v2 sheet under the same revision, and browsers fetch it (as a
`srcset` candidate) only for avatars drawn wider than their v2 frame, such as
the sign-in companion and 112-pixel avatars on retina screens. The installer
validates it like the v2 sheet, and also checks that it is the same artwork.
None ships yet. [REDRAW-2X.md](REDRAW-2X.md) covers making one with
`scripts/export-pet-frames.ts` and `scripts/build-pet-hd.ts`.

## Reproducible validation

- `npm test -- --project unit bundled-pets`: real file multipart imports, ZIP
  export/reimport, source hashes, cell margins, distinct gazes, and Queen's
  required-frame pixel equality. Synthetic cases separately exercise invalid input.
- Run migrations on a fresh local `collective_bundled_pets_test` database, then
  `BUNDLED_PETS_TEST=1 npm run test:integration -- bundled-pets` with its
  `DATABASE_URL`: clean migration installation, concurrent/idempotent installation,
  partial catalogs, unpublication and saved-choice preservation. The framing-upgrade
  tests read the former public WebP with `git show` from commit
  `a235f001722aa6923799fd9386c10f351c38a86b`; this commit must exist in the checkout.
  They also cover concurrent upgrades, operator replacements and preserved public
  sign-in-page revision pins. An admin must reconfirm that public selection after
  its artwork revision changes.
- `BUNDLED_PETS_BROWSER=1 npx playwright test -c tests/bundled-pets.playwright.config.ts`
  with the same disposable database and local production app: actual catalog,
  preview, import, selections, motion and browser-rendering checks.

The historical source notices describe their generating workspaces' checks.
They do not substitute for these application tests or assert a deployment.

[Catalog screenshot](../../docs/images/bundled-pets-catalog.png) captured from the
local production build with the original three bundles installed on a fresh test database.
See [Nimbus's motion preview](nimbus/previews/all-states.gif) for the fourth option.
