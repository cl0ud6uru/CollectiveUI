# Optional pet avatars

Moss and Ember are built-in CollectiveUI companions. Additional artwork can be imported privately or uploaded to the admin catalog with the appropriate sharing rights. Fresh installations do not seed third-party catalog artwork. Personal Hermes bots start with Moss; users can change their avatar normally.

Private caller bots use an explicit **My avatar preference**: **Follow bot default**, **Personal pet**, or **Off · original icon**. People without a saved choice follow the shared default; when none is assigned, the original icon remains. Enabled legacy personal choices are retained; ambiguous legacy disabled preferences follow the one-time upgrade policy below. Moss and Ember are original CollectiveUI seedling robots. Preferences persist across devices and apply only to the signed-in person's view of that bot.

Admins manage **Admin → Pets**: upload a bounded `pet.json` and static PNG/WebP as a draft, review its animation and credit, confirm sharing rights, then publish. Published catalog pets appear as artwork/name radio cards alongside Moss and Ember for every signed-in user in this single-organization installation. Drafts and unpublished assets are admin only. Shared caller bots (organization or group audience) have one pet identity controlled by their owner or an admin. Service bots, including private service bots, are admin only. Other viewers cannot override, turn off or import a different identity. Everyone can change their own animation setting, and system reduced motion always applies. Shared art needs sharing rights, which may differ from private-use rights. No gallery artwork is downloaded.

An admin may explicitly copy **their own selected saved private import** into an admin draft, review/publish it, then assign it as a default. Admin status never allows reading another user's private upload. No migration or preference save publishes a private import automatically. Unpublishing is reversible: references stay intact, unavailable personal catalog selections fall back to the bot default, and unavailable defaults fall back to the original icon. Catalog cards show both bot-default references and active private personal-selection counts, with an unpublish impact warning; counts disclose no user identities or private artwork. Republishing restores retained selections.

Deletion is separate from unpublishing and permanent. **Delete pet…** is offered only for drafts and unpublished uploads, after a confirmation that names the pet and counts all saved references, including inactive choices; a published pet must be unpublished first. `DELETE /api/admin/pets/[id]` requires a fresh admin, the same-origin check and a body repeating the pet ID. In one transaction it locks the row, resets bot defaults that use it to the original icon and personal selections to following the bot default (what those people already see while it is unpublished), clears retained catalog choices while preserving Off and private imports, deletes the artwork and records `pet.catalog_deleted` with the counts. An already-deleted notice survives catalog refresh, and a lost or malformed response asks the administrator to refresh before retrying without claiming success or rollback. Legacy built-in pets (`builtin-*` IDs) retained by existing installations remain protected from deletion and can be unpublished. Startup does not install catalog artwork. Foreign keys still prevent deleting a referenced asset any other way.

The central `BotAvatar` applies the resolved preference only with an explicit bot ID. It replaces the existing icon in the sidebar, header, panel, detail page, cards, search, selection menus, and group speaker markers. Branding, app icons, avatar editors and template previews keep their original artwork. Original dimensions and composer layout remain unchanged. Failed images fall back to the original bot icon and retry once after three seconds; prolonged failures require reload/remount. Admin draft previews show an explicit error instead of substituting unrelated artwork.

**Still**, reduced motion and hidden tabs pause animation. The authenticated shell queries only accessible bot IDs, the current user's metadata, defaults, and published catalog metadata; image bytes are fetched separately. The account-keyed provider updates all placements together, refreshes on focus/visibility and every 30 seconds while visible, and cancels older requests when server props change. There is no localStorage or browser-persistent preference cache. Access and catalog status are checked again on image requests. Already rendered pixels cannot be recalled; open views reconcile revocation on refresh/focus or within the next 30-second refresh.

## Activity contract

The existing authenticated `useChat` stream and visible message branch are the source of truth. The header tooltip and one screen-reader live status deliberately say **in this chat**:

| Evidence | Display |
| --- | --- |
| Browser offline or chat unavailable | Chat connection unavailable (still) |
| Last assistant message contains an approval-requested tool part | Waiting for your approval |
| Chat status submitted or streaming | Working in this chat |
| Current transport error or last assistant message contains a persisted `data-run-error` / `data-bot-error` | This reply needs attention |
| Otherwise | Idle in this chat |

An approval takes precedence over streaming. A new send takes precedence over an earlier error. Only the latest message in the selected branch contributes approval/error state; historical failures do not permanently mark the bot. The durable chat snapshot and stream replay handle reloads. A queued send becomes working; completion returns to idle. A stop ends working and may display the existing persisted interruption note as attention.

