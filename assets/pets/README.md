# Bundled catalog pets

Normal `npm run db:migrate` (including worker startup) installs these three separate
published catalog options through the same manifest/raster/cell validation as imports:

| Display name | Stable catalog ID | Artwork and provenance |
| --- | --- | --- |
| Hermes | `builtin-hermes-v2` | [Green Hermes](hermes/README.md) |
| Hermes Assimilated | `builtin-hermes-assimilated-v2` | [Hermes Assimilated](hermes-assimilated/README.md) |
| The Queen | `builtin-the-queen-v2` | [The Queen](the-queen/README.md) |

Select them in Pet avatar settings, or assign a bot default through Admin → Pets.
Installation adds missing entries and upgrades only the known original standing
Hermes Assimilated raster to its close-framing revision. Other artwork and revisions,
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
local production build with all three bundles installed on a fresh test database.