The mounted direct chat supplies its own activity; navigating away clears that conversation's observation. The sidebar and panel may explicitly show working or approval from their existing owner-scoped activity data; an idle home does not erase an outstanding side-chat approval. Their tooltips describe the bot, while the direct chat's live status says "in this chat". Other unobserved bots show decorative idle motion without a status claim. Group replies use the persisted speaker bot ID, never a name, avatar string or globally selected bot. Only the current speaker can show working, approval or failure; historical speaker markers are decorative. Group members and mentions use each bot's resolved default or personal appearance. Missing legacy speaker IDs and unauthenticated/shared views fall back to the shared icon. App-only chats have no pet activity observer. The feature does not poll background routines, inspect desktop agents, claim upstream connectivity, or infer activity from elapsed time. Existing bot activity panels continue to serve their own purpose.

## Import contract

Choose the files explicitly in the dialog. No URL, package installation, archive extraction, script execution, or automatic gallery access is involved. One import is retained per user/bot; replacing/removing it replaces/removes the stored raster atomically. Disabling the avatar retains the import.

Supported `pet.json` example:

```json
{
  "id": "my-original-pet",
  "displayName": "My original pet",
  "description": "An original companion",
  "spritesheetPath": "spritesheet.png",
  "spriteVersionNumber": 2
}
```

- JSON file named `pet.json`, at most 16 KiB. `displayName` is required (1–80 characters); `description` is optional (up to 1,000 characters). Text control characters are rejected.
- `spritesheetPath` must be exactly `spritesheet.png` or `spritesheet.webp`, matching the chosen file. It is a filename check, never a filesystem/URL lookup.
- New imports must explicitly set `spriteVersionNumber: 2` and use exactly 1536 × 2288 pixels: eight columns and eleven rows of 192 × 208 cells. Existing v1 pets keep their stored bytes and remain usable; the builder does not fabricate missing look directions or upgrade v1 by padding.
- Only static PNG or WebP files, at most 4 MiB before and after normalization. Animation containers (APNG/animated WebP), damaged files, SVG, HTML, and other image formats are rejected. A ZIP may contain exactly `pet.json` and its matching sprite at the root. Only stored or deflated, non-streaming entries are supported; paths, extra files, links, encryption, ZIP64 and duplicate entries are rejected. Actual archive and inflated sizes are bounded, CRCs are checked, and nothing is extracted to disk.
- Optional `frameWidth`, `frameHeight`, and `columns` must match 192, 208 and 8. `states` and `animations` maps are rejected: custom layouts are not supported. Other metadata is discarded rather than interpreted. Gallery-wide API manifests are not individual pet manifests.
- The chat renderer uses canonical idle (row 0, six frames), working (row 7, six frames), waiting (row 6, six frames), and attention (row 5, still first frame). The sign-in companion alone also plays waving (row 3, four frames) when clicked. The builder inspector additionally exposes all nine animation states (with canonical per-frame durations and manual frame stepping) and all sixteen clockwise look directions, starting up at 0°. Light and dark previews use actual avatar slot sizes from 20 through 112 px with the same 192/208 fit as `BotAvatar`. Playback respects reduced motion and hidden pages. This does not add roaming, pointer-following, sound, scripts or custom timing to chat avatars.
- The user confirms permission to use the art and can retain up to 240 characters of artist/license credit, displayed in the import panel. Text is rendered through React, never as HTML. This confirmation does not grant rights; users must follow the asset's actual terms.


### Native v2 builder (Phase 1)

**Import your own pet** and **Admin → Pets** now validate before saving. Validation has no database writes. It checks canonical dimensions, static image encoding, nonempty required cells and fully transparent unused cells. Every row and direction can then be inspected; the user confirms visual review before saving. Structural validation cannot determine gaze semantics, identity consistency or pleasing motion, so visual review remains necessary. Export produces a canonical `codex-pet-v2.zip` with normalized PNG bytes, v2 manifest and attribution; importing that ZIP follows the same checks. Saved private imports and catalog cards also offer inspection and export. Private export reads stay scoped to the authenticated owner and requested revision; catalog reads retain publication/admin checks.

Cancel discards unsaved data and aborts validation; stale responses cannot reopen the preview. Save revalidates the exact reviewed normalized bytes and rechecks existing storage permissions. Failed requests retain the draft for retry. A save already sent may finish if the view closes; reopen settings to reconcile. Copying a private import to the catalog requires a v2 sheet that passes the same cell checks. A v1 catalog pet can be published only if it was published before (a `pet.catalog_published` audit entry, or a legacy `builtin-*` pet), so existing pets can be unpublished and restored; a never-published v1 draft is refused with 409. Shared-bot private imports remain disallowed, admin publication stays explicit, and selection in the bot creation picker continues to update the header immediately.

### AI creation (Phase 2, not implemented)

The app currently resolves chat and embedding providers only; `src/lib/llm/index.ts` rejects implicit image-model calls. No image-generation provider, image usage/pricing ledger, or generation job workflow exists. The builder clearly states that description/reference generation is unavailable and makes no generation calls.

Before implementing Phase 2, choose a supported image provider/model, its user/admin credential and billing ownership, pricing estimate and explicit cost-consent policy, and where reference images and generation jobs are retained. The intended flow remains reference/description → approved appearance → per-state generation/retries → the same v2 validation and review. Approval, paid generation, and per-state retries are intentionally not represented as completed acceptance criteria for issue #5.

## Storage and access

Migration `0012_bot_pets` created private `(user_id, bot_id)` rows with one bounded raster. `0016_shared_pet_catalog`, following `0015_native_service_bots`, adds `pet_catalog`, `bot_pet_defaults`, and explicit preference mode/catalog reference fields. Absence now means Follow; enabled legacy rows become Personal. The old UI also persisted disabled rows when someone changed appearance/motion or imported artwork without enabling it. The boolean cannot distinguish those actions from an intentional opt-out; a saved row is not evidence of a deliberate Off choice.

`0016` remains unchanged for installations that already applied it. The versioned `0017_pet_legacy_inheritance` repair changes only `mode` from Off to Follow for rows with `enabled=false` and no catalog reference. It preserves all private bytes, credits, revisions, selected appearance and motion, and all enabled Personal choices. Catalog-based Off is preserved because catalog selection proves the row used the new explicit preference model. No assets are published. Fresh upgrades apply 0014 → 0015 → 0016 → 0017 in sequence; existing 0016 installations apply only 0017 through the normal migration runner, without a schema reset or manual journal changes.

This is an explicit policy tradeoff: deliberate legacy Off and legacy-shaped Off choices saved after 0016 are also indistinguishable and may become Follow. Tell affected users they can reselect **Off · original icon** after upgrading. That choice survives subsequent migration runs; 0017 is recorded once, not reapplied on startup. Without a shared default, Follow still shows the original icon. The old enabled column remains for rollback compatibility but effective rendering derives from mode and authorized sources. Rollback should retain additive tables/columns and migration history; old code cannot render catalog/default choices.

`/api/bots/[id]/pet` remains the private preference/import route; `/pet/sprite` always returns only the caller's own import, including for admins. `/pet/avatar?v=revision` returns the current authorized effective raster, rechecking bot visibility and catalog publication. `/api/pets/catalog` lists only published metadata; catalog sprite reads require a session and published status (admins can preview drafts). All pet asset and catalog metadata responses are private/no-store. Revision parameters select validated stored bytes, never files or remote URLs.

Admin endpoints authorize before body decoding, check same-origin mutations, validate bounded requests, and record safe audit entries for draft creation, publishing/unpublishing, deletion and bot default assignments. Sharing affirmation comes from the submitted checkbox; the server rejects a missing affirmation for drafts/copies/publication. Its audit record includes the actor, timestamp, affirmation version, audience and asset revision. This records the administrator's assertion, not proof of legal rights. Unpublishing does not claim a new affirmation. Default writes acquire `lockEditableBot`, then load one fresh principal in that transaction and enforce editing and pet-identity policies, including group/session revocation. Shared caller defaults are owner/admin controlled; service defaults always require an admin. Cosmetic defaults live outside service capability configuration: changing one never changes a bot revision, publication hash, or MCP grant. Ordinary users retain personal identity choices only for private caller bots. The account and bot are always derived from authenticated scope; no personal endpoint accepts a user ID.

The chat layout reuses its already-authorized bot list. Effective image reads use one byte lookup after the existing bot-access check (two queries for caller-mode bots, plus authentication; service-bot capability checks remain intact). Overlapping focus/visibility/poll refreshes are coalesced. Images remain `private, no-store` with `Vary: Cookie`; revision URLs alone do not make cached private assets safe across account changes or revocation.

## Sign-in companion

Admins choose the companion at the center of the public sign-in page in **Settings → Branding**: the portal bot (default), Moss, Ember, or a published catalog pet. Visitors can click it to say hello (a hop, the waving row and a short greeting). It follows the sign-in form: working while a sign-in is pending, attention after an error. All of this is cosmetic, and reduced motion keeps it still.

Catalog publication only covers signed-in users, so choosing a catalog pet here needs its own confirmation that the art and credit may be shown to anyone who opens the sign-in page. The `loginPet` setting pins the confirmed revision, and the audit entry `settings.login_pet` records the revision, the confirmation and the audience. The only public pet bytes are served by `/api/branding/login-pet`, which returns the pinned revision while it is still published and 404 otherwise. The page then falls back to the portal bot. Unpublishing a pet therefore removes it from the sign-in page at once, and republishing it restores the selection. The pet's display name and credit appear on the sign-in page.

## Source and license research

Research checked 2026-10-01/02; public-source snapshots are pinned below. No gallery asset was downloaded, copied or bundled, and no upstream installer/script was executed.

- [Petdex's builder/package documentation and licensing statement](https://github.com/crafter-station/petdex/blob/7e327034c27098bb7b701b834e34af81c2cfbdba/README.md) describes `pet.json` plus PNG/WebP, 8×9 and v2 8×11 grids, nine state rows, and an HTTP gallery manifest. Its source is MIT, but artwork belongs to submitters under their own declared licenses. The [front page](https://petdex.dev/) also identifies submissions as fan art without claiming underlying IP rights. The [state definitions](https://github.com/crafter-station/petdex/blob/7e327034c27098bb7b701b834e34af81c2cfbdba/src/lib/pet-states.ts) provide the canonical frame counts. Public API metadata is not a redistribution license.
- [Codex Pet Share's README](https://github.com/portons/codex-pet-share/blob/27996cafa42119c86db5472af852a3ef185723f4/README.md) documents the same v1/v2 dimensions and v2 look cells. Its [minimal fixture manifest](https://github.com/portons/codex-pet-share/blob/27996cafa42119c86db5472af852a3ef185723f4/test-assets/pets/debug-duck-v1/pet.json) uses `displayName`, `description`, `spritesheetPath`, `id`, and `kind`. [The source license](https://github.com/portons/codex-pet-share/blob/27996cafa42119c86db5472af852a3ef185723f4/LICENSE) is MIT. A community index [links this project to codex-pets.net](https://github.com/alterhq/awesome-codex-pets-projects). The named site's JS front page exposed no readable documentation here, and direct shell access was blocked (403), so its current live implementation and individual gallery reuse terms were not independently verified. No gallery-wide asset license is assumed.
- CollectiveUI contains `AGENTS.md`/`CLAUDE.md` but no repository `.agents/skills` directory at the base commit. The upstream `petshare-setup` skill was inspected for applicability; it targets deploying/forking that gallery and was not applied to this existing Next.js app. Bundled Next.js client/route documentation was read before implementation.

The built-in SVG artwork and CSS were authored for this feature, inspected in the running app, and carry CollectiveUI's existing [MIT license](../../LICENSE). No upstream renderer or artwork is embedded. Sprite-grid compatibility is implemented locally from the documented data format.

## Shared identity and builder controls

Private caller bots retain **My avatar preference**: Follow, Personal, and Off. Making a bot shared immediately ignores every saved personal identity, including Off, in both metadata and image serving. The stored private rows and bytes remain private and untouched. Returning a caller bot to private restores those choices. Shared settings never copy an import into the catalog; admins can explicitly copy only their own selected saved import into a reviewable draft. This saved import may differ from the displayed shared pet.

**New bot → Configure → Pet avatar** previews built-ins and published artwork before a bot exists. Creation saves the bot and selected pet in one transaction; an unpublished/missing selection rolls back the entire creation. Private caller selections become personal preferences; shared/service selections become shared defaults. **Edit bot → Pet avatar** uses separate cosmetic controls, so saving a pet does not increment service configuration revisions or revoke grants. Save visibility changes first to use the policy for the new audience.

Default mutations authorize the current owner/admin against a freshly loaded principal and locked bot row. Personal writes and animation updates take the same bot lock as visibility changes and recheck current access. `/pet/motion` accepts only animation settings; shared identity requests to personal PATCH/POST/DELETE are rejected. Migration 0017 is unchanged and no new migration is required.

## Verification

Run `npm test`, `npm run typecheck`, `npm run lint` and `npm run build`.
Pet integration tests require a migrated disposable PostgreSQL database; use the exact database names required by guarded suites. The catalog browser suite uses `PET_CATALOG_BROWSER=1` and `tests/pet-catalog.playwright.config.ts`, with a local app, synthetic accounts and the disposable `collective_pets_test` database. It generates its own artwork and covers upload, publication, private imports, identity transitions, access revocation, keyboard/mobile controls, motion and image failure recovery.

The header suite uses `CHAT_HEADER_BROWSER=1` and `tests/chat-header.playwright.config.ts` with the disposable `collective_header_test` database and local mock provider. Its catalog artwork is generated by the fixture. Existing migration tests verify that private bytes, catalog status and saved preferences survive upgrades.
